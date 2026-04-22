// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ILockableCapability} from "zeto-solidity/contracts/lib/interfaces/ILockableCapability.sol";

/**
 * @title ILockableERC20
 * @dev {ILockableCapability} for plain (cleartext) ERC-20 tokens. `lockId` is
 *      `keccak256(abi.encode(address(this), msg.sender, args.txId))`, matching
 *      the FHE account token’s scheme so clients and `Atom` stay uniform.
 */
interface ILockableERC20 is ILockableCapability {
    // ------------------------------------------------------------------
    // Typed ABI payloads
    // ------------------------------------------------------------------

    /// @dev Payload for {ILockableCapability.createLock}.createArgs.
    struct Erc20CreateLockArgs {
        bytes32 txId;
        address receiver;
        uint256 amount;
    }

    /// @dev Payload for {ILockableCapability.updateLock}.updateArgs
    ///      (replay-protected; commitments are the generic `bytes32` args).
    struct Erc20UpdateLockArgs {
        bytes32 txId;
    }

    /// @dev Payload for {ILockableCapability.delegateLock}.delegateArgs
    ///      (replay-protected).
    struct Erc20DelegateLockArgs {
        bytes32 txId;
    }

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    error DuplicateErc20Lock(bytes32 lockId);
    error DuplicateErc20TxId(bytes32 txId);
    error Erc20LockZeroAmount();

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    /// @dev Emitted with cleartext amount detail next to the generic {LockCreated}.
    event Erc20LockState(
        bytes32 indexed lockId,
        address indexed owner,
        address receiver,
        uint256 amount,
        bytes data
    );

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /**
     * @dev Returns the `lockId` this contract would assign for the given
     *      {Erc20CreateLockArgs} from the current caller in {ILockableCapability.createLock}.
     */
    function computeLockId(
        bytes calldata createArgs
    ) external view returns (bytes32 lockId);
}
