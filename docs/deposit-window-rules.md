# Deposit Window Rules

## Fixed Deposit Redeem Flow

- The redeem flow should minimize user input. Opening redeem should infer defaults from the current page account and institution.
- The second row of the redeem form must show two fields:
  - Left: redeem account, meaning the fixed deposit account.
  - Right: arrival account, defaulting to the debit card account under the same institution as the deposit account.
- The redeem account defaults to the current page account's institution deposit account. If the current page account is itself a deposit account, use that account.
- The redeem lot selector appears below the account row. It only shows redeemable deposit lots.
- Redeem lots are sorted by deposit date, then maturity date, then name.
- Selecting a deposit lot must auto-fill principal, product name, annual rate, term, interest, and arrival amount.
- Interest is calculated from principal, annual rate, and term. Arrival amount is principal plus interest.
- If annual rate changes and the field loses focus, interest must be recalculated and arrival amount must update with it.
- Redeem must link to the original deposit entry. After redeem, the linked deposit lot balance is zero.
- Arrival amount may include principal and interest, but it must not be used to derive the deposit lot balance.
