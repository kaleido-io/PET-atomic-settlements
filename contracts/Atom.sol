// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {IConfidentialBalanceCheck} from "./interfaces/IConfidentialBalanceCheck.sol";
import {ILockable} from "zeto-solidity/contracts/lib/interfaces/ILockable.sol";

contract Atom {
    using Address for address;

    enum Status {
        Pending,
        Executed,
        Cancelled
    }

    struct Operation {
        ILockable lockableContract;
        bytes32 lockId;
    }

    struct OperationResult {
        bool success;
        bytes returnData;
    }

    Status public status;
    Operation[] private _operations;
    bool private _hasBeenInitialized;

    event AtomStatusChanged(Status status);

    error AtomNotPending();

    error ExecutionResult(OperationResult[] result);

    constructor() {
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

    /**
     * Initialize the Atom with a list of operations.
     */
    function initialize(Operation[] memory operations) external onlyOnce {
        status = Status.Pending;
        for (uint256 i = 0; i < operations.length; i++) {
            _operations.push(operations[i]);
        }
        emit AtomStatusChanged(status);
    }

    function allowBalanceCheck(
        IConfidentialBalanceCheck confidentialERC20,
        address spender
    ) external {
        confidentialERC20.allowBalanceCheck(spender);
    }

    /**
     * Execute the operations in the Atom.
     * Reverts if the Atom has been executed or cancelled, or if any operation fails.
     */
    function settle() external {
        if (status != Status.Pending) {
            revert AtomNotPending();
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
    function cancel() external {
        if (status != Status.Pending || status != Status.Executed) {
            revert AtomNotPending();
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
}
