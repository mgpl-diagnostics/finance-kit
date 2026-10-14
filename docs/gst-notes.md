# GST, TDS and accounting notes

**Nothing in this package is legal or tax advice.** The values below are configuration shipped as
starting points. The lab's chartered accountant (CA) must confirm each item marked **Verify with CA**
before the package is used for filing or for deducting tax. Change them through tax rules
(`addTaxRule`) and `organization.settings.finance`, not in code.

## Items to verify with the CA

| # | Item | Shipped default | Where to change |
| --- | --- | --- | --- |
| 1 | **Taxability of diagnostic services** (tests, packages, home collection) | exempt, SAC 999316, from 2017-07-01 | `DEFAULT_TAX_RULES` / `addTaxRule` |
| 2 | **HSN/SAC and rate of every consumable and medicine sold** | none on purpose: each item code needs its own rule, and billing refuses a code without one | `addTaxRule({ code, hsnSac, taxability, ratePercent, effectiveFrom })` |
| 3 | **Place of supply** for diagnostic services and goods | customer's state (GSTIN or `stateCode`) for B2B, otherwise the billing branch's state; an invoice may override it | `placeOfSupply` input |
| 4 | **GSTR-1 B2C Large threshold** | inter-state supply to an unregistered buyer with invoice value above Rs 1,00,000 | `settings.finance.gst.b2clThresholdPaise` |
| 5 | **TDS on collection-centre / franchise shares**: section, rate, no-PAN rate, threshold | section 194H, 2 %, 20 % without PAN, after Rs 20,000 in the financial year | `settings.finance.tds`, or a partner's own `tds` |
| 6 | **TDS rounding** | to the nearest rupee per settlement | `computeTds` (code) |
| 7 | **GST on partner shares** (does the partner charge GST, reverse charge?) | not handled in this version | Phase 2 (payables) |
| 8 | **Invoice and credit note numbers longer than 16 characters** | db-kit numbers invoices `MGPL/RPR01/2026-27/000001` (25 characters); finance-kit credit notes `MGPL/RPR01/CN/2026-27/000001` | db-kit `formatInvoiceNo`, finance-kit `formatCreditNoteNo` |
| 9 | **Credit notes and HSN quantity** | a credit note reduces value and tax in the HSN summary, not the quantity | `gstr1` |
| 10 | **Valid GST rates** accepted by `addTaxRule` | 0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40 | `validateRule` |

Item 8 matters: the GST portal accepts invoice and note numbers of **at most 16 characters**
(letters, digits, `/` and `-`), unique within a financial year. The current series do not fit.
Changing db-kit's numbering is a decision for the owner and the CA (for example `RPR01/26-27/00001`).
Until then, GSTR-1 data is correct in every other respect but the numbers need shortening before upload.

`VERIFY_WITH_CA` holds the short list; `gstr1` and `gstr3b` return it as `verifyWithCA` so any
screen that shows returns can show it too.

## How tax is computed

- Lines are billed by db-kit (`computeTotals`): line gross, then line discount, then the bill discount
  shared over lines in proportion (largest-remainder rule, so the shares add up exactly), then tax per
  line, rounded to the paisa, then round-off of the invoice to the rupee.
- **Intra-state** (place of supply = branch state): CGST = ⌊tax / 2⌋, SGST = tax − CGST, per line.
- **Inter-state**: IGST = tax.
- Exempt, nil-rated and non-GST lines carry no tax and are reported separately (GSTR-1 nil table,
  GSTR-3B 3.1(c) and 3.1(e)).
- The sales voucher posts each tax head to its own ledger (Output CGST, SGST, IGST), so returns
  reconcile with the books; the tests check it on both databases.

## Credit notes

- Issued against one invoice, per line, for a taxable value up to what is left of the line. The last
  credit of a line takes exactly the tax that is left, so credits never exceed the invoice.
- The credit note reverses the round-off when it completes the invoice.
- It is reported in the period of its own date: CDNR for registered buyers, CDNUR for B2C Large
  invoices, and netted into B2C Small otherwise.
- The invoice owes less at once (`creditedPaise`); when it was paid, the refundable amount is
  returned and the refund is recorded as a db-kit payment of kind `refund`.

## Partner settlements and TDS

- A partner (collection centre or franchise) earns a share on the invoices of its branch, under the
  agreement in force on each invoice date: a percentage of the net billed value before GST, or a fixed
  amount per test. Shares are rounded per line.
- Credit notes dated in the month take back the share in proportion to the value credited.
- TDS starts once the partner's shares in the financial year cross the threshold; the first deduction
  covers the year's earlier shares too. Rounded to the nearest rupee.
- Accrual on the last day of the month: Dr Collection Centre Share, Cr partner (share); Dr partner,
  Cr TDS Payable (TDS); Dr partner, Cr Recoveries from Partners (deductions). Payout: Dr partner,
  Cr Bank / Cash.

## Doctor referral commission

**Not built, on purpose.** Paying doctors for referring patients conflicts with medical-ethics rules in
India. Partner settlements are for collection centres and franchises (business partners), never for
referring doctors.

The default chart of accounts (tally-kit's, ported unchanged from db-kit) still contains a **"Doctor Referral Commission"** expense ledger
and a **"Doctors Payable"** ledger from an early draft. finance-kit does not use them. The owner should
decide whether to remove them from tally-kit's `DEFAULT_LEDGERS`.

## Lock dates and year-end

- A lock date (per organisation, or per branch) blocks posting and cancelling vouchers dated on or
  before it. tally-kit checks it inside the posting transaction while holding the lock row, so a lock
  set while an invoice is in flight cannot be bypassed.
- Day-end cash closing moves the branch's lock date to the end of the closed day.
- Year-end close posts one Closing voucher per branch that moves the year's income and expenses to
  "Profit & Loss A/c" under Reserves & Surplus, then locks the organisation up to 31 March. Closing
  vouchers are left out of P&L and GST reports, so the closed year still shows its result.
- No Tally software, Tally XML or import/export is involved. The accounting engine is tally-kit, our
  own software, behind `src/posting.ts`.
