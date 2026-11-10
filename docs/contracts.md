# Contract reference

Solidity 0.8.28, OpenZeppelin Contracts 5.6, EVM version Cancun. Sources are in `contracts/src`,
specifications in `contracts/spec`.

| Contract              | File                                | Lines of responsibility                                      |
| --------------------- | ----------------------------------- | ------------------------------------------------------------ |
| `ParticipantRegistry` | `src/ParticipantRegistry.sol`       | Institutions, accounts, tiers, limits                        |
| `TokenisedTaka`       | `src/TokenisedTaka.sol`             | ERC-20 and ERC-1363 token gated by the registry              |
| `SettlementModule`    | `src/modules/SettlementModule.sol`  | Base of every module that receives funds with an instruction |
| `ReserveController`   | `src/modules/ReserveController.sol` | Reserve statements, issuance, redemption                     |
| `PaymentSwitch`       | `src/modules/PaymentSwitch.sol`     | Merchants, payments, transfers, refunds, fees                |
| `RemittanceGateway`   | `src/modules/RemittanceGateway.sol` | Corridors, rates, remittances, incentive pool                |
| `DisbursementHub`     | `src/modules/DisbursementHub.sol`   | Bulk payouts with Merkle commitments                         |

All amounts are in poisha (`decimals() == 2`). Exchange rates are taka per unit of foreign currency,
scaled by 1,000,000. Short codes and references are ASCII packed into `bytes32`.

## ParticipantRegistry

**Roles**

| Role                      | Holder                  | May                                                              |
| ------------------------- | ----------------------- | ---------------------------------------------------------------- |
| `REGISTRAR_ROLE`          | Network operator        | Register institutions and system accounts, rotate administrators |
| `POLICY_ROLE`             | Network operator        | Set the limits of each tier                                      |
| `SUPERVISOR_ROLE`         | Supervisory authority   | Suspend institutions, freeze and unfreeze any account            |
| Institution administrator | One key per institution | Open, re-tier, freeze, unfreeze and close its own accounts       |

**Functions**

| Function                                                                 | Caller                                 | Effect                                                                               |
| ------------------------------------------------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------ |
| `registerInstitution(id, kind, name, country, admin, settlementAccount)` | Registrar                              | Admits an institution and opens its settlement account at the Institution tier       |
| `setInstitutionActive(id, active)`                                       | Registrar or supervisor                | Suspends or reinstates an institution and, with it, every account it sponsors        |
| `setInstitutionAdmin(id, newAdmin)`                                      | Registrar                              | Rotates the administrator key                                                        |
| `registerSystemAccount(institutionId, holder)`                           | Registrar                              | Registers a settlement module                                                        |
| `openAccount(holder, tier, identityRef)`                                 | Institution administrator              | Opens a customer account (Basic, Full, Merchant or Corporate)                        |
| `changeTier(holder, newTier)`                                            | Sponsoring administrator               | Moves a customer to another tier                                                     |
| `freezeAccount(holder, reason)` / `unfreezeAccount(holder)`              | Sponsoring administrator or supervisor | Blocks or restores an account in both directions                                     |
| `closeAccount(holder)`                                                   | Sponsoring administrator               | Closes an account for good                                                           |
| `setTierLimits(tier, limits)`                                            | Policy                                 | Sets per-transaction, daily and balance limits; zero switches a limit off            |
| `policyOf(holder)`                                                       | Anyone (view)                          | Returns the limits of the account; reverts unless account and institution are active |

**Guarantees**

- An administrator key belongs to exactly one institution.
- A wallet has at most one account, and a closed account cannot be reopened.
- Only the network can assign the Institution and System tiers.

## TokenisedTaka

**Roles**

| Role               | Holder                   | May                            |
| ------------------ | ------------------------ | ------------------------------ |
| `MINTER_ROLE`      | `ReserveController` only | Mint and burn                  |
| `PAUSER_ROLE`      | Supervisory authority    | Halt and resume every movement |
| `ENFORCEMENT_ROLE` | Supervisory authority    | Move funds under a legal order |

**Behaviour of every movement**

1. The token must not be paused.
2. Sender and receiver must be eligible in the registry.
3. The sender's per-transaction limit and daily outflow are enforced; the daily counter resets at
   midnight in Dhaka.
4. The receiver's balance after the movement must stay within the cap of its tier.

`forceTransfer(from, to, amount, orderRef)` skips steps 1 and 3 and the sender's eligibility, so funds
can leave a frozen account, but the receiver must still be eligible. It emits `ForcedTransfer` with the
order reference.

`transferAndCall(to, amount, data)` is the ERC-1363 entry used to fund a module with an instruction.
It reverts when the receiver does not implement the ERC-1363 receiver interface.

## ReserveController

**Roles:** `MAKER_ROLE` records issuance requests; `CHECKER_ROLE` approves or rejects them and
confirms redemptions; `AUDITOR_ROLE` publishes reserve statements.

| Function                                                           | Caller             | Effect                                                                         |
| ------------------------------------------------------------------ | ------------------ | ------------------------------------------------------------------------------ |
| `publishReserveStatement(asOf, balance, documentHash)`             | Auditor            | Appends a statement; dates must increase and cannot be in the future           |
| `requestIssuance(institution, amount, fundingRef)`                 | Maker              | Records taka received in the trust account; each `fundingRef` is accepted once |
| `approveIssuance(id)`                                              | Checker            | Mints to the institution's settlement account                                  |
| `rejectIssuance(id, reason)`                                       | Checker            | Rejects the request; its funding reference stays consumed                      |
| `transferAndCall(controller, amount, encodeRedemption(payoutRef))` | Settlement account | Opens a redemption; the tBDT is held by the controller                         |
| `settleRedemption(id)`                                             | Checker            | Burns the held tBDT after the taka payout                                      |
| `rejectRedemption(id, reason)`                                     | Checker            | Returns the held tBDT                                                          |

**Guarantees**

- The maker of a request can never approve it (`MakerCannotApprove`).
- A mint reverts when no statement exists, when the statement is older than `maxStatementAge`
  (`ReserveStatementStale`), or when supply after the mint would exceed it (`ReserveExceeded`).
- Only settlement accounts can redeem.

## PaymentSwitch

**Roles:** `FEE_ROLE` sets the fee schedule and the fee collector. Merchants are onboarded by the
administrator of their acquiring institution.

**Instructions** (sent with `transferAndCall`)

| Instruction      | Builder                                             | Settlement                                                                                                                                            |
| ---------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Merchant payment | `encodeMerchantPayment(merchantId, invoiceRef)`     | Merchant receives the amount less the fee; the fee is split between acquirer and network. A non-zero invoice reference is accepted once per merchant. |
| Person transfer  | `encodePersonTransfer(payee, endToEndRef, purpose)` | Payee receives the full amount. No fee.                                                                                                               |
| Refund           | `encodeRefund(paymentId)`                           | Sent by the merchant of the payment; returns up to the original amount to the payer.                                                                  |

**Fees:** `feeBpsFor(categoryCode)` returns the fee of the merchant's ISO 18245 category, or the
default. Fees round down to the poisha and are capped at 3% (`MAX_FEE_BPS`). `acquirerShareBps` of each
fee goes to the acquirer's settlement account, the rest to the fee collector.

**Guarantees**

- A merchant account must be a Merchant-tier account sponsored by the acquirer itself.
- The switch holds no balance between transactions.
- Total refunds of a payment never exceed its amount; only merchant payments can be refunded.

## RemittanceGateway

**Roles:** `CORRIDOR_ROLE` opens corridors, authorises originators and sets policy;
`RATE_PUBLISHER_ROLE` publishes reference rates; `COMPLIANCE_ROLE` decides remittances under review.

| Function                                                     | Caller                            | Effect                                                                  |
| ------------------------------------------------------------ | --------------------------------- | ----------------------------------------------------------------------- |
| `configureCorridor(corridorId, currency, maxAmount, active)` | Corridor                          | Opens or updates a corridor                                             |
| `setOriginator(corridorId, institution, authorised)`         | Corridor                          | Authorises an exchange house on a corridor                              |
| `publishRate(corridorId, rate)`                              | Rate publisher                    | Sets the reference rate and its publication time                        |
| `setPolicy(policy)`                                          | Corridor                          | Incentive, rate band, rate validity, review window, screening threshold |
| `transferAndCall(gateway, amount, encodeRemittance(...))`    | Exchange house settlement account | Originates a remittance                                                 |
| `release(id)` / `reject(id, reason)`                         | Compliance                        | Pays the beneficiary, or returns the principal to the originator        |
| `reclaim(id)`                                                | Originator                        | Takes back a remittance left undecided after the review window          |
| `transferAndCall(gateway, amount, encodeIncentiveFunding())` | Institution account               | Adds to the incentive pool                                              |
| `settleIncentive(id)`                                        | Anyone                            | Pays an incentive that was deferred while the pool was short            |

**Checks on origination:** corridor active; sender authorised; reference not used before; amount within
the corridor cap; reference rate present and current; quoted rate inside the band; amount equal to the
source amount converted at the quoted rate; beneficiary eligible.

**Guarantees**

- The gateway's balance always equals the incentive pool plus the principal of remittances under
  review.
- The principal of a paid remittance never waits for the incentive pool.
- A remittance has exactly one terminal state: paid, rejected or reclaimed.

## DisbursementHub

No administrative roles. Authority comes from the registry: the payer is a Corporate or Institution
account, and approval belongs to the administrator of the payer's institution.

| Function                                                                         | Caller                                   | Effect                                                                                      |
| -------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| `transferAndCall(hub, total, encodeBatch(batchRef, merkleRoot, count, purpose))` | Payer                                    | Funds a batch awaiting approval                                                             |
| `approve(batchId)` / `reject(batchId, reason)`                                   | Administrator of the payer's institution | Approves, or rejects and returns the funds                                                  |
| `execute(batchId, payouts)`                                                      | Payer or that administrator              | Processes a chunk of payouts, each with its Merkle proof                                    |
| `close(batchId)`                                                                 | Payer or that administrator              | Returns undelivered funds; allowed when every payout is processed or 30 days after approval |

Leaf encoding: `keccak256(bytes.concat(keccak256(abi.encode(uint32 index, address account, uint128
amount))))`, the standard OpenZeppelin double hash.

**Guarantees**

- Each payout index is processed once.
- A payout the root does not cover reverts the chunk; a payout the receiver cannot accept is recorded
  as failed and the chunk continues.
- Payouts never exceed the funded total (`BatchOverdrawn`).
- After closing, the hub holds nothing for the batch.

## Specifications

| Suite                          | Cases | Focus                                                                             |
| ------------------------------ | ----- | --------------------------------------------------------------------------------- |
| `participant-registry.spec.ts` | 13    | Admission, sponsorship, tiers, freeze, closure, policy                            |
| `tokenised-taka.spec.ts`       | 14    | Eligibility, limits, Dhaka day roll-over, pause, forced transfer                  |
| `reserve-controller.spec.ts`   | 13    | Statements, maker-checker, reserve cap, stale statement, redemption               |
| `payment-switch.spec.ts`       | 15    | Merchants, fee split and rounding, invoices, transfers, refunds                   |
| `remittance-gateway.spec.ts`   | 17    | Straight-through payout, review, rate band, origination rules, deferred incentive |
| `disbursement-hub.spec.ts`     | 12    | Funding, approval, chunked execution, proofs, failed payouts, closing             |
| `conservation.spec.ts`         | 4     | Supply held by known accounts, within the reserve, modules hold what they owe     |

Run them with `pnpm --filter @takarail/contracts spec`.
