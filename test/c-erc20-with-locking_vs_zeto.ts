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

import { ethers, fhevm, network } from "hardhat";
import { FhevmType } from '@fhevm/hardhat-plugin';
import { ContractTransactionReceipt, ZeroHash } from "ethers";
import { expect } from "chai";
import { Merkletree, InMemoryDB, str2Bytes } from "@iden3/js-merkletree";
import { loadCircuit } from "zeto-js";
import { randomBytes } from "crypto";
import { Logger, ILogObj } from "tslog";
const logLevel = process.env.LOG_LEVEL || "3";
export const logger: Logger<ILogObj> = new Logger({ name: "e2e", minLevel: parseInt(logLevel) });

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
  encodeErc20CreateLockArgs,
  readLockIdFromZetoLockCreated,
  readSpentUtxoOutputs,
  readZetoLockCancelledOutputs,
} from "./lib/zetoLockableE2E";

describe("DvP flows between privacy tokens implementing the locking interface", function () {
  // users interacting with each other in the DvP transactions
  let Deployer: User; // the minter of the FHE ERC20 tokens and Zeto tokens
  let Alice: User; // the user who holds the Zeto tokens
  let Bob: User; // the user who holds the FHE ERC20 tokens

  // instances of the contracts
  let zkUTXO: any;
  let confidentialERC20: any;
  let atomFactory: any;

  // other variables
  let smtAlice: Merkletree;

  let circuit: any;
  let circuitForLocked: any;
  let provingKey: string;
  let provingKeyForLocked: string;

  before(async function () {
    if (network.name !== "hardhat") {
      // accommodate for longer block times on public networks
      this.timeout(120000);
    }
    let [deployer, a, b] = await ethers.getSigners();
    Deployer = await newUser(deployer);
    Alice = await newUser(a);
    Bob = await newUser(b);

    const storage1 = new InMemoryDB(str2Bytes(""));
    smtAlice = new Merkletree(storage1, true, 64);

    // deploy the Zeto contract for the Zeto tokens
    ({ zeto: zkUTXO } = await deployZeto("Zeto_AnonNullifier"));
    logger.debug(`ZK Payment contract deployed at ${zkUTXO.target}`);

    // load the circuits for the Zeto tokens
    circuit = await loadCircuit("anon_nullifier_transfer");
    ({ provingKeyFile: provingKey } = loadProvingKeys(
      "anon_nullifier_transfer",
    ));
    circuitForLocked = await loadCircuit("anon");
    ({ provingKeyFile: provingKeyForLocked } = loadProvingKeys(
      "anon",
    ));

    // deploy the FHE ERC20 contract for the FHE ERC20 tokens
    const factory = await ethers.getContractFactory("FheERC20Lockable");
    confidentialERC20 = await factory.connect(Deployer.signer).deploy();
    logger.debug(`FHE ERC20 Lockable contract deployed at ${confidentialERC20.target}`);

    const afFactory = await ethers.getContractFactory("AtomFactory");
    atomFactory = await afFactory.connect(Alice.signer).deploy();
    logger.debug("AtomFactory contract instance deployed at", atomFactory.target);
  });

  describe("Successful end to end trade flow between Alice (using \"Confidential UTXO\" tokens) and Bob (using \"Lockable Confidential ERC20\" tokens)", function () {
    // Alice's payment UTXOs to be minted and transferred
    let payment1: UTXO;

    let lockedUtxo: UTXO;
    let lockIdAlice: string;
    let lockIdBob: string;

    let atomInstance: any;

    it("mint to Alice some \"Confidential UTXO\" tokens", async function () {
      payment1 = newUTXO(100, Alice);
      const result = await doMint(zkUTXO, Deployer.signer, [payment1]);

      // simulate Alice listening to minting events and updating her local merkle tree
      for (const log of result.logs) {
        const event = zkUTXO.interface.parseLog(log as any);
        expect(event.args.outputs.length).to.equal(1);
        const utxos = event.args.outputs;
        await smtAlice.add(utxos[0], utxos[0]);
      }

      let root = await smtAlice.root();
      let onchainRoot = await zkUTXO.getRoot();
      expect(root.string()).to.equal(onchainRoot.toString());
    });

    it("mint to Bob some \"Lockable Confidential ERC20\" tokens", async function () {
      const encryptedInput = await fhevm
        .createEncryptedInput(confidentialERC20.target, Deployer.ethAddress)
        .add64(1000)
        .encrypt();

      const tx = await confidentialERC20.connect(Deployer.signer).mint(Bob.ethAddress, encryptedInput.handles[0], encryptedInput.inputProof);
      await tx.wait();

      // check the balance of Bob in the FHE ERC20 contract
      const balance = await confidentialERC20.confidentialBalanceOf(Bob.signer);
      await expect(
        fhevm.userDecryptEuint(FhevmType.euint64, balance, confidentialERC20.target, Bob.signer),
      ).to.eventually.equal(1000);
    });

    describe("Trade proposal setup by Alice and Bob", function () {
      let saltForProposedPaymentForBob: bigint;
      let lockERC20State: any;
      let paymentForBob: UTXO;
      let changeForAlice: UTXO;

      it("Alice creates a UTXO lock (ILockableCapability.createLock) for the trade with Bob", async function () {
        const nullifier1 = newNullifier(payment1, Alice);
        lockedUtxo = newUTXO(payment1.value!, Alice);
        const root = await smtAlice.root();
        const proof1 = await smtAlice.generateCircomVerifierProof(
          payment1.hash,
          root,
        );
        const proof2 = await smtAlice.generateCircomVerifierProof(0n, root);
        const merkleProofs = [
          proof1.siblings.map((s) => s.bigInt()),
          proof2.siblings.map((s) => s.bigInt()),
        ];
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
        const tx = await zkUTXO
          .connect(Alice.signer)
          .createLock(createArgs, ZeroHash, ZeroHash, "0x");
        const result: ContractTransactionReceipt | null = await tx.wait();
        lockIdAlice = readLockIdFromZetoLockCreated(zkUTXO, result!);
        expect(lockIdAlice).to.equal(predicted);
      });

      it("Alice updateLock sets the off-chain verifiable spend commitment (cancels not bound here)", async function () {
        paymentForBob = newUTXO(75, Bob);
        saltForProposedPaymentForBob = paymentForBob.salt! as bigint;
        changeForAlice = newUTXO(25, Alice);
        const spendH = calculateSpendHash(
          [lockedUtxo],
          [],
          [paymentForBob, changeForAlice],
          "0x",
        );
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

      it("Bob verifies the intended UTXO outputs with respect to the on-chain spend commitment", async function () {
        const expectedUTXOForProposedPaymentForBob: UTXO = newUTXO(75, Bob, saltForProposedPaymentForBob);
        const outputs: UTXO[] = [expectedUTXOForProposedPaymentForBob, changeForAlice];
        const expectedSpend = calculateSpendHash(
          [lockedUtxo],
          [],
          outputs,
          "0x",
        );
        const g = await zkUTXO.getLock(lockIdAlice);
        expect(g.spendCommitment).to.equal(expectedSpend);
      });

      it("Bob creates a lock (createLock) of 50 confidential ERC-20 units to Alice as receiver", async function () {
        const encryptedInput = await fhevm
          .createEncryptedInput(confidentialERC20.target, Bob.ethAddress)
          .add64(50)
          .encrypt();
        const fheTxId = randomTxId();
        const fheCreate = encodeErc20CreateLockArgs({
          txId: fheTxId,
          receiver: Alice.ethAddress,
          amount: encryptedInput.handles[0],
          amountProof: encryptedInput.inputProof,
        });
        const predicted = await confidentialERC20.connect(Bob.signer).computeLockId(fheCreate);
        const t1 = await confidentialERC20.connect(Bob.signer).createLock(fheCreate, ZeroHash, ZeroHash, "0x");
        const result: ContractTransactionReceipt | null = await t1.wait();
        lockIdBob = predicted;
        const created = result!.logs
          .map((l) => {
            try {
              return confidentialERC20.interface.parseLog(l as any);
            } catch {
              return null;
            }
          })
          .find((e) => e && e.name === "LockCreated");
        const state = result!.logs
          .map((l) => {
            try {
              return confidentialERC20.interface.parseLog(l as any);
            } catch {
              return null;
            }
          })
          .find((e) => e && e.name === "ConfidentialErc20LockState");
        expect(created, "LockCreated not found").to.be.ok;
        expect(created!.args.lockId).to.equal(lockIdBob);
        expect(state, "ConfidentialErc20LockState not found in transaction logs").to.be.ok;
        lockERC20State = state;
      });

      it("Alice verifies the trade setup by reading FHE lock state and {ConfidentialErc20LockState}", async function () {
        expect(lockERC20State?.args?.lockId).to.equal(lockIdBob);
        const lockedAmount = lockERC20State.args.amount;
        const decryptedLockedAmount = await fhevm.userDecryptEuint(
          FhevmType.euint64,
          lockedAmount,
          confidentialERC20.target,
          Alice.signer,
        );
        expect(decryptedLockedAmount).to.equal(50);
        const li = await confidentialERC20.getLock(lockIdBob);
        expect(li.owner).to.equal(Bob.ethAddress);
        expect(lockERC20State?.args?.receiver).to.equal(Alice.ethAddress);
      });

      it("Alice and Bob agree on an Atom instance and initialize the lock operations (spendArgs for Zeto spendLock)", async function () {
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
        const operationAlice = {
          lockableContract: zkUTXO,
          approver: Alice.ethAddress,
          lockId: lockIdAlice,
          spendArgs: zetoSpend,
        };
        const operationBob = {
          lockableContract: confidentialERC20,
          approver: Bob.ethAddress,
          lockId: lockIdBob,
          spendArgs: "0x",
        };
        const tx = await atomFactory.connect(Alice.signer).create([operationAlice, operationBob]);
        const result: ContractTransactionReceipt | null = await tx.wait();
        const atomDeployedEvent = parseLockEvents(atomFactory, result!)[0];
        const instance = atomDeployedEvent?.atomInstance;
        atomInstance = await ethers.getContractAt("Atom", instance);
        logger.debug("Atom contract instance deployed at", atomInstance.target);
      });
    });

    describe("Trade approvals", function () {
      it("Bob approves the trade by delegating the lock to the Atom contract (delegateLock)", async function () {
        const d = encodeZetoDelegateLockArgs(randomTxId());
        const tx = await confidentialERC20
          .connect(Bob.signer)
          .delegateLock(lockIdBob, d, atomInstance.target, "0x");
        await tx.wait();
      });
      it("Alice approves the trade by delegating the UTXO lock to the Atom contract (delegateLock)", async function () {
        const d = encodeZetoDelegateLockArgs(randomTxId());
        const tx = await zkUTXO
          .connect(Alice.signer)
          .delegateLock(lockIdAlice, d, atomInstance.target, "0x");
        await tx.wait();
      });
    });

    describe("Trade execution", function () {
      let settleTxResult: any;

      it("One of Alice or Bob executes the Atom contract to complete the trade", async function () {
        // check the balance of Alice. it should be 0
        const balanceAliceBefore = await confidentialERC20.confidentialBalanceOf(Alice.signer);
        expect(balanceAliceBefore).to.equal(ZeroHash);

        // check the balance of Bob. it should be 950 because Bob locked 50 of his FHE ERC20 tokens
        const balanceBobBefore = await confidentialERC20.confidentialBalanceOf(Bob.signer);
        await expect(
          fhevm.userDecryptEuint(FhevmType.euint64, balanceBobBefore, confidentialERC20.target, Bob.signer),
        ).to.eventually.equal(950);

        if (Math.random() < 0.5) {
          const tx = await atomInstance.connect(Alice.signer).settle();
          settleTxResult = await tx.wait();
        } else {
          const tx = await atomInstance.connect(Bob.signer).settle();
          settleTxResult = await tx.wait();
        }

        // verify the settle operation successfully executed by checking the events
        // emitted by the Atom contract
        const events = parseLockEvents(atomInstance, settleTxResult!);
        const settledEvent1 = events[0];
        expect(settledEvent1).to.not.be.null;
        expect(settledEvent1?.operationIndex).to.equal(0);
        expect(settledEvent1?.lockId).to.equal(lockIdAlice);
        expect(settledEvent1?.data).to.equal("0x");
        const settledEvent2 = events[1];
        expect(settledEvent2).to.not.be.null;
        expect(settledEvent2?.operationIndex).to.equal(1);
        expect(settledEvent2?.lockId).to.equal(lockIdBob);
        expect(settledEvent2?.data).to.equal("0x");

        // check the balance of Alice. it should be 50 because Alice received 50 of Bob's FHE ERC20 tokens
        const balanceAliceAfter = await confidentialERC20.confidentialBalanceOf(Alice.signer);
        await expect(
          fhevm.userDecryptEuint(FhevmType.euint64, balanceAliceAfter, confidentialERC20.target, Alice.signer),
        ).to.eventually.equal(50);

        // check the balance of Bob. it should be 950 because Bob transferred 50 of his FHE ERC20 tokens to Alice
        const balanceBobAfter = await confidentialERC20.confidentialBalanceOf(Bob.signer);
        await expect(
          fhevm.userDecryptEuint(FhevmType.euint64, balanceBobAfter, confidentialERC20.target, Bob.signer),
        ).to.eventually.equal(950);
      });

      it("Alice updates her local merkle tree with the new UTXOs received from the trade", async function () {
        const outHashes = readSpentUtxoOutputs(
          zkUTXO,
          settleTxResult!,
          lockIdAlice
        );
        expect(outHashes.length).to.be.greaterThan(0);
        for (const outHash of outHashes) {
          await smtAlice.add(outHash, outHash);
        }
      });
    });
  });

  describe("Failed trade flow - counterparty fails to fulfill obligations during setup phase", function () {
    let payment1: UTXO;
    let lockedUtxo: UTXO;
    let lockIdAlice: string;
    let refundForAlice: UTXO;

    it("mint to Alice some \"Confidential UTXO\" tokens", async function () {
      payment1 = newUTXO(100, Alice);
      const result = await doMint(zkUTXO, Deployer.signer, [payment1]);

      // simulate Alice listening to minting events and updating her local merkle tree
      for (const log of result.logs) {
        const event = zkUTXO.interface.parseLog(log as any);
        expect(event.args.outputs.length).to.equal(1);
        const utxos = event.args.outputs;
        await smtAlice.add(utxos[0], utxos[0]);
      }

      let root = await smtAlice.root();
      let onchainRoot = await zkUTXO.getRoot();
      expect(root.string()).to.equal(onchainRoot.toString());
    });

    describe("Trade setup by Alice", function () {
      it("Alice creates a UTXO lock (createLock) for the trade with Bob", async function () {
        const nullifier1 = newNullifier(payment1, Alice);
        lockedUtxo = newUTXO(payment1.value!, Alice);
        const root = await smtAlice.root();
        const proof1 = await smtAlice.generateCircomVerifierProof(
          payment1.hash,
          root,
        );
        const proof2 = await smtAlice.generateCircomVerifierProof(0n, root);
        const merkleProofs = [
          proof1.siblings.map((s) => s.bigInt()),
          proof2.siblings.map((s) => s.bigInt()),
        ];
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
        const tx = await zkUTXO.connect(Alice.signer).createLock(cArgs, ZeroHash, ZeroHash, "0x");
        const w = await tx.wait();
        lockIdAlice = readLockIdFromZetoLockCreated(zkUTXO, w!);
      });

      it("Bob fails to fulfill the trade obligations", function () {
        // Bob does not lock any FHE ERC20 tokens
      });
    });

    describe("Trade cancellation by Alice", function () {
      let cancelTxResult: any;

      it("Alice cancels the trade", async function () {
        // prepare the "rollback" operation:
        // - refund the locked UTXO to Alice
        // - no locked UTXOs
        refundForAlice = newUTXO(lockedUtxo.value!, Alice);
        const encodedProofForRollback = await prepareProofLocked(
          circuitForLocked,
          provingKeyForLocked,
          Alice,
          [lockedUtxo, ZERO_UTXO],
          [refundForAlice, ZERO_UTXO],
          [Alice, Alice],
        );
        // Alice cancels the trade: {cancelLock} with a ZK proof for the refund UTXO
        const cancelArgs = encodeZetoSpendLockArgs({
          txId: randomTxId(),
          lockedOutputs: [],
          outputs: [refundForAlice.hash, ZERO_UTXO.hash],
          proof: encodeToBytesLocked(encodedProofForRollback),
          data: "0x",
        });
        const tx = await zkUTXO.connect(Alice.signer).cancelLock(lockIdAlice, cancelArgs, "0x");
        cancelTxResult = await tx.wait();
      });

      it("Alice verifies the trade cancellation by checking the UTXO events emitted by the Zeto contract", async function () {
        const outs = readZetoLockCancelledOutputs(zkUTXO, cancelTxResult!);
        expect(BigInt(outs[0])).to.equal(refundForAlice.hash);
        await smtAlice.add(refundForAlice.hash, refundForAlice.hash);
      });
    });
  });

  describe("Failed trade flow - Trade cancellation after failed attempt to settle", function () {
    let payment1: UTXO;

    let lockedUtxo: UTXO;
    let lockIdAlice: string;
    let lockIdBob: string;

    let atomInstance: any;

    before(async function () {
      const afFactory = await ethers.getContractFactory("AtomFactory");
      atomFactory = await afFactory.connect(Alice.signer).deploy();
      logger.debug("AtomFactory contract instance deployed at", atomFactory.target);
      // No FHE lock when Bob is supposed to fail: random id that will not exist
      lockIdBob = "0x" + randomBytes(32).toString("hex");
    });

    it("mint to Alice some \"Confidential UTXO\" tokens", async function () {
      payment1 = newUTXO(100, Alice);
      const result = await doMint(zkUTXO, Deployer.signer, [payment1]);

      // simulate Alice listening to minting events and updating her local merkle tree
      for (const log of result.logs) {
        const event = zkUTXO.interface.parseLog(log as any);
        expect(event.args.outputs.length).to.equal(1);
        const utxos = event.args.outputs;
        await smtAlice.add(utxos[0], utxos[0]);
      }

      let root = await smtAlice.root();
      let onchainRoot = await zkUTXO.getRoot();
      expect(root.string()).to.equal(onchainRoot.toString());
    });

    describe("Trade setup by Alice and Bob (Bob's leg has no on-chain FHE lock)", function () {
      it("Alice creates a UTXO lock (createLock) for the trade with Bob", async function () {
        const nullifier1 = newNullifier(payment1, Alice);
        lockedUtxo = newUTXO(payment1.value!, Alice);
        const root = await smtAlice.root();
        const proof1 = await smtAlice.generateCircomVerifierProof(
          payment1.hash,
          root,
        );
        const proof2 = await smtAlice.generateCircomVerifierProof(0n, root);
        const merkleProofs = [
          proof1.siblings.map((s) => s.bigInt()),
          proof2.siblings.map((s) => s.bigInt()),
        ];
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
        const tx = await zkUTXO.connect(Alice.signer).createLock(cArgs, ZeroHash, ZeroHash, "0x");
        const w = await tx.wait();
        lockIdAlice = readLockIdFromZetoLockCreated(zkUTXO, w!);
      });

      it("initialize the Atom with placeholder spendArgs (Zeto leg) and a dummy Bob lockId", async function () {
        const zetoSpendPlaceholder = encodeZetoSpendLockArgs({
          txId: randomTxId(),
          lockedOutputs: [],
          outputs: [],
          proof: "0x",
          data: "0x",
        });
        const operationAlice = {
          lockableContract: zkUTXO,
          approver: Alice.ethAddress,
          lockId: lockIdAlice,
          spendArgs: zetoSpendPlaceholder,
        };
        const operationBob = {
          lockableContract: confidentialERC20,
          approver: Bob.ethAddress,
          lockId: lockIdBob,
          spendArgs: "0x",
        };
        const tx = await atomFactory.connect(Alice.signer).create([operationAlice, operationBob]);
        const result: ContractTransactionReceipt | null = await tx.wait();
        const atomDeployedEvent = parseLockEvents(atomFactory, result!)[0];
        const instance = atomDeployedEvent?.atomInstance;
        atomInstance = await ethers.getContractAt("Atom", instance);
        logger.debug("Atom contract instance deployed at", atomInstance.target);
      });

      it("Alice approves the trade by delegating the UTXO lock to the Atom", async function () {
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

      it("attempting to settle the Atom reverts (invalid spend / or Bob {LockNotActive})", async function () {
        await expect(
          atomInstance.connect(Alice.signer).settle(),
        ).to.be.reverted;
      });
    });

    describe("Trade cancellation by Alice after failed settle attempt", function () {
      let cancelTxResult: any;

      it("Alice cancels the trade", async function () {
        // prepare the "rollback" operation:
        // - refund the locked UTXO to Alice
        // - no locked UTXOs
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
        const tx = await atomInstance
          .connect(Alice.signer)
          .cancel(lockIdAlice, cancelArgs);
        cancelTxResult = await tx.wait();
      });

      it("Alice verifies the trade cancellation by checking the lock events emitted by the Atom contract", async function () {
        // verify the lock events, showing Alice's rollback operation
        // was successfully executed
        const rolledBackEvent = parseLockEvents(atomInstance, cancelTxResult!)[0];
        expect(rolledBackEvent).to.not.be.null;
        expect(rolledBackEvent?.operationIndex).to.equal(0);
        expect(rolledBackEvent?.lockId).to.equal(lockIdAlice);
        expect(rolledBackEvent?.data).to.equal("0x");
      });
    });
  });
}).timeout(600000);

