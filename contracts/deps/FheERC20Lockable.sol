// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FHE, euint64, ebool, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {FHESafeMath} from "@openzeppelin/confidential-contracts/utils/FHESafeMath.sol";
import {ERC7984} from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";
import {SepoliaConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ILockableConfidentialERC20} from "../interfaces/ILockableConfidentialERC20.sol";
import {console} from "hardhat/console.sol";

// only used in hardhat tests
// import {Atom} from "paladin/contracts/shared/Atom.sol";

contract FheERC20Lockable is
    ERC7984,
    Ownable,
    SepoliaConfig,
    ILockableConfidentialERC20
{
    mapping(bytes32 => Lock) private _locks;
    mapping(address => euint64) private _lockedBalances;

    constructor()
        ERC7984("Test ERC7984 Lockable", "tERC7984L", "https://test.com")
        Ownable(msg.sender)
    {}

    function mint(
        address to,
        externalEuint64 amount,
        bytes calldata proof
    ) public onlyOwner {
        euint64 encryptedAmount = FHE.fromExternal(amount, proof);
        _mint(to, encryptedAmount);
    }

    function burn(
        address from,
        externalEuint64 amount,
        bytes calldata proof
    ) public onlyOwner {
        euint64 encryptedAmount = FHE.fromExternal(amount, proof);
        _burn(from, encryptedAmount);
    }

    function createLock(
        bytes32 lockId,
        address receiver,
        address delegate,
        externalEuint64 amount,
        bytes calldata proof,
        bytes calldata data
    ) public {
        euint64 encryptedAmount = FHE.fromExternal(amount, proof);

        euint64 ptr;

        euint64 transferred = confidentialTransfer(
            address(this),
            encryptedAmount
        );
        _locks[lockId] = Lock(msg.sender, receiver, transferred, delegate);

        ptr = FHE.add(_lockedBalances[msg.sender], transferred);
        FHE.allowThis(ptr);
        FHE.allow(ptr, delegate);
        FHE.allow(transferred, delegate);
        FHE.allow(transferred, receiver);
        emit LockCreated(
            lockId,
            msg.sender,
            receiver,
            delegate,
            transferred,
            data
        );
    }

    function settleLock(bytes32 lockId, bytes calldata data) public {
        Lock memory lock = _locks[lockId];
        require(
            lock.delegate == msg.sender,
            "Only the delegate of the lock can settle it"
        );

        euint64 transferred = confidentialTransferFromAsTrustedOperator(
            address(this),
            lock.receiver, // for settle, the receiver is the recipient of the locked tokens
            lock.amount
        );
        euint64 ptr;

        ptr = FHE.sub(_lockedBalances[lock.owner], transferred);
        FHE.allowThis(ptr);
        FHE.allow(ptr, lock.owner);
        _lockedBalances[lock.owner] = ptr;

        emit LockSettled(
            lockId,
            lock.owner,
            lock.receiver,
            lock.delegate,
            transferred,
            data
        );
    }

    function refundLock(bytes32 lockId, bytes calldata data) public {
        Lock memory lock = _locks[lockId];
        require(
            lock.delegate == msg.sender,
            "Only the delegate of the lock can refund it"
        );
        euint64 transferred = _transfer(
            address(this),
            lock.owner, // for refund, the owner is the recipient of the locked tokens
            lock.amount
        );

        euint64 ptr;

        ptr = FHE.add(_lockedBalances[lock.owner], transferred);
        FHE.allowThis(ptr);
        FHE.allow(ptr, lock.owner);
        _lockedBalances[lock.owner] = ptr;

        emit LockRefunded(
            lockId,
            lock.owner,
            lock.receiver,
            lock.delegate,
            transferred,
            data
        );
    }

    function confidentialTransferFromAsTrustedOperator(
        address from,
        address to,
        euint64 amount
    ) internal returns (euint64 transferred) {
        require(
            FHE.isAllowed(amount, msg.sender),
            ERC7984UnauthorizedUseOfEncryptedAmount(amount, msg.sender)
        );
        // do not require isOperator(from, msg.sender), because this was called by the delegate as trusted operator
        transferred = _transfer(from, to, amount);
        FHE.allowTransient(transferred, msg.sender);
    }
}
