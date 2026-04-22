// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FHE, euint64, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {FheERC20} from "./FheERC20.sol";
import {ILockableCapability} from "zeto-solidity/contracts/lib/interfaces/ILockableCapability.sol";
import {ILockableConfidentialERC20} from "../api/ILockableConfidentialERC20.sol";

/**
 * @dev {ILockableCapability} for the FHE reference ERC-20. Lock IDs are
 *      `keccak256(abi.encode(address(this), msg.sender, txId))` where `txId`
 *      is supplied in the typed create payload.
 */
contract FheERC20Lockable is FheERC20, ILockableConfidentialERC20 {
    struct FheErc20Lock {
        address owner;
        address spender;
        address receiver;
        euint64 amount;
        bytes32 spendCommitment;
        bytes32 cancelCommitment;
    }

    mapping(bytes32 => FheErc20Lock) private _locks;
    mapping(address => euint64) private _lockedBalances;
    mapping(bytes32 => bool) private _consumedTxIds;

    function _computeLockId(
        address owner,
        bytes32 txId
    ) internal view returns (bytes32) {
        return keccak256(abi.encode(address(this), owner, txId));
    }

    function _useConfidentialTxId(bytes32 txId) internal {
        if (txId == bytes32(0) || _consumedTxIds[txId]) {
            revert DuplicateErc20TxId(txId);
        }
        _consumedTxIds[txId] = true;
    }

    modifier onlyActiveLock(bytes32 lockId) {
        if (_locks[lockId].owner == address(0)) {
            revert ILockableCapability.LockNotActive(lockId);
        }
        _;
    }

    function _onlySpender(bytes32 lockId) internal view {
        address s = _locks[lockId].spender;
        if (msg.sender != s) {
            revert ILockableCapability.LockUnauthorized(lockId, s, msg.sender);
        }
    }

    function computeLockId(
        bytes calldata createArgs
    ) external view override returns (bytes32) {
        ILockableConfidentialERC20.ConfidentialErc20CreateLockArgs
            memory args = abi.decode(
                createArgs,
                (ILockableConfidentialERC20.ConfidentialErc20CreateLockArgs)
            );
        return _computeLockId(msg.sender, args.txId);
    }

    function createLock(
        bytes calldata createArgs,
        bytes32 spendCommitment,
        bytes32 cancelCommitment,
        bytes calldata data
    ) external override returns (bytes32 lockId) {
        ILockableConfidentialERC20.ConfidentialErc20CreateLockArgs
            memory a = abi.decode(
                createArgs,
                (ILockableConfidentialERC20.ConfidentialErc20CreateLockArgs)
            );
        _useConfidentialTxId(a.txId);

        lockId = _computeLockId(msg.sender, a.txId);
        if (_locks[lockId].owner != address(0)) {
            revert DuplicateErc20Lock(lockId);
        }

        euint64 encAmount = FHE.fromExternal(a.amount, a.amountProof);

        euint64 transferred = confidentialTransfer(
            address(this),
            encAmount
        );
        euint64 ptr = FHE.add(_lockedBalances[msg.sender], transferred);
        FHE.allowThis(ptr);
        FHE.allow(ptr, msg.sender);
        FHE.allow(transferred, msg.sender);
        FHE.allow(transferred, a.receiver);

        _locks[lockId] = FheErc20Lock({
            owner: msg.sender,
            spender: msg.sender,
            receiver: a.receiver,
            amount: transferred,
            spendCommitment: spendCommitment,
            cancelCommitment: cancelCommitment
        });

        emit LockCreated(
            lockId,
            msg.sender,
            msg.sender,
            spendCommitment,
            cancelCommitment,
            data
        );
        emit ConfidentialErc20LockState(
            lockId,
            msg.sender,
            a.receiver,
            transferred,
            data
        );
    }

    function updateLock(
        bytes32 lockId,
        bytes calldata updateArgs,
        bytes32 spendCommitment,
        bytes32 cancelCommitment,
        bytes calldata data
    ) external override onlyActiveLock(lockId) {
        FheErc20Lock storage l = _locks[lockId];
        if (msg.sender != l.owner) {
            revert ILockableCapability.LockUnauthorized(
                lockId,
                l.spender,
                msg.sender
            );
        }
        if (l.spender != l.owner) {
            revert ILockableCapability.LockImmutable(lockId);
        }

        ILockableConfidentialERC20.ConfidentialErc20UpdateLockArgs
            memory ua = abi.decode(
                updateArgs,
                (ILockableConfidentialERC20.ConfidentialErc20UpdateLockArgs)
            );
        _useConfidentialTxId(ua.txId);

        l.spendCommitment = spendCommitment;
        l.cancelCommitment = cancelCommitment;
        emit LockUpdated(lockId, l.owner, spendCommitment, cancelCommitment, data);
    }

    function delegateLock(
        bytes32 lockId,
        bytes calldata delegateArgs,
        address newSpender,
        bytes calldata data
    ) external override onlyActiveLock(lockId) {
        _onlySpender(lockId);

        ILockableConfidentialERC20.ConfidentialErc20DelegateLockArgs
            memory da = abi.decode(
                delegateArgs,
                (ILockableConfidentialERC20.ConfidentialErc20DelegateLockArgs)
            );
        _useConfidentialTxId(da.txId);

        FheErc20Lock storage l = _locks[lockId];
        address fromSpender = l.spender;
        l.spender = newSpender;

        euint64 amt = l.amount;
        FHE.allow(amt, newSpender);
        FHE.allow(amt, l.receiver);

        emit LockDelegated(lockId, fromSpender, newSpender, data);
    }

    function spendLock(
        bytes32 lockId,
        bytes calldata spendArgs,
        bytes calldata data
    ) public override onlyActiveLock(lockId) {
        _onlySpender(lockId);
        FheErc20Lock memory l = _locks[lockId];
        if (l.spendCommitment != bytes32(0) || spendArgs.length > 0) {
            revert("FheERC20Lockable: custom spend not supported in V1");
        }

        euint64 moved = _transferFromAsTrustedOperator(
            address(this),
            l.receiver,
            l.amount
        );

        euint64 ptr = FHE.sub(_lockedBalances[l.owner], moved);
        FHE.allowThis(ptr);
        FHE.allow(ptr, l.owner);
        _lockedBalances[l.owner] = ptr;

        delete _locks[lockId];
        emit LockSpent(lockId, msg.sender, data);
    }

    function cancelLock(
        bytes32 lockId,
        bytes calldata cancelArgs,
        bytes calldata data
    ) public override onlyActiveLock(lockId) {
        _onlySpender(lockId);
        FheErc20Lock memory l = _locks[lockId];
        if (l.cancelCommitment != bytes32(0) || cancelArgs.length > 0) {
            revert("FheERC20Lockable: custom cancel not supported in V1");
        }

        euint64 moved = _transfer(address(this), l.owner, l.amount);
        euint64 ptr = FHE.add(_lockedBalances[l.owner], moved);
        FHE.allowThis(ptr);
        FHE.allow(ptr, l.owner);
        _lockedBalances[l.owner] = ptr;

        delete _locks[lockId];
        emit LockCancelled(lockId, msg.sender, data);
    }

    function getLock(
        bytes32 lockId
    ) external view override onlyActiveLock(lockId) returns (ILockableCapability.LockInfo memory info) {
        FheErc20Lock storage l = _locks[lockId];
        return
            ILockableCapability.LockInfo({
                owner: l.owner,
                spender: l.spender,
                spendCommitment: l.spendCommitment,
                cancelCommitment: l.cancelCommitment
            });
    }

    function isLockActive(
        bytes32 lockId
    ) external view override returns (bool active) {
        return _locks[lockId].owner != address(0);
    }

    function getLockContent(
        bytes32 lockId
    ) external view onlyActiveLock(lockId) returns (bytes memory) {
        FheErc20Lock storage l = _locks[lockId];
        return abi.encode(l.receiver, l.amount);
    }

    function _transferFromAsTrustedOperator(
        address from,
        address to,
        euint64 amount
    ) internal returns (euint64 transferred) {
        require(
            FHE.isAllowed(amount, msg.sender),
            ERC7984UnauthorizedUseOfEncryptedAmount(amount, msg.sender)
        );
        transferred = _transfer(from, to, amount);
        FHE.allowTransient(transferred, msg.sender);
    }
}
