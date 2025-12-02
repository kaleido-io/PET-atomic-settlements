// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ILockable} from "zeto-solidity/contracts/lib/interfaces/ILockable.sol";

// Atom is a contract that orchestrates atomic settlements of multiple legs of a trade,
// among privacy preserving tokens that implement the ILockable interface.
contract Atom is Ownable {
    using Address for address;

    enum Status {
        Pending,
        Executed,
        Cancelled
    }

    struct Operation {
        ILockable lockableContract;
        // the account that can approve the operation before called by settle or cancel.
        // in most cases, this is the counterparty in the trade that owns the locked asset.
        address approver;
        // the id of the lock set up in the lockable contract
        bytes32 lockId;
        // the detailed operation data
        ILockable.UnlockOperationData opData;
    }

    event AtomStatusChanged(Status status);
    event OperationSettled(uint256 operationIndex, bytes32 lockId, bytes data);
    event OperationSettleFailed(
        uint256 operationIndex,
        bytes32 lockId,
        bytes reason
    );
    event OperationRolledBack(
        uint256 operationIndex,
        bytes32 lockId,
        bytes data
    );
    event OperationRollbackFailed(
        uint256 operationIndex,
        bytes32 lockId,
        bytes reason
    );
    error NotCounterparty(address party);
    error InvalidLockId(bytes32 lockId);

    Status public status;
    bool private _initialized;
    Operation[] private _operations;

    constructor() Ownable(msg.sender) {
        _initialized = false;
    }

    modifier initializedOnlyOnce() {
        require(
            !_initialized,
            "The Atom contract has already been initialized."
        );
        _initialized = true;
        _;
    }

    modifier onlyCounterparty() {
        for (uint256 i = 0; i < _operations.length; i++) {
            if (msg.sender == _operations[i].approver) {
                _;
                return;
            }
        }
        revert NotCounterparty(msg.sender);
    }

    /**
     * Initialize the Atom with a operation for the trade offer.
     */
    function initialize(
        Operation[] memory _ops
    ) external initializedOnlyOnce onlyOwner {
        status = Status.Pending;
        for (uint256 i = 0; i < _ops.length; i++) {
            _operations.push(_ops[i]);
        }
        emit AtomStatusChanged(status);
    }

    /**
     * Execute the operations in the Atom.
     * Reverts if the Atom has been executed or cancelled, or if any operation fails.
     */
    function settle() external onlyCounterparty {
        require(
            status == Status.Pending,
            "The Atom can only be settled when it is in Pending status."
        );
        status = Status.Executed;

        for (uint256 i = 0; i < _operations.length; i++) {
            _operations[i].lockableContract.unlock(
                _operations[i].lockId,
                _operations[i].opData
            );
            emit OperationSettled(i, _operations[i].lockId, "");
        }
        emit AtomStatusChanged(status);
    }

    /**
     * Cancel the Atom, preventing its execution.
     * Can only be done if the Atom is still pending.
     */
    function cancel(
        bytes32 lockId,
        ILockable.UnlockOperationData memory opData
    ) external onlyCounterparty {
        require(
            status == Status.Pending,
            "The Atom can only be cancelled when it is in Pending status."
        );
        for (uint256 i = 0; i < _operations.length; i++) {
            if (_operations[i].lockId != lockId) {
                continue;
            }
            try _operations[i].lockableContract.rollbackLock(lockId, opData) {
                emit OperationRolledBack(i, lockId, "");
            } catch (bytes memory reason) {
                emit OperationRollbackFailed(i, lockId, reason);
            }
            return;
        }
        revert InvalidLockId(lockId);
    }
}
