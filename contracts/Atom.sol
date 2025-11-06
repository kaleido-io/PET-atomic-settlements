// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IConfidentialBalanceCheck} from "./interfaces/IConfidentialBalanceCheck.sol";
import {ILockable} from "zeto-solidity/contracts/lib/interfaces/ILockable.sol";

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
    error AtomNotApproved();
    error NotApprover(address approver);

    Status public status;
    bool private _hasBeenInitialized;
    operation[] private _operations;

    constructor() Ownable(msg.sender) {
        _hasBeenInitialized = false;
    }

    modifier onlyOnce() {
        require(
            !_hasBeenInitialized,
            "The Atom contract has already been initialized."
        );
        _hasBeenInitialized = true;
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
     * Initialize the Atom with a list of operations.
     */
    function initialize(
        Operation[] memory operations
    ) external onlyOnce onlyOwner {
        status = Status.Pending;
        for (uint256 i = 0; i < operations.length; i++) {
            operation memory op = operation(
                operations[i].lockableContract,
                operations[i].approver,
                operations[i].lockId,
                false
            );
            _operations.push(op);
        }
        emit AtomStatusChanged(status);
    }

    /**
     * Allow the verifier to check the balance of the Atom contract in the confidential ERC20 token.
     * This is considered safe as the life span of the Atom contract is limited to the trade execution.
     */
    function allowBalanceCheck(
        IConfidentialBalanceCheck confidentialERC20,
        address verifier
    ) external onlyOwner {
        confidentialERC20.allowBalanceCheck(verifier);
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
        }
        emit AtomStatusChanged(status);
    }

    /**
     * Cancel the Atom, preventing its execution.
     * Can only be done if the Atom is still pending.
     */
    function cancel() external onlyCounterparty {
        if (status != Status.Approved) {
            revert AtomNotApproved();
        }
        status = Status.Cancelled;
        for (uint256 i = 0; i < _operations.length; i++) {
            _operations[i].lockableContract.refundLock(
                _operations[i].lockId,
                ""
            );
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
