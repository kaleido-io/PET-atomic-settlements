# Secure Atomic Settlements Between Confidential ERC20 and ILockable privacy tokens

This document describes how to perform secure atomic settlements (swaps) between a vanilla [Confidential ERC20](https://github.com/OpenZeppelin/openzeppelin-confidential-contracts/tree/master/contracts/token/ERC7984) token, a.k.a ERC7984, and a privacy token that implements the [ILockable](./contracts/api/ILockable.sol) interface.

Because the ERC7984 token does not have a locking mechanism, the promised trade value is transferred to the escrow contract that performs the orchestration of the swap. The escrow contract will transfer the value to the target receiver during the atomic settlement.

To facilitate for the trading counterparty to verify the commitment for the trade, an interface [IConfidentialBalanceCheck](./contracts/deps/interfaces/IConfidentialBalanceCheck.sol) is recommended as a simple extension to the ERC7984 token implementation. This enables the escrow contract to allow the trade counterparty to peek into the committed balance that has been transferred to the escrow contract, before committing the corresponding trade leg and approving the settlement to proceed.

```solidity
interface IConfidentialBalanceCheck {
    function allowBalanceCheck(address spender) external;
}
```

## Successful settlement

The following sequence diagram describes the steps taken by the two trading parties, one using an ERC7984 token enhanced with the `IConfidentialBalanceCheck` interface, one using a Zeto token which implements a locking mechanism based on the `ILockable` interface.

```mermaid
sequenceDiagram
  actor A as Alice wallet
  participant A1 as Asset-1 contract<br>(UTXO)
  actor B as Bob wallet
  participant A2 as Asset-2 contract<br>(ERC7984+)
  participant E as Escrow contract
  par Bob deposits 100 ERC7984+ tokens to the Escrow contract
    B->>A2: transfer 100 to escrow contract
    A2->>E: transfer()
    E->>A2: allowBalanceCheck(Alice)
  end
  par Alice locks 200 UTXO tokens and designates the escrow as the delegate
    A->>A2: confidentialBalanceOf(escrow)
    A->>A: userDecryptEuint() and<br>verifies the amount
    A->>A1: lock(200 UTXO)
    A1-->>B: LockCreate event
    A->>B: secret salt for the locked UTXO
    B->>B: verify locked UTXO with<br>hash(Bob_public_key, value=200, salt)
  end
  par trade approvals
    B->>E: delegate lock to the Escrow contract
    A->>E: approves trade
  end
  par trade execution
    A->>E: settle()
    E->>A1: unlock()
    A1->>B: new 200 UTXOs for Bob
    E->>A2: confidentialTransfer(to=Alice)
    A2->>A: 100 tokens for Alice
  end
```
