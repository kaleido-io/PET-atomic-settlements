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
import { randomBytes } from "crypto";
import { loadCircuit } from "zeto-js";
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
  parseUTXOEvents,
} from "zeto-solidity/test/lib/utils";
import { deployZeto } from "zeto-solidity/test/lib/deploy";
import { loadProvingKeys, calculateUnlockHash } from "zeto-solidity/test/utils";
import { parseLockEvents } from "./lib/utils";

describe("DvP flows between a vanilla Confidential ERC20 tokens and a Confidential UTXO token", function () {
  let Deployer: User; // the minter of the FHE ERC20 tokens and Zeto tokens
  let Alice: User; // the user who holds the Zeto tokens
  let Bob: User; // the user who holds the FHE ERC20 tokens

  // instances of the contracts
  let zkUTXO: any;
  let confidentialERC20: any;
  let atomBespokeFactory: any;

  // Alice's payment UTXOs to be minted and transferred
  let payment1: UTXO;
  let payment2: UTXO;

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

    // deploy the FHE ERC20 contract for the Confidential ERC20 tokens
    const factory = await ethers.getContractFactory("FheERC20");
    confidentialERC20 = await factory.connect(Deployer.signer).deploy();
    logger.debug(`FHE ERC20 contract deployed at ${confidentialERC20.target}`);

    const afFactory = await ethers.getContractFactory("AtomBespokeFactory");
    atomBespokeFactory = await afFactory.connect(Deployer.signer).deploy();
    logger.debug("AtomBespokeFactory contract instance deployed at", atomBespokeFactory.target);
  });

  it("mint to Alice some payment tokens in Confidential UTXO", async function () {
    payment1 = newUTXO(100, Alice);
    payment2 = newUTXO(20, Alice);
    const result = await doMint(zkUTXO, Deployer.signer, [payment1, payment2]);

    // simulate Alice listening to minting events and updating her local merkle tree
    for (const log of result.logs) {
      const event = zkUTXO.interface.parseLog(log as any);
      expect(event.args.outputs.length).to.equal(2);
      const utxos = event.args.outputs;
      await smtAlice.add(utxos[0], utxos[0]);
      await smtAlice.add(utxos[1], utxos[1]);
    }

    let root = await smtAlice.root();
    let onchainRoot = await zkUTXO.getRoot();
    expect(root.string()).to.equal(onchainRoot.toString());
  });

  it("mint to Bob some Confidential ERC20 tokens", async function () {
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

  describe("Successful trade flow between Alice (using Confidential UTXO tokens) and Bob (using Confidential ERC20 tokens)", function () {
    let lockedUtxo: UTXO;
    let lockIdAlice: string;

    let atomInstance: any;

    describe("Trade proposal setup by Alice and Bob", function () {
      let paymentForBob: UTXO;
      let changeForAlice: UTXO;
      let saltForProposedPaymentForBob: bigint;
      let changeForAliceUTXO: BigInt;

      let lockUTXOEvent: any;
      let unlockPrepareEvent: any;

      it("Alice locks a UTXO to initiate a trade with Bob", async function () {
        // generate random lockId for Alice's lock
        lockIdAlice = "0x" + randomBytes(32).toString("hex");
        // Alice consumes a Zeto token and locks it
        const nullifier1 = newNullifier(payment1, Alice);
        // The locked UTXO is owned by Alice, who is responsible for generating the proof
        // and giving it to the Atom contract as the delegate.
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

        const lockParameters = {
          inputs: [nullifier1.hash],
          outputs: [],
          lockedOutputs: [lockedUtxo.hash],
        };
        const tx = await zkUTXO.connect(Alice.signer).lock(
          lockIdAlice,
          lockParameters,
          encodeToBytes(root.bigInt(), encodedProof), // encode the root and proof together
          "0x",
        );
        const result: ContractTransactionReceipt | null = await tx.wait();

        // Note that the locked UTXO should NOT be added to the local SMT for UTXOs because it's tracked in a separate SMT onchain
        // we add it to the local SMT for locked UTXOs
        const events = parseUTXOEvents(zkUTXO, result!);
        lockUTXOEvent = events[0];
      });

      it("Alice prepares the unlock details for the trade proposal", async function () {
        paymentForBob = newUTXO(75, Bob);
        changeForAlice = newUTXO(25, Alice);
        const lockedInputs = [lockedUtxo];
        const outputs = [paymentForBob, changeForAlice];

        const unlockHash = calculateUnlockHash(
          lockedInputs,
          [],
          outputs,
          "0x",
        );
        const tx = await zkUTXO.connect(Alice.signer).prepareUnlock(
          lockIdAlice,
          { unlockHash },
          "0x",
        );
        const result = await tx.wait();
        const events = parseUTXOEvents(zkUTXO, result!);
        unlockPrepareEvent = events[0];
        // Alice will share the following with Bob in secure p2p communication channels
        saltForProposedPaymentForBob = paymentForBob.salt! as bigint;
        changeForAliceUTXO = changeForAlice.hash;
      });

      it("Bob decodes the LockCreate event, decodes the lock operation parameters, and verifies the output UTXOs", async function () {
        // check that the lockId in the event is the same as the lockId used in the operation for Alice's lock
        expect(lockUTXOEvent.lockId).to.equal(lockIdAlice);

        // Bob assembles the inputs and outputs of the unlock operation
        const expectedUnlockInputs = [lockedUtxo];
        const expectedHashForProposedPaymentForBob = newUTXO(75, Bob, saltForProposedPaymentForBob);
        const outputsInUnlockPrepare = [expectedHashForProposedPaymentForBob, { hash: changeForAliceUTXO }];
        const expectedUnlockHash = calculateUnlockHash(
          expectedUnlockInputs,
          [],
          outputsInUnlockPrepare,
          "0x",
        );
        expect(unlockPrepareEvent.settle.unlockHash).to.equal(expectedUnlockHash);
      });

      it("Alice and Bob agrees on an Atom contract instance to use for the trade", async function () {
        const encodedProofForSettle = await prepareProofLocked(
          circuitForLocked,
          provingKeyForLocked,
          Alice,
          [lockedUtxo, ZERO_UTXO],
          [paymentForBob, changeForAlice],
          [Bob, Alice],
        );
        const settleOperation = {
          outputs: [paymentForBob.hash, changeForAlice.hash],
          lockedOutputs: [],
          proof: encodeToBytesLocked(encodedProofForSettle),
          data: "0x",
        }
        const lockOperation = {
          lockableContract: zkUTXO,
          approver: Alice.ethAddress,
          lockId: lockIdAlice,
          opData: settleOperation,
        };
        const erc20TransferOperation = {
          tokenContract: confidentialERC20.target,
          approver: Bob.ethAddress,
          receiver: Alice.ethAddress,
        };
        const tx = await atomBespokeFactory.connect(Alice.signer).create(lockOperation, erc20TransferOperation);
        const result: ContractTransactionReceipt | null = await tx.wait();
        const atomDeployedEvent = parseLockEvents(atomBespokeFactory, result!)[0];
        const instance = atomDeployedEvent?.atomInstance;
        atomInstance = await ethers.getContractAt("AtomBespoke", instance);
        logger.debug("AtomBespoke contract instance deployed at", atomInstance.target);
      });

      it("Bob transfers 50 of his FHE ERC20 tokens to the Atom contract & approves Alice to access the encrypted amount", async function () {
        // Bob first transfers 50 of his FHE ERC20 tokens to the Atom contract
        const encryptedInput = await fhevm
          .createEncryptedInput(confidentialERC20.target, Bob.ethAddress)
          .add64(50)
          .encrypt();

        const tx1 = await confidentialERC20.connect(Bob.signer)["confidentialTransfer(address,bytes32,bytes)"](atomInstance.target, encryptedInput.handles[0], encryptedInput.inputProof);
        await tx1.wait();

        // Bob then approves Alice to access the encrypted amount, in order for Alice to 
        // verify the trade proposal response, by checking the balance of the Atom contract in the FHE ERC20 contract
        const tx2 = await atomInstance.connect(Bob.signer).allowBalanceCheck(confidentialERC20, Alice.ethAddress);
        await tx2.wait();
      });

      it("Alice verifies the trade proposal response from Bob, by checking the balance of the Atom contract in the FHE ERC20 contract", async function () {
        // Alice verifies the trade proposal
        const encryptedAmount = await confidentialERC20.confidentialBalanceOf(atomInstance.target);
        const decryptedAmount = await fhevm.userDecryptEuint(FhevmType.euint64, encryptedAmount, confidentialERC20.target, Alice.signer);
        expect(decryptedAmount).to.equal(50);
      });
    });

    describe("Trade approvals", function () {
      let lockId: string;
      it("Alice approves the trade", async function () {
        const tx = await zkUTXO.connect(Alice.signer).delegateLock(lockIdAlice, atomInstance.target, "0x");
        await tx.wait();
      });

      it("Bob approves the trade", async function () {
        const tx = await atomInstance.connect(Bob.signer).approveERC20TransferOperation();
        await tx.wait();
      });
    });

    describe("Trade execution", function () {
      it("One of Alice or Bob executes the Atom contract to complete the trade", async function () {
        // check the balance of Alice
        const balanceAliceBefore = await confidentialERC20.confidentialBalanceOf(Alice.signer);
        expect(balanceAliceBefore).to.equal(ZeroHash);

        // check the balance of Bob
        const balanceBobBefore = await confidentialERC20.confidentialBalanceOf(Bob.signer);
        await expect(
          fhevm.userDecryptEuint(FhevmType.euint64, balanceBobBefore, confidentialERC20.target, Bob.signer),
        ).to.eventually.equal(950);

        if (Math.random() < 0.5) {
          const tx = await atomInstance.connect(Alice.signer).settle();
          await tx.wait();
        } else {
          const tx = await atomInstance.connect(Bob.signer).settle();
          await tx.wait();
        }

        // check the balance of Alice
        const balanceAliceAfter = await confidentialERC20.confidentialBalanceOf(Alice.signer);
        await expect(
          fhevm.userDecryptEuint(FhevmType.euint64, balanceAliceAfter, confidentialERC20.target, Alice.signer),
        ).to.eventually.equal(50);

        // check the balance of Bob
        const balanceBobAfter = await confidentialERC20.confidentialBalanceOf(Bob.signer);
        await expect(
          fhevm.userDecryptEuint(FhevmType.euint64, balanceBobAfter, confidentialERC20.target, Bob.signer),
        ).to.eventually.equal(950);
      });
    });
  });
}).timeout(600000);
