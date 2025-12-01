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
        Approved,
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
    }

    struct operation {
        ILockable lockableContract;
        address approver;
        bytes32 lockId;
        bool approved;
    }

    event AtomStatusChanged(Status status);
    event OperationApproved(uint256 operationIndex);
    event OperationSettled(uint256 operationIndex, bytes32 lockId, bytes data);
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
    error AtomNotApproved();
    error NotApprover(address approver);

    Status public status;
    bool private _initialized;
    operation[] private _operations;

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
        revert NotApprover(msg.sender);
    }

    /**
     * Initialize the Atom with a operation for the trade offer.
     */
    function initialize(
        Operation[] memory _ops
    ) external initializedOnlyOnce onlyOwner {
        status = Status.Pending;
        for (uint256 i = 0; i < _ops.length; i++) {
            operation memory op = operation(
                _ops[i].lockableContract,
                _ops[i].approver,
                _ops[i].lockId,
                false
            );
            _operations.push(op);
        }
        emit AtomStatusChanged(status);
    }

    function approveOperation(
        uint256 operationIndex
    ) external onlyCounterparty {
        require(
            _operations[operationIndex].approver == msg.sender,
            "Only the approver can approve the operation."
        );
        _operations[operationIndex].approved = true;
        if (checkApprovals()) {
            status = Status.Approved;
        }
        emit OperationApproved(operationIndex);
    }

    /**
     * Execute the operations in the Atom.
     * Reverts if the Atom has been executed or cancelled, or if any operation fails.
     */
    function settle() external onlyCounterparty {
        if (status != Status.Approved) {
            revert AtomNotApproved();
        }
        status = Status.Executed;

        for (uint256 i = 0; i < _operations.length; i++) {
            _operations[i].lockableContract.settleLock(
                _operations[i].lockId,
                ""
            );
            emit OperationSettled(i, _operations[i].lockId, "");
        }
        emit AtomStatusChanged(status);
    }

    /**
     * Cancel the Atom, preventing its execution.
     * Can only be done if the Atom is still pending.
     */
    function cancel() external onlyCounterparty {
        // should NOT require the status to be Approved, because we want to allow
        // the counterparties to cancel the trade if others fail to approve, or
        // failed to fulfill their obligations to set up the locks.
        status = Status.Cancelled;
        for (uint256 i = 0; i < _operations.length; i++) {
            try
                _operations[i].lockableContract.rollbackLock(
                    _operations[i].lockId,
                    ""
                )
            {
                emit OperationRolledBack(i, _operations[i].lockId, "");
            } catch (bytes memory reason) {
                emit OperationRollbackFailed(i, _operations[i].lockId, reason);
            }
        }
        emit AtomStatusChanged(status);
    }

    function checkApprovals() internal view returns (bool) {
        for (uint256 i = 0; i < _operations.length; i++) {
            if (!_operations[i].approved) {
                return false;
            }
        }
        return true;
    }
}
