# Architecture

This document explains how TakaRail is put together and why. The [contract reference](contracts.md)
lists every role, function and error; the [operations guide](operations.md) covers running the stack.

## Goals

1. **One settlement asset for every licensed institution.** A customer of a mobile wallet pays a
   merchant acquired by a bank, and both sides are settled in the same transaction.
2. **Rules enforced where value moves.** Eligibility, limits, reserve cover, rate bands and
   segregation of duties are contract logic, not procedure.
3. **Books a supervisor can rely on.** Every movement has a journal entry, and the ledger is
   reconciled against the chain and the reserve.
4. **Fit for the local market.** Poisha precision, lakh and crore, the Dhaka business day, Bangla QR,
   custodial wallets, the remittance incentive.

## Participants

| Participant                                 | On the network as                                               | Typical actions                                                                 |
| ------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Network operator                            | Institution `NETWORK`, registrar and policy roles               | Admits institutions, sets limits, fees and corridors                            |
| Supervisory authority                       | Supervisor, pauser and enforcement roles                        | Suspends institutions, freezes accounts, executes legal orders, halts the token |
| Settlement bank                             | Institution, maker and checker officers                         | Holds the reserve trust account, issues and redeems                             |
| Reserve auditor                             | Auditor role                                                    | Publishes reserve statements                                                    |
| Commercial banks, mobile financial services | Institutions with an administrator key and a settlement account | Sponsor accounts, acquire merchants, approve batches                            |
| Exchange houses abroad                      | Institutions authorised per corridor                            | Originate remittances                                                           |
| Treasury                                    | Institution                                                     | Funds the incentive pool                                                        |
| Customers, merchants, employers             | Accounts sponsored by an institution                            | Pay, receive, run payroll                                                       |

## On-chain model

### Registry and token

`ParticipantRegistry` is the single source of eligibility. An account has an institution, a tier and a
status. `TokenisedTaka` calls `registry.policyOf(account)` for the sender and the receiver of every
movement; the call reverts unless the account is active and its institution is active, and returns the
limits of the account's tier.

| Tier                | Who                                  | Limits in the reference policy                              |
| ------------------- | ------------------------------------ | ----------------------------------------------------------- |
| Basic               | Customer with simplified KYC         | ৳25,000 per transaction, ৳50,000 per day, ৳3,00,000 balance |
| Full                | Customer with full KYC               | ৳5,00,000 per transaction, ৳10,00,000 per day               |
| Merchant, Corporate | Businesses                           | None                                                        |
| Institution         | Settlement account of an institution | None                                                        |
| System              | Settlement modules                   | None                                                        |

Limits are policy values set by the network operator; they are not hard-coded. The daily counter uses
the business day in Dhaka: `(block.timestamp + 6 hours) / 1 days`.

Because the check lives in the token, a limit applies however the transfer starts: a plain transfer, a
payment through the switch or a cash-out all count against the same day.

### Funds with an instruction

Every settlement module extends `SettlementModule`, which implements the ERC-1363 receiver:

```solidity
token.transferAndCall(module, amount, instruction);
```

The token moves the funds, then calls `onTransferReceived(operator, from, value, data)` on the module.
The module checks that the caller is the token, decodes the instruction and settles. Consequences:

- Paying is one transaction. There is no approve step and no standing allowance.
- A module can only act on funds a holder has just sent it.
- Each module exposes `encode*` view functions, and the SDK mirrors them, so instructions are built
  the same way on and off chain.

### Idempotency by business reference

| Reference               | Scope              | Effect                                       |
| ----------------------- | ------------------ | -------------------------------------------- |
| Invoice number          | Per merchant       | A second payment of the same invoice reverts |
| Originator reference    | Per exchange house | A remittance cannot be submitted twice       |
| Bank transfer reference | Network            | One incoming transfer funds one issuance     |
| Batch reference         | Per payer          | A payroll cannot be funded twice             |

References up to 31 printable characters are stored as text in a `bytes32`, so they stay readable in
events and reports. Longer references are hashed.

### Reserve cover

Issuance is the only way supply grows. The checker's approval reverts unless:

- the checker is not the officer who recorded the request,
- a reserve statement exists and is not older than the configured age (48 hours in the reference
  policy),
- supply after the mint stays at or below the balance of that statement.

Redemption holds the tBDT in the controller until the checker confirms the taka payout, then burns it.
Supply therefore never exceeds reported reserves at the moment of any mint.

### Remittances

A corridor has a source currency, a cap per remittance, a set of authorised exchange houses and a
reference rate published by the settlement bank's treasury desk. The gateway requires:

- the sender is the settlement account of an exchange house authorised on the corridor,
- the reference rate is current (24 hours in the reference policy),
- the quoted rate is inside the band around the reference rate (±1.5%),
- the tBDT sent equals `sourceAmount × quotedRate / 1e6` exactly,
- the beneficiary is an eligible account.

Amounts at or below the screening threshold pay out in the same transaction. Larger amounts wait for a
compliance decision: release, reject with a reason code, or reclaim by the originator after the review
window. The incentive (2.5% in the reference policy) is paid from a pool funded by the Treasury. If
the pool is short the principal is still paid and the incentive is settled later.

### Bulk payouts

The payer funds the whole batch and commits to its payout list with a Merkle root over
`(index, account, amount)` leaves. The list itself is held by the payer's bank. After the bank
approves, payouts are executed in chunks; each one carries a Merkle proof and is processed once. A
payout to a wallet that cannot receive (frozen, closed, suspended institution, balance cap) is recorded
as failed and the chunk continues. Closing the batch returns everything that was not delivered.

## Off-chain service

### Indexer

The indexer polls for new blocks, fetches the logs of the six contracts, decodes them against the
published ABIs and applies them through projections. One batch of blocks is one database transaction
that also advances the cursor. The properties that follow:

- The read models describe the chain exactly up to the cursor block.
- A crash between batches loses nothing and applies nothing twice.
- The indexer stays `CONFIRMATIONS` blocks behind the head. On a network with immediate finality
  (QBFT) that value is zero and no rollback logic is needed.

Commands submitted through the API return only after the indexer has passed the block of their
transaction, so a query that follows a command always sees its effect.

### Ledger

Each `Transfer` event of the token posts one journal entry:

| Movement          | Debit                      | Credit                      |
| ----------------- | -------------------------- | --------------------------- |
| Issuance (mint)   | 1000 Reserve trust account | 2000 Wallet of the receiver |
| Transfer          | 2000 Wallet of the sender  | 2000 Wallet of the receiver |
| Redemption (burn) | 2000 Wallet of the sender  | 1000 Reserve trust account  |

Module wallets have ledger accounts too, so funds in transit (a remittance under review, an open batch,
a pending redemption) are visible as liabilities of the module that holds them.

A deferred constraint trigger in PostgreSQL rejects any transaction that leaves a journal entry out of
balance.

### Reconciliation

A run reads the cursor and all ledger balances from one repeatable-read snapshot, then reads
`totalSupply` and every `balanceOf` from the chain at that same block. The run is balanced when:

1. every wallet balance in the ledger equals the chain balance,
2. wallet liabilities, the reserve asset account and `totalSupply` are the same figure,

and it records the reserve statement in force beside the result. Runs happen on a schedule and on
request, and every run is kept.

### Custody

Institutions in Bangladesh hold wallets for their customers, so the API signs on their behalf. Keys
are derived from one mnemonic by index (`m/44'/60'/0'/0/index`); the database stores only the index
and the institution each wallet belongs to. An operator can sign for wallets of their own institution
only. The signer is one small module (`services/api/src/chain/custody.ts`); a production deployment
replaces it with an HSM or a KMS without touching the rest of the service.

### API

- Each route declares its access (`public`, any operator, or a list of roles) and its input as zod
  schemas. The same schemas produce the OpenAPI document served at `/docs`.
- Amounts are `bigint` in the service and decimal strings of poisha on the wire.
- Every command is simulated before it is sent. A revert surfaces as HTTP 422 with the contract's own
  error name, for instance `DailyLimitExceeded` or `ReserveExceeded`.
- Every command is written to the audit log with the operator, the signer and the outcome, whether
  the network accepted it or not.
- Sessions are JWTs; passphrases are stored as scrypt hashes.

### Data model

| Group           | Tables                                                                                                                                  | Source                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Chain           | `indexer_cursor`, `chain_events`                                                                                                        | Events                 |
| Directory       | `institutions`, `accounts`, `tier_limits`, `merchants`, `fee_schedule`, `category_fees`                                                 | Events                 |
| Money movement  | `token_transfers`, `payments`, `refunds`, `remittances`, `corridors`, `reference_rates`, `disbursement_batches`, `disbursement_payouts` | Events                 |
| Reserve         | `reserve_statements`, `issuance_requests`, `redemption_requests`                                                                        | Events                 |
| Ledger          | `ledger_accounts`, `journal_entries`, `journal_lines`, `reconciliation_runs`                                                            | Events and chain reads |
| Operations      | `operators`, `custody_keys`, `account_profiles`, `merchant_profiles`, `disbursement_payout_lists`, `audit_log`                          | The service itself     |
| Reporting views | `ledger_balances`, `settlement_flows`, `settlement_positions`, `daily_activity`                                                         | Derived                |

Tables in the first five groups can be truncated and rebuilt by replaying the chain. The operations
group is the only state the service owns.

## Privacy

- No name, phone number or national identity number is written to the chain. An account carries a
  hash of the KYC reference held by its institution.
- Display names and districts live in the service's own tables.
- Payout lists stay off chain; only their Merkle root is published.
- The network is permissioned, so ledger contents are visible to members and the supervisor, not to
  the public.

## Security notes

- **Least privilege.** Each contract uses role-based access with separate roles for separate duties.
  The admin role of each contract is meant for a multi-signature wallet with a time lock; in the
  reference network the network operator's key holds it.
- **Checks, effects, interactions.** Modules update their own state and emit events before they move
  tokens. The token does not call receivers on a plain transfer, so module payouts cannot re-enter.
- **Supply control.** Only the reserve controller can mint or burn.
- **Enforcement.** A forced transfer needs the enforcement role and a legal order reference, bypasses
  limits and the pause, and still requires an eligible receiver.
- **Bounded parameters.** Fees are capped at 3%, the incentive at 10%, and policy changes emit events.
- **Known limits of this reference.** Read endpoints are open to every signed-in operator; a
  production deployment partitions them by institution. The custody keystore is software.
