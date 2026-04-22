// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {externalEuint64, euint64} from "@fhevm/solidity/lib/FHE.sol";
import {ILockableCapability} from "zeto-solidity/contracts/lib/interfaces/ILockableCapability.sol";

/**
 * @title ILockableConfidentialERC20
 * @dev Contract-specific {ILockableCapability} for FHE (account model) tokens.
 *      `createArgs` and `computeLockId` use the same deterministic `lockId` as Zeto,
 *      `keccak256(abi.encode(address(this), msg.sender, args.txId))`, so the flow is
 *      homomorphic to {IZetoLockableCapability} from the orchestrator’s perspective.
 */
interface ILockableConfidentialERC20 is ILockableCapability {
    // ------------------------------------------------------------------
    // Typed ABI payloads
    // ------------------------------------------------------------------

    /// @dev Payload for {ILockableCapability.createLock}.createArgs.
    struct ConfidentialErc20CreateLockArgs {
        bytes32 txId;
        address receiver;
        externalEuint64 amount;
        bytes amountProof;
    }

    /// @dev Payload for {ILockableCapability.updateLock}.updateArgs
    ///      (replay-protected; commitments are the generic `bytes32` args).
    struct ConfidentialErc20UpdateLockArgs {
        bytes32 txId;
    }

    /// @dev Payload for {ILockableCapability.delegateLock}.delegateArgs
    ///      (replay-protected).
    struct ConfidentialErc20DelegateLockArgs {
        bytes32 txId;
    }

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    /// @dev `createLock` would create a `lockId` that already has an active lock.
    error DuplicateErc20Lock(bytes32 lockId);

    /// @dev The same `txId` has already been consumed in this contract.
    error DuplicateErc20TxId(bytes32 txId);

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    /// @dev Emitted next to the generic {LockCreated} with ciphertext detail.
    event ConfidentialErc20LockState(
        bytes32 indexed lockId,
        address indexed owner,
        address receiver,
        euint64 amount,
        bytes data
    );

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /**
     * @dev Returns the `lockId` the contract would assign for the given
     *      {ConfidentialErc20CreateLockArgs} when used by the current caller
     *      in {ILockableCapability.createLock}. Useful for pre-computing
     *      the lock id in clients (mirrors {IZetoLockableCapability.computeLockId}).
     */
    function computeLockId(
        bytes calldata createArgs
    ) external view returns (bytes32 lockId);
}
