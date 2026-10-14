# finance-kit API

Every call takes db-kit's `Repositories` first: `fn(repos, input, actorId?)`. Writes run in
`repos.transaction()` (and join an outer one). Money is integer **paise**; days are **IST** strings
(`"2026-10-14"`); the financial year runs 1 April – 31 March (`"2026-27"`).

**Tenancy.** `orgId` and `actorId` come from the authenticated session (auth-kit), never from client
input. Every call that takes an id checks that the record belongs to `orgId` and answers
`NotFoundError` otherwise.

**Permissions.** finance-kit does not check permissions; the backend does, with auth-kit's names:

| Permission | Calls |
| --- | --- |
| `accounts:read` | GST returns, statements, summaries, books reports, reconciliation report, every export |
| `accounts:post` | customer invoices, credit notes, settlements (create, accrue, pay, cancel), cash closing, bank import and matching |
| `accounts:manage` | tax rules, customers, partners and agreements, lock dates, year-end close, seeding |

**Errors** (db-kit): `ValidationError` 400, `NotFoundError` 404, `ConflictError` 409.
`PeriodLockedError` (409, a `ConflictError`): the date is on or before a lock date.
`CreditLimitError` (409, a `ConflictError`): a B2B invoice would exceed the customer's credit limit.

## Setup

| Call | Notes |
| --- | --- |
| `financePosting` | db-kit `PostingHook`: `createDb({ ..., posting: financePosting })`. Workflows that need it call `assertFinancePosting(repos)` and refuse to run without it |
| `seedFinanceLedgers(repos, orgId)` | db-kit's chart plus `FINANCE_LEDGERS` (Collection Centre Share, Recoveries from Partners, TDS Payable, Cash Short / Excess, Bank Charges, Profit & Loss A/c). Idempotent |
| `seedTaxRules(repos, orgId, defs = DEFAULT_TAX_RULES, actorId?)` | starting GST rules. **Verify with CA** |
| `addTaxRule(repos, orgId, def, actorId?)` | `{ code? , category?, hsnSac, taxability, ratePercent, effectiveFrom, note? }`. Rates: 0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40 (verify with CA) |
| `financeConfig(repos, orgId)` | `DEFAULT_FINANCE_CONFIG` merged with `organization.settings.finance` |

### Configuration

`organization.settings.finance` (all optional, merged over the defaults). Every value is
configuration to be **verified with the lab's CA**:

```ts
{
  gst:  { b2clThresholdPaise: 100_000_00 },              // GSTR-1 B2C Large: inter-state, unregistered, invoice above this
  tds:  { section: "194H", rateBp: 200,                  // 200 bp = 2 %
          noPanRateBp: 2000, thresholdPaise: 20_000_00 }, // threshold per partner per financial year (null = always)
  bank: { toleranceDays: 3, maxFeeBp: 300, clearingLedgerKeys: ["upi", "card"] },
}
```

`VERIFY_WITH_CA` lists the items; `gstr1`, `gstr3b` return it as `verifyWithCA`.

## GST

| Call | Returns |
| --- | --- |
| `applyTaxRules(repos, orgId, items, at?)` | items with `hsnSac`, `taxability`, `taxPercent` from the rule in force (an item-code rule beats a category rule; the latest `effectiveFrom` wins). `ValidationError` when no rule applies |
| `resolveTaxRule(rules, { code, category }, at)` | the rule, or `undefined` |
| `placeOfSupply({ branch, org?, customer?, override? })` | state code: override → customer (state or GSTIN) → branch |
| `invoiceTaxLines(invoice, interState)` | per line: taxable value after line and bill discount, tax, CGST/SGST or IGST |
| `gstr1(repos, { orgId, from, to, gstin? })` | `{ gstin, b2b, b2cl, b2cs, cdnr, cdnur, nil, hsn: { b2b, b2c }, docs, totals, verifyWithCA }` |
| `gstr3b(repos, { orgId, from, to, gstin? })` | `{ outwardTaxable (3.1a), outwardNilExemptPaise (3.1c), outwardNonGstPaise (3.1e), interStateUnregistered (3.2), verifyWithCA }` |

Rounding: bill discount is shared over lines in proportion with the largest-remainder rule; tax is
rounded per line; CGST = ⌊tax / 2⌋, SGST = the rest. Returns cover the invoices and credit notes
dated in the period whose branch files under `gstin` (default: the organisation's GSTIN). Rows that
credit notes cancel out entirely are left out.

## Receivables

| Call | Notes |
| --- | --- |
| `createCustomer(repos, { orgId, code, name, kind, gstin?, stateCode?, pan?, creditLimitPaise?, creditDays?, … }, actorId?)` | `kind`: hospital, insurer, tpa, corporate, other. Creates the customer's ledger under Sundry Debtors. Code upper-cased, unique per organisation |
| `updateCustomer(repos, { orgId, customerId, ...patch }, actorId?)` | terms, details, `active`. The code and ledger stay |
| `issueCustomerInvoice(repos, { orgId, branchId, patientId, customerId, items, placeOfSupply?, applyTaxRules?, … }, actorId?)` | locks the customer, applies the tax rules, checks the credit limit against the ledger balance, then bills through db-kit's `issueInvoice`. `CreditLimitError`, `PeriodLockedError` |
| `customerStatement(repos, { orgId, customerId, from, to })` | opening, ledger rows with running balance, closing, open items with due date and ageing (`not_due`, `1-30`, `31-60`, `61-90`, `90+`) |
| `receivablesSummary(repos, { orgId, asOf })` | per customer: balance, overdue and ageing buckets; total |
| `issueCreditNote(repos, { orgId, invoiceId, reason, lines?, date? }, actorId?)` | `lines: [{ itemIndex, taxablePaise? }]`, default: everything not yet credited. Number `ORG/BRANCH/CN/FY/000001`. Posts a Credit Note voucher (Dr Sales, Dr Output GST, ± Round Off, Cr receivable). Returns `{ creditNote, invoice, refundablePaise }`; refund with db-kit `recordPayment(kind: "refund")` |

## Settlements (collection centres, franchises)

| Call | Notes |
| --- | --- |
| `createPartner(repos, { orgId, code, name, kind, branchId, pan?, gstin?, tds?, … }, actorId?)` | `kind`: collection_centre, franchise. Invoices of `branchId` earn the share. Creates the partner's payable ledger under Sundry Creditors. `tds: { section, rateBp }` overrides the default (e.g. a lower-deduction certificate) |
| `updatePartner(repos, { orgId, partnerId, ...patch }, actorId?)` | |
| `addAgreement(repos, { orgId, partnerId, kind, shareBp?, rates?, defaultSharePaise?, categories?, effectiveFrom, effectiveTo? }, actorId?)` | `revenue_share` (bp of net billed value before GST, rounded per line) or `fixed_rate` (per item code, × quantity). No overlaps; an open agreement ends the day before a new one starts |
| `computeSettlement(repos, { orgId, partnerId, period: "2026-03", deductions? })` | lines (agreement in force on each invoice date), credit notes of the month taken back in proportion, gross, share, deductions, TDS, net |
| `createSettlement` · `accrueSettlement(repos, { orgId, settlementId, now? })` · `paySettlement(repos, { orgId, settlementId, mode, date?, reference? })` · `cancelSettlement(repos, { orgId, settlementId })` | draft → accrued (journal on the month's last day: Dr Collection Centre Share, Cr partner; Dr partner, Cr TDS Payable; Dr partner, Cr recoveries) → paid (Payment voucher). A month accrues only after it ends; a paid settlement cannot be cancelled |
| `computeTds({ sharePaise, priorSharePaise, priorBasePaise, partner, config })` | once the year's shares cross the threshold, TDS on the year's shares not yet taxed, rounded to the rupee. **Verify with CA** |

## Cash and bank

| Call | Notes |
| --- | --- |
| `closeCashDay(repos, { orgId, branchId, day, countedPaise, denominations?, notes? }, actorId?)` | book = the branch's Cash postings up to the day's end; short or excess posts a Journal to Cash Short / Excess at 23:59:59.999 IST; the branch lock date moves to that day. Days close in order |
| `parseBankCsv(text, columns?)` | finds the header row past the bank's preamble; date, narration, reference, debit/credit or amount + Dr/Cr, balance; `1,23,456.78`, `(500.00)`, `500 Dr`; dates `dd/mm/yyyy`, `dd-Mon-yy`, ISO |
| `importBankStatement(repos, { orgId, branchId, ledgerId, csv \| lines, fileName? }, actorId?)` | `{ statement, added, skipped }`; the same line is never stored twice |
| `reconcileBank(repos, { orgId, ledgerId, statementId? }, actorId?)` | matches lines to postings (amount, date within tolerance, reference); card/UPI settlement credits to a day's clearing-ledger receipts less MDR, posting a Contra with the fee to Bank Charges. `{ matched, settlements, unmatched }` |
| `matchBankLine(repos, { orgId, lineId, voucherIds }, actorId?)` · `setBankLineStatus(repos, { orgId, lineId, status }, actorId?)` | by hand; `ignored` or back to `unmatched` |
| `bankReconciliation(repos, { orgId, ledgerId, asOf })` | balance per books, per bank, cheques not presented, deposits not credited, bank items not in books, `differencePaise` |

## Periods

| Call | Notes |
| --- | --- |
| `setLockDate(repos, { orgId, branchId?, upTo, reason? }, actorId?)` | lock the organisation or one branch up to the end of IST day `upTo` (null removes it). No voucher may be posted or cancelled on or before it; db-kit checks inside the posting transaction, and the lock row is held so a concurrent change cannot slip past |
| `lockDateFor(repos, orgId, branchId?)` · `listLocks(repos, orgId)` | |
| `closeFinancialYear(repos, { orgId, fy, now? }, actorId?)` | one Closing voucher per branch on 31 March moves the year's income and expenses to Profit & Loss A/c (Reserves & Surplus); balance-sheet ledgers carry forward; the organisation is locked up to 31 March. Once per year, only after it ends |

## Books and exports

`dayBook`, `ledgerStatement`, `ledgerBalance`, `trialBalance`, `profitAndLoss`, `balanceSheet` come
from the accounting engine through `src/posting.ts`.

CSV exports (`toCsv`: RFC 4180, CRLF, optional `bom: true` for Excel), amounts in rupees with two
decimals, each with a TOTAL row equal to the report:

`dayBookCsv`, `ledgerCsv`, `trialBalanceCsv`, `profitAndLossCsv`, `balanceSheetCsv`,
`settlementCsv(repos, { orgId, settlementId })`, `gstr1Csv(gstr1Result)` (one file per section),
`gstr3bCsv(gstr3bResult)`.
