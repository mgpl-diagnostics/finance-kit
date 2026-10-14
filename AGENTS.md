# AGENTS.md — @mgpl-diagnostics/finance-kit

The money layer of the MGPL Diagnostics backend: GST engine and GSTR-1 / GSTR-3B data, B2B receivables
and credit notes, collection-centre / franchise settlements with TDS, day-end cash closing, bank
reconciliation, lock dates, year-end close and CSV exports. **A library: no server, no GraphQL.**
It works on db-kit's `Repositories`; storage for its entities lives in db-kit (both backends).

## Map

```
src/posting.ts         THE ONLY MODULE THAT TALKS TO THE ACCOUNTING ENGINE (db-kit today, tally-kit later):
                       finance ledgers, post/cancel, books reports, financePosting (db-kit PostingHook)
src/config.ts          DEFAULT_FINANCE_CONFIG, DEFAULT_TAX_RULES, VERIFY_WITH_CA, settings.finance merge
src/util.ts            divRound, applyBp, IST days, months, financial years
src/gst/               place.ts (GSTIN, state, place of supply), breakup.ts (tax per line, CGST/SGST/IGST),
                       supply.ts, rules.ts (tax rules as data), source.ts, gstr1.ts, gstr3b.ts
src/receivables/       customers.ts (B2B customers, invoices, statements, ageing), credit-notes.ts
src/partners/          partners.ts (partners, agreements), settlements.ts (calc, TDS, accrue, pay)
src/cash/              closing.ts (day-end cash), bank.ts (CSV import, matching, MDR, BRS)
src/periods/           locks.ts (lock dates), year-end.ts (closing vouchers)
src/export/            csv.ts, books.ts, gst.ts (CSV with TOTAL rows)
scripts/test.ts        one scenario on real MongoDB (replica set) + PostgreSQL in-process; golden CSVs
test/golden/           expected CSV exports (UPDATE_GOLDEN=1 npm test rewrites; review the diff)
docs/                  api.md (calls, permissions, config), gst-notes.md (verify-with-CA items)
```

## Rules

1. **Every posting goes through `src/posting.ts`.** No other module imports `postVoucher`,
   `cancelVoucher`, `seedChartOfAccounts` or the books reports from db-kit (a test enforces it).
   When tally-kit replaces db-kit's engine, only that file changes.
2. **Money is integer paise.** No floats in amounts. Rounding is explicit (`divRound`, `applyBp`,
   largest remainder) and tested. Vouchers always balance.
3. **Every multi-record write runs in `repos.transaction()`** and uses the `tx` repositories inside.
4. **Calls take `fn(repos, input, actorId)`.** `orgId` and `actorId` come from the session, never from
   client input. Every id in an input is checked against `orgId` (`NotFoundError` otherwise).
5. **Compliance values are configuration** (`config.ts`, tax rules, `settings.finance`) with a
   "verify with CA" note, listed in `VERIFY_WITH_CA` and docs/gst-notes.md. Never present them as
   legal advice, and ask the owner before changing a value the CA must confirm.
6. **Days are IST, the financial year is April–March.** Store days as `"YYYY-MM-DD"` strings inside
   JSON (db-kit rule 10).
7. **Storage changes go to db-kit** (types, ports, `mongo/` and `pg/`, contract tests), as a db-kit PR.
8. **No doctor referral commissions.** Settlements are for collection centres and franchises only.
9. No real patient or customer data in tests or fixtures (fictional names only). No secrets, no `.env`.
   No pricing tactics in code or docs.
10. Exports end with TOTAL rows equal to the report they come from; a golden file covers each one.
11. Never commit a `file:` or `npm link` dependency on db-kit.

## Commands

```bash
npm run typecheck && npm test && npm run build
npm run llms      # regenerate llms-full.txt (CI fails when it is stale)
```

`npm test` downloads MongoDB and PostgreSQL binaries on first run. Behind a proxy that blocks them, set
`MONGOMS_SYSTEM_BINARY` to a local `mongod`.

## Licence

All rights reserved (see LICENSE).
