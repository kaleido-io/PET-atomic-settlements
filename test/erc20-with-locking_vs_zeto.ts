// Copyright © 2025 Kaleido, Inc.
//
// SPDX-License-Identifier: Apache-2.0
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { ContractTransactionReceipt, parseEther, ZeroHash } from "ethers";
import { ethers, network } from "hardhat";
import { expect } from "chai";
import { Merkletree, InMemoryDB, str2Bytes } from "@iden3/js-merkletree";
import { loadCircuit } from "zeto-js";
import { randomBytes } from "crypto";
import { Logger, ILogObj } from "tslog";
const logLevel = process.env.LOG_LEVEL || "3";
const logger: Logger<ILogObj> = new Logger({ name: "e2e-erc20", minLevel: parseInt(logLevel) });

process.env.SKIP_ANON_TESTS = "true";
process.env.SKIP_ANON_NULLIFIER_TESTS = "true";
import { prepareProof, encodeToBytes } from "zeto-solidity/test/zeto_anon_nullifier";
import { prepareProof as prepareProofLocked, encodeToBytes as encodeToBytesLocked } from "zeto-solidity/test/zeto_anon";
import {
  UTXO,
  User,
  newUser,
  newUTXO,
  newNullifier,
  doMint,
  ZERO_UTXO,
} from "zeto-solidity/test/lib/utils";
import { deployZeto } from "zeto-solidity/test/lib/deploy";
import { loadProvingKeys, calculateSpendHash } from "zeto-solidity/test/utils";
import { parseLockEvents } from "./lib/utils";
import {
  randomTxId,
  encodeZetoCreateLockArgs,
  encodeZetoUpdateLockArgs,
  encodeZetoDelegateLockArgs,
  encodeZetoSpendLockArgs,
  encodePlainErc20CreateLockArgs,
  readLockIdFromZetoLockCreated,
  readSpentUtxoOutputs,
  readZetoLockCancelledOutputs,
} from "./lib/zetoLockableE2E";

describe("DvP flows: Zeto UTXO and cleartext ERC20Lockable (ILockableERC20)", function () {
  let Deployer: User;
  let Alice: User;
  let Bob: User;

  let zkUTXO: any;
  let erc20Lockable: any;
  let atomFactory: any;

  let smtAlice: Merkletree;

  let circuit: any;
  let circuitForLocked: any;
  let provingKey: string;
  let provingKeyForLocked: string;

  before(async function () {
    if (network.name !== "hardhat") {
      this.timeout(120000);
    }
    const [deployer, a, b] = await ethers.getSigners();
    Deployer = await newUser(deployer);
    Alice = await newUser(a);
    Bob = await newUser(b);

    const storage1 = new InMemoryDB(str2Bytes(""));
    smtAlice = new Merkletree(storage1, true, 64);

    ({ zeto: zkUTXO } = await deployZeto("Zeto_AnonNullifier"));
    logger.debug(`ZK zeto at ${zkUTXO.target}`);

    circuit = await loadCircuit("anon_nullifier_transfer");
    ({ provingKeyFile: provingKey } = loadProvingKeys("anon_nullifier_transfer"));
    circuitForLocked = await loadCircuit("anon");
    ({ provingKeyFile: provingKeyForLocked } = loadProvingKeys("anon"));

    const factory = await ethers.getContractFactory("ERC20Lockable");
    erc20Lockable = await factory.connect(Deployer.signer).deploy();
    logger.debug(`ERC20Lockable at ${erc20Lockable.target}`);

    const afFactory = await ethers.getContractFactory("AtomFactory");
    atomFactory = await afFactory.connect(Alice.signer).deploy();
  });

  describe("Successful end to end: Alice (Zeto) and Bob (ERC20Lockable)", function () {
    let payment1: UTXO;
    let lockedUtxo: UTXO;
    let lockIdAlice: string;
    let lockIdBob: string;
    let atomInstance: any;

    const MINT_BOB = parseEther("1000");
    const LOCK = parseEther("50");

    it("mints UTXO to Alice", async function () {
      payment1 = newUTXO(100, Alice);
      const result = await doMint(zkUTXO, Deployer.signer, [payment1]);
      for (const log of result.logs) {
        const event = zkUTXO.interface.parseLog(log as any);
        expect(event.args.outputs.length).to.equal(1);
        await smtAlice.add(event.args.outputs[0], event.args.outputs[0]);
      }
      const root = await smtAlice.root();
      expect(root.string()).to.equal((await zkUTXO.getRoot()).toString());
    });

    it("mints ERC20 to Bob", async function () {
      const tx = await erc20Lockable.connect(Deployer.signer).mint(Bob.ethAddress, MINT_BOB);
      await tx.wait();
      expect(await erc20Lockable.balanceOf(Bob.ethAddress)).to.equal(MINT_BOB);
    });

    describe("Trade proposal setup", function () {
      let saltForProposedPaymentForBob: bigint;
      let lockErc20State: any;
      let paymentForBob: UTXO;
      let changeForAlice: UTXO;

      it("Alice creates a UTXO createLock for the trade", async function () {
        const nullifier1 = newNullifier(payment1, Alice);
        lockedUtxo = newUTXO(payment1.value!, Alice);
        const root = await smtAlice.root();
        const proof1 = await smtAlice.generateCircomVerifierProof(payment1.hash, root);
        const proof2 = await smtAlice.generateCircomVerifierProof(0n, root);
        const merkleProofs = [proof1.siblings.map((s) => s.bigInt()), proof2.siblings.map((s) => s.bigInt())];
        const encodedProof = await prepareProof(
          circuit,
          provingKey,
          Alice,
          [payment1, ZERO_UTXO],
          [nullifier1, ZERO_UTXO],
          [lockedUtxo, ZERO_UTXO],
          root.bigInt(),
          merkleProofs,
          [Alice, Alice],
        );
        const createTxId = randomTxId();
        const createArgs = encodeZetoCreateLockArgs({
          txId: createTxId,
          inputs: [nullifier1.hash],
          outputs: [],
          lockedOutputs: [lockedUtxo.hash],
          proof: encodeToBytes(root.bigInt(), encodedProof),
        });
        const predicted = await zkUTXO.connect(Alice.signer).computeLockId(createArgs);
        const tx = await zkUTXO.connect(Alice.signer).createLock(createArgs, ZeroHash, ZeroHash, "0x");
        const result = (await tx.wait())!;
        lockIdAlice = readLockIdFromZetoLockCreated(zkUTXO, result);
        expect(lockIdAlice).to.equal(predicted);
      });

      it("Alice updateLock sets spend commitment", async function () {
        paymentForBob = newUTXO(75, Bob);
        saltForProposedPaymentForBob = paymentForBob.salt! as bigint;
        changeForAlice = newUTXO(25, Alice);
        const spendH = calculateSpendHash([lockedUtxo], [], [paymentForBob, changeForAlice], "0x");
        const t2 = await zkUTXO
          .connect(Alice.signer)
          .updateLock(
            lockIdAlice,
            encodeZetoUpdateLockArgs(randomTxId()),
            spendH,
            ZeroHash,
            "0x",
          );
        await t2.wait();
        const g = await zkUTXO.getLock(lockIdAlice);
        expect(g.spendCommitment).to.equal(spendH);
        expect(g.cancelCommitment).to.equal(ZeroHash);
      });

      it("Bob verifies the spend commitment off-chain", async function () {
        const expectedUtxoForBob = newUTXO(75, Bob, saltForProposedPaymentForBob);
        const expectedSpend = calculateSpendHash(
          [lockedUtxo],
          [],
          [expectedUtxoForBob, changeForAlice],
          "0x",
        );
        const g = await zkUTXO.getLock(lockIdAlice);
        expect(g.spendCommitment).to.equal(expectedSpend);
      });

      it("Bob createLock: 50 ERC-20 to Alice (receiver)", async function () {
        const create = encodePlainErc20CreateLockArgs({
          txId: randomTxId(),
          receiver: Alice.ethAddress,
          amount: LOCK,
        });
        const predicted = await erc20Lockable.connect(Bob.signer).computeLockId(create);
        const t1 = await erc20Lockable.connect(Bob.signer).createLock(create, ZeroHash, ZeroHash, "0x");
        const result = (await t1.wait())!;
        lockIdBob = predicted;
        const created = result.logs
          .map((l) => {
            try {
              return erc20Lockable.interface.parseLog(l as any);
            } catch {
              return null;
            }
          })
          .find((e) => e && e.name === "LockCreated");
        const state = result.logs
          .map((l) => {
            try {
              return erc20Lockable.interface.parseLog(l as any);
            } catch {
              return null;
            }
          })
          .find((e) => e && e.name === "Erc20LockState");
        expect(created, "LockCreated not found").to.be.ok;
        expect(created!.args.lockId).to.equal(lockIdBob);
        expect(state, "Erc20LockState not found").to.be.ok;
        lockErc20State = state;
        expect(await erc20Lockable.balanceOf(Bob.ethAddress)).to.equal(MINT_BOB - LOCK);
      });

      it("Alice checks Erc20LockState and getLock", async function () {
        expect(lockErc20State?.args?.lockId).to.equal(lockIdBob);
        expect(lockErc20State.args.amount).to.equal(LOCK);
        const li = await erc20Lockable.getLock(lockIdBob);
        expect(li.owner).to.equal(Bob.ethAddress);
        expect(lockErc20State?.args?.receiver).to.equal(Alice.ethAddress);
      });

      it("create Atom (Zeto + ERC20 lock legs)", async function () {
        const encodedProofForSettle = await prepareProofLocked(
          circuitForLocked,
          provingKeyForLocked,
          Alice,
          [lockedUtxo, ZERO_UTXO],
          [paymentForBob, changeForAlice],
          [Bob, Alice],
        );
        const zetoSpend = encodeZetoSpendLockArgs({
          txId: randomTxId(),
          lockedOutputs: [],
          outputs: [paymentForBob.hash, changeForAlice.hash],
          proof: encodeToBytesLocked(encodedProofForSettle),
          data: "0x",
        });
        const tx = await atomFactory
          .connect(Alice.signer)
          .create([
            { lockableContract: zkUTXO, approver: Alice.ethAddress, lockId: lockIdAlice, spendArgs: zetoSpend },
            { lockableContract: erc20Lockable, approver: Bob.ethAddress, lockId: lockIdBob, spendArgs: "0x" },
          ]);
        const result = (await tx.wait()) as ContractTransactionReceipt;
        const atomDeployedEvent = parseLockEvents(atomFactory, result)[0];
        atomInstance = await ethers.getContractAt("Atom", atomDeployedEvent?.atomInstance);
      });
    });

    describe("Trade approvals", function () {
      it("Bob delegates his ERC-20 lock to the Atom", async function () {
        const tx = await erc20Lockable
          .connect(Bob.signer)
          .delegateLock(lockIdBob, encodeZetoDelegateLockArgs(randomTxId()), atomInstance.target, "0x");
        await tx.wait();
      });
      it("Alice delegates her UTXO lock to the Atom", async function () {
        const tx = await zkUTXO
          .connect(Alice.signer)
          .delegateLock(lockIdAlice, encodeZetoDelegateLockArgs(randomTxId()), atomInstance.target, "0x");
        await tx.wait();
      });
    });

    describe("Trade execution", function () {
      let settleTxResult: ContractTransactionReceipt;

      it("settle: randomly Alice or Bob calls Atom.settle", async function () {
        expect(await erc20Lockable.balanceOf(Alice.ethAddress)).to.equal(0n);
        expect(await erc20Lockable.balanceOf(Bob.ethAddress)).to.equal(MINT_BOB - LOCK);

        if (Math.random() < 0.5) {
          settleTxResult = (await (await atomInstance.connect(Alice.signer).settle()).wait())!;
        } else {
          settleTxResult = (await (await atomInstance.connect(Bob.signer).settle()).wait())!;
        }

        const events = parseLockEvents(atomInstance, settleTxResult!);
        expect(events[0]?.lockId).to.equal(lockIdAlice);
        expect(events[1]?.lockId).to.equal(lockIdBob);

        expect(await erc20Lockable.balanceOf(Alice.ethAddress)).to.equal(LOCK);
        expect(await erc20Lockable.balanceOf(Bob.ethAddress)).to.equal(MINT_BOB - LOCK);
      });

      it("Alice extends her SMT with trade outputs", async function () {
        const outHashes = readSpentUtxoOutputs(zkUTXO, settleTxResult, lockIdAlice);
        expect(outHashes.length).to.be.greaterThan(0);
        for (const h of outHashes) {
          await smtAlice.add(h, h);
        }
      });
    });
  });

  describe("Failed setup: no Bob ERC-20 lock", function () {
    let payment1: UTXO;
    let lockedUtxo: UTXO;
    let lockIdAlice: string;
    let refundForAlice: UTXO;

    it("mints UTXO to Alice", async function () {
      payment1 = newUTXO(100, Alice);
      const result = await doMint(zkUTXO, Deployer.signer, [payment1]);
      for (const log of result.logs) {
        const event = zkUTXO.interface.parseLog(log as any);
        await smtAlice.add(event.args.outputs[0], event.args.outputs[0]);
      }
    });

    describe("Trade setup by Alice", function () {
      it("Alice createLock", async function () {
        const nullifier1 = newNullifier(payment1, Alice);
        lockedUtxo = newUTXO(payment1.value!, Alice);
        const root = await smtAlice.root();
        const proof1 = await smtAlice.generateCircomVerifierProof(payment1.hash, root);
        const proof2 = await smtAlice.generateCircomVerifierProof(0n, root);
        const merkleProofs = [proof1.siblings.map((s) => s.bigInt()), proof2.siblings.map((s) => s.bigInt())];
        const encodedProof = await prepareProof(
          circuit,
          provingKey,
          Alice,
          [payment1, ZERO_UTXO],
          [nullifier1, ZERO_UTXO],
          [lockedUtxo, ZERO_UTXO],
          root.bigInt(),
          merkleProofs,
          [Alice, Alice],
        );
        const cArgs = encodeZetoCreateLockArgs({
          txId: randomTxId(),
          inputs: [nullifier1.hash],
          outputs: [],
          lockedOutputs: [lockedUtxo.hash],
          proof: encodeToBytes(root.bigInt(), encodedProof),
        });
        const w = await (await zkUTXO.connect(Alice.signer).createLock(cArgs, ZeroHash, ZeroHash, "0x")).wait();
        lockIdAlice = readLockIdFromZetoLockCreated(zkUTXO, w!);
      });

      it("Bob does not add an on-chain ERC-20 lock", function () {
        // intentional no-op
      });
    });

    describe("Trade cancellation by Alice (Zeto cancelLock)", function () {
      let cancelTxResult: ContractTransactionReceipt;

      it("Alice cancelLock refunds UTXO", async function () {
        refundForAlice = newUTXO(lockedUtxo.value!, Alice);
        const encodedProofForRollback = await prepareProofLocked(
          circuitForLocked,
          provingKeyForLocked,
          Alice,
          [lockedUtxo, ZERO_UTXO],
          [refundForAlice, ZERO_UTXO],
          [Alice, Alice],
        );
        const cancelArgs = encodeZetoSpendLockArgs({
          txId: randomTxId(),
          lockedOutputs: [],
          outputs: [refundForAlice.hash, ZERO_UTXO.hash],
          proof: encodeToBytesLocked(encodedProofForRollback),
          data: "0x",
        });
        const tx = await zkUTXO.connect(Alice.signer).cancelLock(lockIdAlice, cancelArgs, "0x");
        cancelTxResult = (await tx.wait())!;
      });

      it("verifies ZetoLockCancelled outputs", async function () {
        const outs = readZetoLockCancelledOutputs(zkUTXO, cancelTxResult);
        expect(BigInt(outs[0])).to.equal(refundForAlice.hash);
        await smtAlice.add(refundForAlice.hash, refundForAlice.hash);
      });
    });
  });

  describe("Failed settle then cancel via Atom", function () {
    let payment1: UTXO;
    let lockedUtxo: UTXO;
    let lockIdAlice: string;
    const lockIdBob = ("0x" + randomBytes(32).toString("hex")) as `0x${string}`;
    let atomInstance: any;

    before(async function () {
      const af = await ethers.getContractFactory("AtomFactory");
      atomFactory = await af.connect(Alice.signer).deploy();
    });

    it("mints UTXO to Alice", async function () {
      payment1 = newUTXO(100, Alice);
      const result = await doMint(zkUTXO, Deployer.signer, [payment1]);
      for (const log of result.logs) {
        const event = zkUTXO.interface.parseLog(log as any);
        await smtAlice.add(event.args.outputs[0], event.args.outputs[0]);
      }
    });

    describe("Setup: no matching Bob on-chain lock", function () {
      it("Alice createLock", async function () {
        const nullifier1 = newNullifier(payment1, Alice);
        lockedUtxo = newUTXO(payment1.value!, Alice);
        const root = await smtAlice.root();
        const proof1 = await smtAlice.generateCircomVerifierProof(payment1.hash, root);
        const proof2 = await smtAlice.generateCircomVerifierProof(0n, root);
        const merkleProofs = [proof1.siblings.map((s) => s.bigInt()), proof2.siblings.map((s) => s.bigInt())];
        const encodedProof = await prepareProof(
          circuit,
          provingKey,
          Alice,
          [payment1, ZERO_UTXO],
          [nullifier1, ZERO_UTXO],
          [lockedUtxo, ZERO_UTXO],
          root.bigInt(),
          merkleProofs,
          [Alice, Alice],
        );
        const cArgs = encodeZetoCreateLockArgs({
          txId: randomTxId(),
          inputs: [nullifier1.hash],
          outputs: [],
          lockedOutputs: [lockedUtxo.hash],
          proof: encodeToBytes(root.bigInt(), encodedProof),
        });
        const w = await (await zkUTXO.connect(Alice.signer).createLock(cArgs, ZeroHash, ZeroHash, "0x")).wait();
        lockIdAlice = readLockIdFromZetoLockCreated(zkUTXO, w!);
      });

      it("initialize Atom with placeholder spendArgs and fake Bob lockId", async function () {
        const zetoSpendPlaceholder = encodeZetoSpendLockArgs({
          txId: randomTxId(),
          lockedOutputs: [],
          outputs: [],
          proof: "0x",
          data: "0x",
        });
        const tx = await atomFactory
          .connect(Alice.signer)
          .create([
            { lockableContract: zkUTXO, approver: Alice.ethAddress, lockId: lockIdAlice, spendArgs: zetoSpendPlaceholder },
            { lockableContract: erc20Lockable, approver: Bob.ethAddress, lockId: lockIdBob, spendArgs: "0x" },
          ]);
        const r = (await tx.wait())!;
        atomInstance = await ethers.getContractAt("Atom", parseLockEvents(atomFactory, r)[0]!.atomInstance);
      });

      it("Alice delegates to Atom", async function () {
        const tx = await zkUTXO
          .connect(Alice.signer)
          .delegateLock(
            lockIdAlice,
            encodeZetoDelegateLockArgs(randomTxId()),
            atomInstance.target,
            "0x",
          );
        await tx.wait();
      });

      it("settle reverts (Bob lock not active)", async function () {
        await expect(atomInstance.connect(Alice.signer).settle()).to.be.reverted;
      });
    });

    describe("Alice cancels through Atom", function () {
      let cancelTxResult: ContractTransactionReceipt;

      it("cancel", async function () {
        const refundForAlice = newUTXO(lockedUtxo.value!, Alice);
        const encodedProofForRollback = await prepareProofLocked(
          circuitForLocked,
          provingKeyForLocked,
          Alice,
          [lockedUtxo, ZERO_UTXO],
          [refundForAlice, ZERO_UTXO],
          [Alice, Alice],
        );
        const cancelArgs = encodeZetoSpendLockArgs({
          txId: randomTxId(),
          lockedOutputs: [],
          outputs: [refundForAlice.hash, ZERO_UTXO.hash],
          proof: encodeToBytesLocked(encodedProofForRollback),
          data: "0x",
        });
        const tx = await atomInstance.connect(Alice.signer).cancel(lockIdAlice, cancelArgs);
        cancelTxResult = (await tx.wait())!;
      });

      it("verifies OperationRolledBack for Alice leg", async function () {
        const rolled = parseLockEvents(atomInstance, cancelTxResult!)[0];
        expect(rolled).to.not.be.null;
        expect(rolled?.operationIndex).to.equal(0);
        expect(rolled?.lockId).to.equal(lockIdAlice);
      });
    });
  });
}).timeout(600000);
