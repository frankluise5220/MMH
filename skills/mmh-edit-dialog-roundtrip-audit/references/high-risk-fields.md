# High-Risk Fields

These areas have a high chance of silent round-trip failure.

## Investment

- `TxRecord.accountId` vs `toAccountId`
- `FundEntry`-only fields vs `TxRecord` fields
- confirm date, arrival date, fee, units, fund code, note
- cash account vs investment account semantics

## Debt

- repayment strategy metadata
- prepayment linked recalculation triggers
- loan account vs funding account
- plan recomputation after save

## Insurance

- policy owner, insured person, beneficiary
- product master vs owned policy fields
- premium records linked to policy records

## Shared Selectors

- owner/group cycling
- filtered account scope
- nested add flow returning the correct selected ID

## General

- null-clearing behavior
- fields added after the original dialog was built
- any field that exists in one linked table but not the other
