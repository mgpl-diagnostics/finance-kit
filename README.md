# finance-kit

**The money layer of the MGPL Diagnostics backend, as a library.**
GST, receivables, collection-centre settlements, cash and bank, lock dates, year-end close and CSV
exports for the CA. It works on db-kit's `Repositories` (MongoDB or PostgreSQL), keeps money in integer
paise, and runs every multi-record write in one ACID transaction. There is no server and no GraphQL:
the backend exposes these calls through its own API.

![tests](https://img.shields.io/badge/checks-263-14264A) ![deps](https://img.shields.io/badge/runtime%20dependencies-0-E9A23B)

> **Tax and TDS values are configuration, not legal advice.** Every GST exemption, SAC/HSN code, rate,
> threshold and TDS section in this package must be confirmed by the lab's chartered accountant before
> use. See [docs/gst-notes.md](docs/gst-notes.md).

## What it does

| | |
| --- | --- |
| **GST engine** | tax rules are data (SAC/HSN, taxable / exempt / nil-rated / non-GST, rate, effective date) per item code or category; CGST+SGST or IGST by place of supply (branch state vs customer state) |
| **GST returns data** | GSTR-1: B2B, B2C Large, B2C Small, CDNR, CDNUR, nil/exempt, HSN/SAC summary, document summary. GSTR-3B: tables 3.1(a), 3.1(c), 3.1(e) and 3.2. Plain JSON in paise; totals reconcile with the output GST ledgers |
| **Receivables** | B2B customers (hospitals, insurers/TPAs, corporates) with their own ledgers, credit limits and terms; statements with opening balance, open items and ageing; receivables summary |
| **Credit notes** | full or partial, per invoice line, for refunds and price corrections; their own number series; reduce output tax; the invoice owes less at once |
| **Settlements** | collection centres and franchises: revenue-share or fixed-rate agreements with effective dates; monthly statement; accrual journal, TDS (configurable), deductions, payout voucher |
| **Cash** | day-end cash closing per branch: counted vs book, short/excess posted, denominations; the closed day is locked |
| **Bank** | import a bank CSV (header detection, Indian amount formats, no duplicates on re-import); match receipts and payments; card/UPI settlements net of MDR with the fee posted to Bank Charges; reconciliation statement |
| **Periods** | lock date per organisation or branch, checked inside the posting transaction (safe under concurrency); financial-year close with a closing voucher per branch |
| **Exports** | CSV of the day book, ledgers, trial balance, P&L, balance sheet, settlements, GSTR-1 sections and GSTR-3B, each with totals equal to the report |

Doctor referral commissions are **not** built, on purpose (see [docs/gst-notes.md](docs/gst-notes.md#doctor-referral-commission)).

## Use

```ts
import { createDb } from "@mgpl-diagnostics/db-kit";
import {
  financePosting, seedFinanceLedgers, seedTaxRules,
  issueCustomerInvoice, issueCreditNote, closeCashDay, gstr1, gstr1Csv,
} from "@mgpl-diagnostics/finance-kit";

// 1. finance-kit's posting hook: invoices and payments then post GST by place of supply
//    and B2B invoices to the customer's own ledger
const db = await createDb({ backend: "pg", pg: { url: process.env.DATABASE_URL! }, posting: financePosting });
const repos = db.repos;

// 2. once per organisation, after db-kit's seedOrganization (seeds the chart of accounts if needed)
await seedFinanceLedgers(repos, orgId);
await seedTaxRules(repos, orgId, undefined, actorId); // defaults: verify with CA

// 3. calls take (repos, input, actorId); orgId and actorId come from the session, never from the client
const { invoice } = await issueCustomerInvoice(repos, { orgId, branchId, patientId, customerId, items }, actorId);
const { creditNote, refundablePaise } = await issueCreditNote(repos, { orgId, invoiceId: invoice.id, reason: "Sample not collected" }, actorId);
await closeCashDay(repos, { orgId, branchId, day: "2026-10-14", countedPaise: 1_234_500 }, actorId);

const march = await gstr1(repos, { orgId, from, to });
const files = gstr1Csv(march); // { b2b, b2cl, b2cs, cdnr, cdnur, nil, hsn, docs }
```

Branches need a `stateCode` (or a GSTIN) for place of supply. Organisation-level overrides of the
defaults live in `organization.settings.finance` (see [docs/api.md](docs/api.md#configuration)).

## API

The full list, with inputs, permissions and errors, is in [docs/api.md](docs/api.md).

| Area | Calls |
| --- | --- |
| Setup | `financePosting`, `seedFinanceLedgers`, `seedTaxRules`, `addTaxRule`, `financeConfig` |
| GST | `applyTaxRules`, `placeOfSupply`, `invoiceTaxLines`, `gstr1`, `gstr3b` |
| Receivables | `createCustomer`, `updateCustomer`, `issueCustomerInvoice`, `customerStatement`, `receivablesSummary`, `issueCreditNote` |
| Settlements | `createPartner`, `updatePartner`, `addAgreement`, `computeSettlement`, `createSettlement`, `accrueSettlement`, `paySettlement`, `cancelSettlement` |
| Cash and bank | `closeCashDay`, `parseBankCsv`, `importBankStatement`, `reconcileBank`, `matchBankLine`, `setBankLineStatus`, `bankReconciliation` |
| Periods | `setLockDate`, `lockDateFor`, `listLocks`, `closeFinancialYear` |
| Books | `dayBook`, `ledgerStatement`, `ledgerBalance`, `trialBalance`, `profitAndLoss`, `balanceSheet` |
| Exports | `dayBookCsv`, `ledgerCsv`, `trialBalanceCsv`, `profitAndLossCsv`, `balanceSheetCsv`, `settlementCsv`, `gstr1Csv`, `gstr3bCsv` |

Errors are db-kit's: `ValidationError` (400), `NotFoundError` (404), `ConflictError` (409), with
`PeriodLockedError` (a `ConflictError`) for postings on or before a lock date and `CreditLimitError`
(a `ConflictError`) when a B2B invoice would exceed the customer's limit.

## Accounting engine

Every voucher finance-kit writes goes through [src/posting.ts](src/posting.ts), which calls
[ledger-kit](https://github.com/mgpl-diagnostics/ledger-kit), our own accounting engine (`postVoucher`,
`cancelVoucher`, chart of accounts, books reports); storage, types and errors stay db-kit's. A test fails
if any other module imports the engine. No Tally software, XML or import/export is involved.

## Development

```bash
npm install
npm run typecheck && npm test && npm run build
```

`npm test` starts MongoDB (replica set) and PostgreSQL in-process and runs the same scenario on both:
263 checks, golden CSV files in [test/golden](test/golden) (`UPDATE_GOLDEN=1 npm test` rewrites them;
review the diff). To develop against an unpublished db-kit or ledger-kit, use `npm link` or a `file:`
dependency locally and don't commit it.

## Licence

All rights reserved (see [LICENSE](LICENSE)).
