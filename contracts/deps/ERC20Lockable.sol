// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ILockableCapability} from "zeto-solidity/contracts/lib/interfaces/ILockableCapability.sol";
import {ILockableERC20} from "../api/ILockableERC20.sol";

/**
 * @dev OpenZeppelin {ERC20} with {ILockableCapability}. On {createLock}, the
 *      owner’s `amount` is moved to this contract until {spendLock} or
 *      {cancelLock}. `lockId` is `keccak256(abi.encode(address(this), owner, txId))`.
 */
contract ERC20Lockable is ERC20, Ownable, ILockableERC20 {
    struct Erc20Lock {
        address owner;
        address spender;
        address receiver;
        uint256 amount;
        bytes32 spendCommitment;
        bytes32 cancelCommitment;
    }

    mapping(bytes32 => Erc20Lock) private _locks;
    mapping(bytes32 => bool) private _consumedTxIds;

    constructor() ERC20("Lockable TST", "LTST") Ownable(msg.sender) {}

    /// @dev Mints for tests and local deployments. Production tokens may use a
    ///      fixed supply and omit this.
    function mint(address to, uint256 value) external onlyOwner {
        _mint(to, value);
    }

    function _computeLockId(
        address lockOwner,
        bytes32 txId
    ) internal view returns (bytes32) {
        return keccak256(abi.encode(address(this), lockOwner, txId));
    }

    function _useErc20TxId(bytes32 txId) internal {
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
        ILockableERC20.Erc20CreateLockArgs memory args = abi.decode(
            createArgs,
            (ILockableERC20.Erc20CreateLockArgs)
        );
        return _computeLockId(msg.sender, args.txId);
    }

    function createLock(
        bytes calldata createArgs,
        bytes32 spendCommitment,
        bytes32 cancelCommitment,
        bytes calldata data
    ) external override returns (bytes32 lockId) {
        ILockableERC20.Erc20CreateLockArgs memory a = abi.decode(
            createArgs,
            (ILockableERC20.Erc20CreateLockArgs)
        );
        if (a.amount == 0) {
            revert ILockableERC20.Erc20LockZeroAmount();
        }
        if (a.receiver == address(0)) {
            revert ERC20InvalidReceiver(address(0));
        }
        _useErc20TxId(a.txId);

        lockId = _computeLockId(msg.sender, a.txId);
        if (_locks[lockId].owner != address(0)) {
            revert DuplicateErc20Lock(lockId);
        }

        _transfer(msg.sender, address(this), a.amount);

        _locks[lockId] = Erc20Lock({
            owner: msg.sender,
            spender: msg.sender,
            receiver: a.receiver,
            amount: a.amount,
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
        emit Erc20LockState(
            lockId,
            msg.sender,
            a.receiver,
            a.amount,
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
        Erc20Lock storage l = _locks[lockId];
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

        ILockableERC20.Erc20UpdateLockArgs memory ua = abi.decode(
            updateArgs,
            (ILockableERC20.Erc20UpdateLockArgs)
        );
        _useErc20TxId(ua.txId);

        l.spendCommitment = spendCommitment;
        l.cancelCommitment = cancelCommitment;
        emit LockUpdated(
            lockId,
            l.owner,
            spendCommitment,
            cancelCommitment,
            data
        );
    }

    function delegateLock(
        bytes32 lockId,
        bytes calldata delegateArgs,
        address newSpender,
        bytes calldata data
    ) external override onlyActiveLock(lockId) {
        _onlySpender(lockId);

        ILockableERC20.Erc20DelegateLockArgs memory da = abi.decode(
            delegateArgs,
            (ILockableERC20.Erc20DelegateLockArgs)
        );
        _useErc20TxId(da.txId);

        Erc20Lock storage l = _locks[lockId];
        address fromSpender = l.spender;
        l.spender = newSpender;
        emit LockDelegated(lockId, fromSpender, newSpender, data);
    }

    function spendLock(
        bytes32 lockId,
        bytes calldata spendArgs,
        bytes calldata data
    ) public override onlyActiveLock(lockId) {
        _onlySpender(lockId);
        Erc20Lock memory l = _locks[lockId];
        if (l.spendCommitment != bytes32(0) || spendArgs.length > 0) {
            revert("ERC20Lockable: custom spend not supported in V1");
        }

        _transfer(address(this), l.receiver, l.amount);
        delete _locks[lockId];
        emit LockSpent(lockId, msg.sender, data);
    }

    function cancelLock(
        bytes32 lockId,
        bytes calldata cancelArgs,
        bytes calldata data
    ) public override onlyActiveLock(lockId) {
        _onlySpender(lockId);
        Erc20Lock memory l = _locks[lockId];
        if (l.cancelCommitment != bytes32(0) || cancelArgs.length > 0) {
            revert("ERC20Lockable: custom cancel not supported in V1");
        }

        _transfer(address(this), l.owner, l.amount);
        delete _locks[lockId];
        emit LockCancelled(lockId, msg.sender, data);
    }

    function getLock(
        bytes32 lockId
    )
        external
        view
        override
        onlyActiveLock(lockId)
        returns (ILockableCapability.LockInfo memory info)
    {
        Erc20Lock storage l = _locks[lockId];
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
    ) external view override onlyActiveLock(lockId) returns (bytes memory) {
        Erc20Lock storage l = _locks[lockId];
        return abi.encode(l.receiver, l.amount);
    }
}
