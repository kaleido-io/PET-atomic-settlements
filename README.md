# Secure Atomic Settlements b/w Privacy Tokens

This project demonstrates a number of atomic patterns for settlement between transfers of privacy preserving tokens.

## Generic Locking Interfaces for Privacy Tokens

The design is describe [here](./atomic-settlement.md).

## Demo Flows

The following settlement flows are demonstrated:

### Confidential ERC20 tokens vs. Confidential UTXO tokens

In [test/c-erc20-with-locking_vs_zeto.ts](./test/c-erc20-with-locking_vs_zeto.ts).

The test below illustrates the steps two parties perform for a secure trade, including setup, verification at each step, approval and execution.

```console
  DvP flows between privacy tokens implementing the locking interface
    ✔ mint to Alice some "Confidential UTXO" tokens
    ✔ mint to Bob some "Lockable Confidential ERC20" tokens
    Successful end to end trade flow between Alice (using "Confidential UTXO" tokens) and Bob (using "Lockable Confidential ERC20" tokens)
      Trade proposal setup by Alice and Bob
        ✔ Alice and Bob agree on an Atom contract instance to use for the trade, and initialize the lock IDs
        ✔ Alice uses the lock ID in the Atom contract initialization to lock a UTXO for the trade with Bob (3538ms)
        ✔ Bob decodes the LockCreate event, decodes the lock operation parameters, and verifies the output UTXOs
        ✔ Bob agrees with the trade proposal by Alice, and locks 50 of his "Lockable Confidential ERC20" tokens
        ✔ Alice verifies the trade setup by Bob, by checking the lock events emitted by the Confidential ERC20 contract
      Trade approvals
        ✔ Bob approves the trade by approving the lock operation
        ✔ Alice approves the trade by approving the lock operation
      Trade execution
        ✔ One of Alice or Bob executes the Atom contract to complete the trade (73ms)
```

The following test illustrates a rollback scenario when one of the trading parties failed to follow through with the setup.

```console
    Failed trade flow - counterparty fails to fulfill obligations during setup phase
      Trade proposal setup by Alice
        ✔ Alice and Bob agree on an Atom contract instance to use for the trade, and initialize the lock IDs
        ✔ Alice uses the lock ID in the Atom contract to lock a UTXO for the trade with Bob (3528ms)
        ✔ Bob fails to fulfill the trade proposal by Alice, so Alice cancels the trade
        ✔ Alice verifies the trade cancellation by checking the lock events emitted by the Atom contract
        ✔ Alice verifies the trade cancellation by checking the UTXO events emitted by the Zeto contract
        ✔ In the meantime, the other rollback operation has reverted
```

### Vanilla ERC20 tokens vs Confidential UTXO tokens

_To be added..._

### Vanilla ERC20 tokens vs Confidential ERC20 tokens

_To be added..._ 

## Running the test yourself

Make sure to check out the `lock-id` branch of the [Zeto](https://github.com/LFDT-Paladin/zeto) repo and place it in the same parent directory as this repo.