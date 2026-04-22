import { ContractTransactionReceipt } from "ethers";
import { ethers } from "hardhat";
import { AbiCoder, hexlify, toBigInt } from "ethers";

// Mirrors zeto-solidity/test/zeto_anon_nullifier.ts and IZetoLockableCapability
const TUPLE_CREATE =
  "tuple(bytes32 txId, uint256[] inputs, uint256[] outputs, uint256[] lockedOutputs, bytes proof)";
const TUPLE_UPDATE = "tuple(bytes32 txId)";
const TUPLE_DELEGATE = "tuple(bytes32 txId)";
const TUPLE_SPEND =
  "tuple(bytes32 txId, uint256[] lockedOutputs, uint256[] outputs, bytes proof, bytes data)";

const TUPLE_ERC20_CREATE =
  "tuple(bytes32 txId, address receiver, uint256 amount, bytes amountProof)";

/** @dev Matches {ILockableERC20.Erc20CreateLockArgs} (cleartext ERC-20 lock). */
const TUPLE_ERC20_PLAIN_CREATE =
  "tuple(bytes32 txId, address receiver, uint256 amount)";

const abi = AbiCoder.defaultAbiCoder();

/** FHE `externalEuint64` from the relayer: `Uint8Array` handle, must become uint256 for AbiCoder. */
function externalEuint64ToBigInt(
  h: import("ethers").BigNumberish | Uint8Array,
): bigint {
  if (h instanceof Uint8Array) {
    if (h.length > 32) {
      throw new Error(
        `externalEuint64 handle: expected at most 32 bytes, got ${h.length}`,
      );
    }
    if (h.length < 32) {
      const padded = new Uint8Array(32);
      padded.set(h, 32 - h.length);
      return toBigInt(padded);
    }
    return toBigInt(h);
  }
  return toBigInt(h);
}

function amountProofToBytes(
  p: `0x${string}` | string | Uint8Array,
): `0x${string}` {
  if (p instanceof Uint8Array) {
    return hexlify(p) as `0x${string}`;
  }
  return p as `0x${string}`;
}

export function randomTxId() {
  return ethers.hexlify(ethers.randomBytes(32));
}

export function encodeZetoCreateLockArgs(p: {
  txId: string;
  inputs: import("ethers").BigNumberish[];
  outputs: import("ethers").BigNumberish[];
  lockedOutputs: import("ethers").BigNumberish[];
  proof: string;
}): string {
  return abi.encode([TUPLE_CREATE], [p]);
}

export function encodeZetoUpdateLockArgs(txId: string) {
  return abi.encode([TUPLE_UPDATE], [{ txId }]);
}

export function encodeZetoDelegateLockArgs(txId: string) {
  return abi.encode([TUPLE_DELEGATE], [{ txId }]);
}

export function encodeZetoSpendLockArgs(p: {
  txId: string;
  lockedOutputs: import("ethers").BigNumberish[];
  outputs: import("ethers").BigNumberish[];
  proof: string;
  data: string;
}) {
  return abi.encode([TUPLE_SPEND], [p]);
}

export function encodeErc20CreateLockArgs(p: {
  txId: string;
  receiver: string;
  /// @dev Ciphertext handle from FHE; ABI-encoded as uint256
  amount: import("ethers").BigNumberish | { toString: () => string } | object;
  amountProof: `0x${string}` | string;
}): string {
  return abi.encode(
    [TUPLE_ERC20_CREATE],
    [
      {
        txId: p.txId,
        receiver: p.receiver,
        amount: externalEuint64ToBigInt(p.amount as any),
        amountProof: amountProofToBytes(
          p.amountProof as any,
        ),
      },
    ],
  );
}

/**
 * `createArgs` for {ILockableERC20.createLock} / {ERC20Lockable} (uint256 amount, no proof).
 */
export function encodePlainErc20CreateLockArgs(p: {
  txId: string;
  receiver: string;
  amount: import("ethers").BigNumberish;
}): string {
  return abi.encode(
    [TUPLE_ERC20_PLAIN_CREATE],
    [
      {
        txId: p.txId,
        receiver: p.receiver,
        amount: p.amount,
      },
    ],
  );
}

export function readLockIdFromZetoLockCreated(
  zeto: { interface: { parseLog: (l: any) => { name: string; args: any } } },
  result: ContractTransactionReceipt
): string {
  for (const log of result.logs || []) {
    try {
      const ev = zeto.interface.parseLog(log as any);
      if (ev && ev.name === "ZetoLockCreated" && ev.args && ev.args.lockId) {
        return String(ev.args.lockId);
      }
    } catch {
      /* not our event */
    }
  }
  throw new Error("ZetoLockCreated not found");
}

/**
 * UTXO output hashes to add to a local SMT from a {ZetoLockSpent} event.
 * If @param lockId is set, the first matching event (e.g. Alice's leg in Atom.settle) is used.
 */
export function readSpentUtxoOutputs(
  zeto: {
    target: { toString: () => string } | string;
    interface: { parseLog: (l: any) => { name: string; args: any } };
  },
  result: ContractTransactionReceipt,
  lockId?: string
): bigint[] {
  for (const log of result.logs || []) {
    try {
      if (String(log.address).toLowerCase() !== zeto.target.toString().toLowerCase()) {
        continue;
      }
      const ev = zeto.interface.parseLog(log as any);
      if (!ev || ev.name !== "ZetoLockSpent" || !ev.args) {
        continue;
      }
      if (lockId !== undefined) {
        const lid = String(ev.args.lockId ?? ev.args[1] ?? "");
        if (lid !== String(lockId)) {
          continue;
        }
      }
      const o = ev.args.outputs as import("ethers").BigNumberish[];
      return o.map((x) => BigInt(x.toString()));
    } catch {
      /* not this contract or wrong fragment */
    }
  }
  return [];
}

/**
 * Output UTXO hashes from the first {ZetoLockCancelled} in a receipt.
 */
export function readZetoLockCancelledOutputs(
  zeto: { interface: { parseLog: (l: any) => { name: string; args: any } } },
  result: ContractTransactionReceipt
): bigint[] {
  for (const log of result.logs || []) {
    try {
      const ev = zeto.interface.parseLog(log as any);
      if (ev && ev.name === "ZetoLockCancelled" && ev.args) {
        const o = ev.args.outputs as import("ethers").BigNumberish[];
        return o.map((x) => BigInt(x.toString()));
      }
    } catch {
      /* ignore */
    }
  }
  return [];
}
