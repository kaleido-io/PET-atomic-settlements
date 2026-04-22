# Secure Atomic Settlements Between Privacy and Lockable Tokens

## Goal of this repository

The goal is twofold:

1. **Show a generic locking interface** — `ILockableCapability` (authoritatively defined in [Paladin](https://github.com/LFDT-Paladin/Paladin); see **Ecosystem** below) is a small, shared contract API (create, update, delegate, spend, cancel) that **different token implementations** can each realize with their own `bytes` payloads. The same orchestration pattern lets a settlement coordinator treat diverse assets uniformly at the interface boundary.

2. **Show atomic swaps across those implementations** — end-to-end tests pair tokens that each expose this API (for example UTXO-based Zeto with account-model ERC-20) and drive an **atomic multi-leg trade** (here via the `Atom` contract): both sides lock under agreed conditions, then one transaction spends both locks or parties roll back in a defined way.

Design background, event shapes, and payload conventions are in [atomic-settlement.md](./atomic-settlement.md).

## Why locking (instead of “send everything to the orchestrator”)?

Plain “approve the settlement contract and pull tokens” works for some ERC-20s, but it is not a general answer for cross-domain trades.

- **Not all token models are “custody in a single contract.”** Many privacy tokens are **UTXO-based**: value lives in notes and nullifiers, not a single `balanceOf` held by an arbitrary address. A generic orchestration contract cannot simply “become the owner” of those notes the way it can for a bank-style ERC-20. A **lock** is implemented *inside* the UTXO (or domain) contract: the chain records a spendable commitment under defined rules, and the coordinator only receives **delegated authority** to trigger `spendLock` / `cancelLock`, not long-lived custody of the raw asset.

- **Enterprise and policy constraints on custody.** In many deployments, **legal, operational, and risk requirements mean token ownership cannot be transferred to a third-party orchestration contract** (even if that contract is “just code”). **Locking** keeps economic control with the token’s own contract and the parties’ agreed-upon state machine: the coordinator is a **spender of a specific lock** after `delegateLock`, not the ultimate owner of the funds for the life of the trade.

Together, a shared `ILockableCapability` surface lets you compose **the same** settlement choreography (agree, lock, verify, delegate, execute or cancel) even when the underlying token mechanics differ.

## Ecosystem: who implements `ILockableCapability`?

**Authoritative source.** The canonical **`ILockableCapability`** definition and evolution live in the **[Paladin](https://github.com/LFDT-Paladin/Paladin)** repository (Paladin’s Solidity module). Downstream projects are expected to align with that source of truth.

**Zeto (vendored copy).** The [Zeto / `zeto-solidity`](https://github.com/LFDT-Paladin/zeto) package carries a copy of the same interface (and related types) that mirrors the Paladin original. Zeto does not import Paladin as a reference dependency, because of dependency and packaging constraints; the copy is kept in sync by convention. The **Zeto UTXO** token implements the contract-facing lifecycle through **`IZetoLockableCapability`**, with Zeto-specific `bytes` for proofs, Merkle data, and UTXO handles (see Zeto’s `contracts/lib/interfaces/`). This repository’s `Atom` examples compile against the **`zeto-solidity`** copy.

**Noto (Paladin).** Paladin’s **Noto** domain under [`solidity/contracts/domains/noto`](https://github.com/LFDT-Paladin/Paladin/tree/main/solidity/contracts/domains/noto) implements `ILockableCapability` for its token semantics, so the same `Atom`-style multi-leg pattern applies there on the **canonical** stack.

**This repository** adds reference **account-model (ERC-20) legs** (implemented against the `zeto-solidity` interface copy, consistent with the Paladin definition) on top of that family:

- **FHE (confidential) balance:** `FheERC20Lockable` and `ILockableConfidentialERC20` (typed payloads: encrypted `amount` + proof).
- **Cleartext ERC-20 balance:** `ERC20Lockable` in `contracts/deps/ERC20Lockable.sol` and `ILockableERC20` in `contracts/api/ILockableERC20.sol` (typed payloads: `uint256 amount`).

## Demo Flows

The following settlement flows are demonstrated:

### Confidential ERC20 vs. confidential UTXO (Zeto)

In [test/c-erc20-with-locking_vs_zeto.ts](./test/c-erc20-with-locking_vs_zeto.ts).

The test below illustrates the steps two parties perform for a secure trade, including setup, verification at each step, approval and execution.

```console
  DvP flows between privacy tokens implementing the locking interface
    Successful end to end trade flow between Alice (using "Confidential UTXO" tokens) and Bob (using "Lockable Confidential ERC20" tokens)
      ✔ mint to Alice some "Confidential UTXO" tokens
      ✔ mint to Bob some "Lockable Confidential ERC20" tokens
      Trade proposal setup by Alice and Bob
        ✔ Alice creates a UTXO lock (ILockableCapability.createLock) for the trade with Bob
        ✔ Alice updateLock sets the off-chain verifiable spend commitment (cancels not bound here)
        ✔ Bob verifies the intended UTXO outputs with respect to the on-chain spend commitment
        ✔ Bob creates a lock (createLock) of 50 confidential ERC-20 units to Alice as receiver
        ✔ Alice verifies the trade setup by reading FHE lock state and {ConfidentialErc20LockState}
        ✔ Alice and Bob agree on an Atom instance and initialize the lock operations (spendArgs for Zeto spendLock)
      Trade approvals
        ✔ Bob approves the trade by delegating the lock to the Atom contract (delegateLock)
        ✔ Alice approves the trade by delegating the UTXO lock to the Atom contract (delegateLock)
      Trade execution
        ✔ One of Alice or Bob executes the Atom contract to complete the trade
        ✔ Alice updates her local merkle tree with the new UTXOs received from the trade
```

The following test illustrates a rollback scenario when one of the trading parties failed to follow through with the setup.

```console
    Failed trade flow - counterparty fails to fulfill obligations during setup phase
      ✔ mint to Alice some "Confidential UTXO" tokens
      Trade setup by Alice
        ✔ Alice creates a UTXO lock (createLock) for the trade with Bob
        ✔ Bob fails to fulfill the trade obligations
      Trade cancellation by Alice
        ✔ Alice cancels the trade
        ✔ Alice verifies the trade cancellation by checking the UTXO events emitted by the Zeto contract
```

The following test illustrates a rollback scenario when both parties set up a trade on `Atom` but the second leg is invalid, so settlement fails and Alice cancels through the `Atom` contract.

```console
    Failed trade flow - Trade cancellation after failed attempt to settle
      ✔ mint to Alice some "Confidential UTXO" tokens
      Trade setup by Alice and Bob (Bob's leg has no on-chain FHE lock)
        ✔ Alice creates a UTXO lock (createLock) for the trade with Bob
        ✔ initialize the Atom with placeholder spendArgs (Zeto leg) and a dummy Bob lockId
        ✔ Alice approves the trade by delegating the UTXO lock to the Atom
        ✔ attempting to settle the Atom reverts (invalid spend / or Bob {LockNotActive})
      Trade cancellation by Alice after failed settle attempt
        ✔ Alice cancels the trade
        ✔ Alice verifies the trade cancellation by checking the lock events emitted by the Atom contract
```

### Base (IERC7984) confidential ERC20 vs. confidential UTXO

In [test/c-erc20_vs_zeto.ts](./test/c-erc20_vs_zeto.ts).

This example shows atomic settlement between an OpenZeppelin-style [IERC7984 / ERC7984](https://github.com/OpenZeppelin/openzeppelin-confidential-contracts) token and Zeto UTXO tokens (no `ILockableCapability` on the FHE leg; the Atom approves a balance check instead).

```console
  DvP flows between a vanilla Confidential ERC20 tokens and a Confidential UTXO token
    ✔ mint to Alice some payment tokens in Confidential UTXO
    ✔ mint to Bob some Confidential ERC20 tokens (38ms)
    Successful trade flow between Alice (using Confidential UTXO tokens) and Bob (using Confidential ERC20 tokens)
      Trade proposal setup by Alice and Bob
        ✔ Alice locks a UTXO to initiate a trade with Bob (3191ms)
        ✔ Alice prepares the unlock details for the trade proposal
        ✔ Bob decodes the LockCreate event, decodes the lock operation parameters, and verifies the output UTXOs
        ✔ Alice and Bob agrees on an Atom contract instance to use for the trade (359ms)
        ✔ Bob transfers 50 of his FHE ERC20 tokens to the Atom contract & approves Alice to access the encrypted amount
        ✔ Alice verifies the trade proposal response from Bob, by checking the balance of the Atom contract in the FHE ERC20 contract
      Trade approvals
        ✔ Alice approves the trade
        ✔ Bob approves the trade
      Trade execution
        ✔ One of Alice or Bob executes the Atom contract to complete the trade (56ms)
```

### Cleartext ERC-20 (`ERC20Lockable`) vs. Zeto UTXO

In [test/erc20-with-locking_vs_zeto.ts](./test/erc20-with-locking_vs_zeto.ts).

This mirrors the confidential DvP test, but Bob’s leg uses **`ERC20Lockable`** (`ILockableERC20`): `createLock` encodes `Erc20CreateLockArgs` (cleartext `uint256` amount, no FHE), locks funds by moving them to the token contract, and on `spendLock` via `Atom` releases them to Alice. Assertions use `IERC20.balanceOf` and the `Erc20LockState` event.

```console
  DvP flows: Zeto UTXO and cleartext ERC20Lockable (ILockableERC20)
    Successful end to end: Alice (Zeto) and Bob (ERC20Lockable)
      ✔ mints UTXO to Alice
      ✔ mints ERC20 to Bob
      Trade proposal setup
        ✔ Alice creates a UTXO createLock for the trade
        ✔ Alice updateLock sets spend commitment
        ✔ Bob verifies the spend commitment off-chain
        ✔ Bob createLock: 50 ERC-20 to Alice (receiver)
        ✔ Alice checks Erc20LockState and getLock
        ✔ create Atom (Zeto + ERC20 lock legs)
      Trade approvals
        ✔ Bob delegates his ERC-20 lock to the Atom
        ✔ Alice delegates her UTXO lock to the Atom
      Trade execution
        ✔ settle: randomly Alice or Bob calls Atom.settle
        ✔ Alice extends her SMT with trade outputs
    Failed setup: no Bob ERC-20 lock
      ✔ mints UTXO to Alice
      Trade setup by Alice
        ✔ Alice createLock
        ✔ Bob does not add an on-chain ERC-20 lock
      Trade cancellation by Alice (Zeto cancelLock)
        ✔ Alice cancelLock refunds UTXO
        ✔ verifies ZetoLockCancelled outputs
    Failed settle then cancel via Atom
      ✔ mints UTXO to Alice
      Setup: no matching Bob on-chain lock
        ✔ Alice createLock
        ✔ initialize Atom with placeholder spendArgs and fake Bob lockId
        ✔ Alice delegates to Atom
        ✔ settle reverts (Bob lock not active)
      Alice cancels through Atom
        ✔ cancel
        ✔ verifies OperationRolledBack for Alice leg
```

### Vanilla ERC20 vs. confidential UTXO

Covered by [test/erc20-with-locking_vs_zeto.ts](./test/erc20-with-locking_vs_zeto.ts) using `ERC20Lockable` and `ILockableERC20` (cleartext on-chain balances, not ZK-shielded).

### Vanilla ERC20 vs. confidential ERC20

_Not demonstrated in this repository._

## Running the tests

1. Check out the `ilock` branch of the [Zeto](https://github.com/LFDT-Paladin/zeto) repository and place it in the same parent directory as this repo, so `zeto-js` and `zeto-solidity` path dependencies in `package.json` resolve.
2. Install and compile: `npm install` and `npx hardhat compile`.
3. Proving keys and circuit artifacts: the Hardhat config sets default `CIRCUITS_ROOT` and `PROVING_KEYS_ROOT` for Zeto’s circuits; override in the environment if your trees live elsewhere. Without the expected `anon` / `anon_nullifier_transfer` (etc.) material, ZK-heavy tests will fail.
4. Run a single DvP file, for example:

```console
npx hardhat test test/erc20-with-locking_vs_zeto.ts
```

Running `npx hardhat test` with no path also executes other projects’ (e.g. `zeto-solidity`) Mocha files under `node_modules`, which is why you may see many **pending** tests. Scope with an explicit `test/...` path to focus on this repository’s scenarios.

If you `grep` a single `it(...)` in a DvP file, Mocha can skip required earlier steps (e.g. mints); use a **describe**-level grep or run the whole file so setup tests run in order.
