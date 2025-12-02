// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {euint64} from "@fhevm/solidity/lib/FHE.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";
import {IConfidentialBalanceCheck} from "./interfaces/IConfidentialBalanceCheck.sol";
import {ILockable} from "zeto-solidity/contracts/lib/interfaces/ILockable.sol";

contract AtomBespoke is Ownable {
    using Address for address;

    enum Status {
        Pending,
        Approved,
        Executed,
        Cancelled
    }

    struct LockOperation {
        ILockable lockableContract;
        // the account that can approve the operation before called by settle or cancel.
        // in most cases, this is the counterparty in the trade that owns the locked asset.
        address approver;
        // the id of the lock set up in the lockable contract
        bytes32 lockId;
        // the detailed operation data
        ILockable.UnlockOperationData opData;
    }

    struct ERC20TransferOperation {
        IERC7984 tokenContract;
        address approver;
        address receiver;
    }

    event AtomStatusChanged(Status status);
    event LockOperationApproved();
    event ERC20TransferOperationApproved();
    event LockOperationSettled(bytes32 lockId, bytes data);
    event ERC20TransferOperationSettled(euint64 amount, bytes data);
    event LockOperationRolledBack(bytes32 lockId, bytes data);
    event ERC20TransferOperationRolledBack(euint64 amount, bytes data);
    event LockOperationRollbackFailed(bytes32 lockId, bytes reason);
    event ERC20TransferOperationRollbackFailed(euint64 amount, bytes reason);
    error AtomNotApproved();
    error NotApprover(address approver);

    Status public status;
    bool private _initialized;
    LockOperation private _lockOperation;
    ERC20TransferOperation private _erc20TransferOperation;
    bool private _lockOperationApproved;
    bool private _erc20TransferOperationApproved;

    constructor() Ownable(msg.sender) {
        _initialized = false;
        _lockOperationApproved = false;
        _erc20TransferOperationApproved = false;
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
        if (msg.sender == _lockOperation.approver) {
            _;
            return;
        }
        if (msg.sender == _erc20TransferOperation.approver) {
            _;
            return;
        }
        revert NotApprover(msg.sender);
    }

    modifier onlyERC20Approver() {
        require(
            _erc20TransferOperation.approver == msg.sender,
            "Only the approver can approve the operation."
        );
        _;
    }

    /**
     * Initialize the Atom with a operation for the trade offer.
     */
    function initialize(
        LockOperation memory _lockOp,
        ERC20TransferOperation memory _erc20TransferOp
    ) external initializedOnlyOnce onlyOwner {
        status = Status.Pending;
        _lockOperation = _lockOp;
        _erc20TransferOperation = _erc20TransferOp;
        emit AtomStatusChanged(status);
    }

    /**
     * Allow the verifier to check the balance of the Atom contract in the confidential ERC20 token.
     * This is considered safe as the life span of the Atom contract is limited to the trade execution.
     */
    function allowBalanceCheck(
        IConfidentialBalanceCheck confidentialERC20,
        address verifier
    ) external onlyERC20Approver {
        confidentialERC20.allowBalanceCheck(verifier);
    }

    function approveERC20TransferOperation() external onlyCounterparty {
        require(
            _erc20TransferOperation.approver == msg.sender,
            "Only the approver can approve the operation."
        );
        _erc20TransferOperationApproved = true;
        status = Status.Approved;
        emit ERC20TransferOperationApproved();
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

        _lockOperation.lockableContract.unlock(
            _lockOperation.lockId,
            _lockOperation.opData
        );
        emit LockOperationSettled(_lockOperation.lockId, "");

        // transfer the tokens from the Atom contract to the approver
        // first get the encrypted balance of the Atom contract in the confidential ERC20 token
        euint64 encryptedBalance = _erc20TransferOperation
            .tokenContract
            .confidentialBalanceOf(address(this));
        // then transfer the tokens from the Atom contract to the approver
        _erc20TransferOperation.tokenContract.confidentialTransfer(
            _erc20TransferOperation.receiver,
            encryptedBalance
        );
        emit ERC20TransferOperationSettled(encryptedBalance, "");
        emit AtomStatusChanged(status);
    }

    /**
     * Cancel the Atom, preventing its execution.
     * Can only be done if the Atom is still pending.
     */
    // function cancel() external onlyCounterparty {
    //     // should NOT require the status to be Approved, because we want to allow
    //     //the counterparties to cancel the trade if others fail to approve, or
    //     // fulfill their obligations by setting up the locks.
    //     status = Status.Cancelled;
    //     for (uint256 i = 0; i < _operations.length; i++) {
    //         try
    //             _operations[i].lockableContract.rollbackLock(
    //                 _operations[i].lockId,
    //                 ""
    //             )
    //         {
    //             emit OperationRolledBack(i, _operations[i].lockId, "");
    //         } catch (bytes memory reason) {
    //             emit OperationRollbackFailed(i, _operations[i].lockId, reason);
    //         }
    //     }
    //     emit AtomStatusChanged(status);
    // }
}

contract AtomBespokeFactory {
    event AtomBespokeDeployed(address addr);

    function create(
        AtomBespoke.LockOperation memory _lockOp,
        AtomBespoke.ERC20TransferOperation memory _erc20TransferOp
    ) external {
        AtomBespoke atom = new AtomBespoke();
        atom.initialize(_lockOp, _erc20TransferOp);
        emit AtomBespokeDeployed(address(atom));
    }
}
