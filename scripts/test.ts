// npm test — finance-kit on real MongoDB (single-node replica set) and real PostgreSQL, both started
// in-process, through db-kit's repositories. One scenario (FY 2025-26, fictional people and partners)
// runs on both databases; its CSV exports must equal the golden files in test/golden on both.
//   UPDATE_GOLDEN=1 npm test   rewrites the golden files (review the diff before committing)
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import EmbeddedPostgres from "embedded-postgres";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import {
  cancelVoucher, ConflictError, createDb, issueInvoice, NotFoundError, PeriodLockedError, postVoucher, recordPayment, seedOrganization,
  ValidationError, type Db, type Id, type ItemInput, type Repositories,
} from "@mgpl-diagnostics/db-kit";
import {
  accrueSettlement, addAgreement, addDays, addTaxRule, applyBp, applyTaxRules, assertFinancePosting, balanceSheetCsv, bankReconciliation,
  cancelSettlement, closeCashDay, closeFinancialYear, computeTds, createCustomer, createPartner, createSettlement, CreditLimitError,
  customerStatement, dayBookCsv, DEFAULT_FINANCE_CONFIG, divRound, endOfIstDay, financePosting, fyOf, fyRange, gstr1, gstr1Csv, gstr3b, gstr3bCsv,
  importBankStatement, invoiceTaxLines, issueCreditNote, issueCustomerInvoice, istDay, ledgerCsv, lockDateFor, monthRange, parseAmount,
  parseBankCsv, parseCsv, parseDay, paySettlement, placeOfSupply, profitAndLossCsv, receivablesSummary, reconcileBank, resolveTaxRule,
  roundToRupee, seedFinanceLedgers, seedTaxRules, setLockDate, settlementCsv, startOfIstDay, toCsv, trialBalanceCsv, validateRule,
} from "../src/index";
import { balanceSheet, ledgerBalance, profitAndLoss, trialBalance } from "../src/posting";

let failed = 0;
let passed = 0;
const ok = (cond: unknown, msg: string) => {
  if (cond) { passed++; console.log(`  ok    ${msg}`); }
  else { failed++; console.log(`  FAIL  ${msg}`); }
};
const rejects = async (p: Promise<unknown> | (() => unknown), type: new (...a: any[]) => Error, msg: string) => {
  try { await (typeof p === "function" ? p() : p); ok(false, `${msg} (no error)`); } catch (e) { ok(e instanceof type, `${msg}${e instanceof type ? "" : ` (got ${(e as Error).name}: ${(e as Error).message})`}`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** An instant on an IST day, e.g. at("2026-03-05", "10:30"). */
const at = (day: string, time = "10:00") => new Date(`${day}T${time}:00+05:30`);

const GOLDEN = "test/golden";
const UPDATE = process.env.UPDATE_GOLDEN === "1";
const goldenWritten = new Set<string>();
function golden(tag: string, name: string, csv: string) {
  const file = `${GOLDEN}/${name}.csv`;
  if (UPDATE && !goldenWritten.has(name)) {
    mkdirSync(GOLDEN, { recursive: true });
    writeFileSync(file, csv);
    goldenWritten.add(name);
  }
  const want = existsSync(file) ? readFileSync(file, "utf8") : null;
  ok(want === csv, `${tag} golden ${name}.csv${want === null ? " (missing: run UPDATE_GOLDEN=1 npm test)" : want === csv ? "" : " differs"}`);
  if (want !== null && want !== csv) console.log(csv);
}

/** Every voucher balances, and the trial balance has no difference. */
async function booksBalance(r: Repositories, orgId: Id, tag: string, what: string) {
  const vouchers = await r.vouchers.find({ orgId });
  const bad = vouchers.filter((v) => v.entries.reduce((s, e) => s + e.debitPaise - e.creditPaise, 0) !== 0);
  const tb = await trialBalance(r, { orgId });
  ok(bad.length === 0 && tb.differencePaise === 0 && tb.totalDebitPaise === tb.totalCreditPaise, `${tag} ${what}: ${vouchers.length} vouchers balance; trial balance Dr ${tb.totalDebitPaise} = Cr ${tb.totalCreditPaise}`);
}

const outputTax = async (r: Repositories, orgId: Id, from: Date, to: Date) => {
  const sum = async (key: string) => {
    const l = (await r.ledgers.findBySystemKey(orgId, key))!;
    const [t] = await r.ledgerEntries.totals({ orgId, ledgerId: l.id, from, to });
    return t ? t.creditPaise - t.debitPaise : 0;
  };
  return { cgst: await sum("cgst"), sgst: await sum("sgst"), igst: await sum("igst") };
};

/** Parses a CSV export and returns the row whose `col` cell equals `label`. */
const csvRow = (csv: string, label: string, col = -1) => parseCsv(csv).find((r) => (col < 0 ? r.includes(label) : r[col] === label));
const paise = (s: string | undefined) => parseAmount(s ?? "") ?? 0;

// ------------------------------------------------------------------ pure functions (once)

function unitChecks() {
  console.log("\n[unit] money, days, rounding, parsing");
  ok(divRound(5, 2) === 3 && divRound(-5, 2) === -3 && divRound(4, 3) === 1 && divRound(149, 100) === 1 && divRound(150, 100) === 2, "divRound: halves away from zero");
  ok(applyBp(37903, 2500) === 9476 && applyBp(56997, 2500) === 14249 && applyBp(-20000, 2500) === -5000, "applyBp: revenue share rounding per line");
  ok(roundToRupee(834) === 800 && roundToRupee(850) === 900 && roundToRupee(-850) === -900, "roundToRupee");
  ok(istDay(new Date("2026-03-31T18:29:59.999Z")) === "2026-03-31" && istDay(new Date("2026-03-31T18:30:00Z")) === "2026-04-01", "istDay: IST midnight boundary");
  ok(endOfIstDay("2026-03-31").toISOString() === "2026-03-31T18:29:59.999Z" && startOfIstDay("2026-04-01").toISOString() === "2026-03-31T18:30:00.000Z", "start / end of an IST day");
  const feb = monthRange("2028-02");
  ok(feb.last === "2028-02-29" && monthRange("2026-12").last === "2026-12-31", "monthRange: leap February, December");
  ok(fyRange("2025-26").first === "2025-04-01" && fyRange("2025-26").last === "2026-03-31" && fyOf("2026-03-31") === "2025-26" && fyOf("2026-04-01") === "2026-27", "financial years (1 Apr – 31 Mar)");
  ok(addDays("2026-03-30", 3) === "2026-04-02", "addDays across a month");
  ok(parseAmount("1,23,456.78") === 12345678 && parseAmount("(12.5)") === -1250 && parseAmount("12.50 Dr") === -1250 && parseAmount("0.05") === 5 && parseAmount("") === null, "parseAmount: Indian grouping, brackets, Dr/Cr, no floats");
  ok(parseDay("05/03/2026") === "2026-03-05" && parseDay("05-Mar-26") === "2026-03-05" && parseDay("2026-03-05") === "2026-03-05" && parseDay("5 Mar 2026") === "2026-03-05", "parseDay: day-first Indian formats");
  ok(JSON.stringify(parseCsv('a,"b,""c""",d\r\n1,2,3\n')) === JSON.stringify([["a", 'b,"c"', "d"], ["1", "2", "3"]]), "parseCsv: quotes, doubled quotes, CRLF");
  ok(toCsv(["a", "b"], [["x,y", 5]]) === 'a,b\r\n"x,y",5\r\n', "toCsv quotes commas, CRLF lines");
  ok(placeOfSupply({ branch: { stateCode: "22" } }) === "22" && placeOfSupply({ branch: { stateCode: "22" }, customer: { gstin: "27AAACM1234B1Z5" } }) === "27" && placeOfSupply({ branch: { stateCode: "22" }, override: "29" }) === "29", "placeOfSupply: override > customer > branch");
  const cfg = DEFAULT_FINANCE_CONFIG.tds;
  ok(computeTds({ sharePaise: 100000, priorSharePaise: 0, priorBasePaise: 0, partner: { pan: undefined, tds: null }, config: cfg }).rateBp === cfg.noPanRateBp, "TDS: no PAN → the no-PAN rate");
  const lower = computeTds({ sharePaise: 3_000_000, priorSharePaise: 0, priorBasePaise: 0, partner: { pan: "ABCDE1234F", tds: { section: "194H", rateBp: 50 } }, config: cfg });
  ok(lower.rateBp === 50 && lower.tdsPaise === 150_00, "TDS: partner override (lower deduction) 0.5% of Rs 30,000 = Rs 150");
  ok(computeTds({ sharePaise: 1_000_000, priorSharePaise: 0, priorBasePaise: 0, partner: { pan: "ABCDE1234F", tds: null }, config: cfg }).tdsPaise === 0, "TDS: below the yearly threshold, nothing");
  try { validateRule({ category: "medicine", hsnSac: "3004", taxability: "taxable", ratePercent: 13 }); ok(false, "unknown GST rate rejected"); } catch (e) { ok(e instanceof ValidationError, "unknown GST rate rejected"); }
  try { validateRule({ category: "test", hsnSac: "999316", taxability: "exempt", ratePercent: 5 }); ok(false, "exempt rule with a rate rejected"); } catch (e) { ok(e instanceof ValidationError, "exempt rule with a rate rejected"); }
  const lines = invoiceTaxLines({
    discountPaise: 9900, items: [
      { name: "a", category: "test", qty: 1, ratePaise: 39900, discountPaise: 0, taxPercent: 0, amountPaise: 39900 },
      { name: "b", category: "test", qty: 1, ratePaise: 64900, discountPaise: 4900, taxPercent: 0, amountPaise: 60000 },
    ],
  }, false);
  ok(lines[0]!.taxablePaise === 37903 && lines[1]!.taxablePaise === 56997, "invoiceTaxLines: bill discount shared by largest remainder (37903 + 56997)");
}

// ------------------------------------------------------------------ the scenario (both databases)

async function scenario(db: Db) {
  const r = db.repos;
  const tag = `[${db.backend}]`;
  console.log(`\n${tag} setup`);
  const { org, branch: rpr, owner } = await seedOrganization(r, {
    org: { name: "Maa Gayatri Path Lab", code: "MGPL", gstin: "22AAAAA0000A1Z5", settings: { finance: { tds: { thresholdPaise: 20000 } } } },
    branch: { code: "RPR01", name: "Raipur", stateCode: "22" },
    owner: { name: "Owner", email: "owner@example.com", passwordHash: "scrypt$test" },
  });
  const orgId = org.id;
  const actor = owner.id;
  const bls = await r.branches.create({ orgId, code: "BLS01", name: "Bilaspur Collection Centre", kind: "collection_center", stateCode: "22", active: true });
  await rejects(issueCustomerInvoice(db.rawRepos.posting ? { ...r, posting: undefined } : r, { orgId, branchId: rpr.id, patientId: "x", customerId: "x", items: [] }), ValidationError, `${tag} finance workflows refuse repositories without financePosting`);
  const ledgers = await seedFinanceLedgers(r, orgId);
  ok(["partner_share", "tds_payable", "cash_short_excess", "bank_charges", "retained_earnings"].every((k) => ledgers.some((l) => l.systemKey === k)) && (await seedFinanceLedgers(r, orgId)).length === ledgers.length, `${tag} finance ledgers seeded (idempotent): ${ledgers.length}`);
  ok(!ledgers.some((l) => l.systemKey === "partner_share" && /doctor/i.test(l.name)), `${tag} partner share is for collection centres, not doctors`);
  const rules = await seedTaxRules(r, orgId);
  await addTaxRule(r, orgId, { code: "SYR", category: "consumable", hsnSac: "9018", taxability: "taxable", ratePercent: 12, effectiveFrom: "2025-04-01", note: "test fixture" });
  await addTaxRule(r, orgId, { code: "KIT", category: "consumable", hsnSac: "3822", taxability: "taxable", ratePercent: 12, effectiveFrom: "2025-04-01", note: "test fixture" });
  const newer = await addTaxRule(r, orgId, { code: "KIT", category: "consumable", hsnSac: "3822", taxability: "taxable", ratePercent: 18, effectiveFrom: "2026-09-01", note: "test fixture: later rate" });
  const allRules = await r.taxRules.find({ orgId });
  ok(rules.length === 3 && resolveTaxRule(allRules, { code: "CBC", category: "test" }, at("2026-03-05"))?.hsnSac === "999316", `${tag} default rules: tests exempt under SAC 999316 (verify with CA)`);
  ok(resolveTaxRule(allRules, { code: "KIT", category: "consumable" }, at("2026-03-05"))?.ratePercent === 12 && resolveTaxRule(allRules, { code: "KIT", category: "consumable" }, at("2026-10-01"))?.id === newer.id, `${tag} rules are effective-dated (KIT 12% in March, 18% from September)`);
  await rejects(applyTaxRules(r, orgId, [{ code: "GLOVES", name: "Gloves", category: "consumable", ratePaise: 500 }]), ValidationError, `${tag} an unclassified consumable is refused (no category default)`);

  const patient = (name: string, sex: "male" | "female", phone: string) =>
    r.patients.create({ orgId, branchId: rpr.id, uhid: `T-${name.split(" ")[0]}`, name, sex, ageYears: 40, phone });
  const kavita = await patient("Kavita Sharma", "female", "9000000001");
  const ravi = await patient("Ravi Verma", "male", "9000000002");
  const asha = await patient("Asha Patel", "female", "9000000003");
  const bill = async (branchId: Id, patientId: Id, day: string, items: ItemInput[], payments: { amountPaise?: number; mode: any }[] = [], extra: { placeOfSupply?: string; billDiscountPaise?: number } = {}) => {
    const date = at(day);
    const taxed = await applyTaxRules(r, orgId, items, date);
    const { computeTotals } = await import("@mgpl-diagnostics/db-kit");
    const total = computeTotals(taxed, extra.billDiscountPaise).totals.totalPaise;
    return (await issueInvoice(r, { orgId, branchId, patientId, items: taxed, date, payments: payments.map((p) => ({ mode: p.mode, amountPaise: p.amountPaise ?? total })), ...extra })).invoice;
  };
  const CBC = { code: "CBC", name: "Complete Blood Count", category: "test" as const, ratePaise: 39900 };
  const LFT = { code: "LFT", name: "Liver Function Tests", category: "test" as const, ratePaise: 64900 };
  const ESR = { code: "ESR", name: "ESR", category: "test" as const, ratePaise: 9900 };
  const SYR = (qty: number) => ({ code: "SYR", name: "Syringe 5 ml", category: "consumable" as const, qty, ratePaise: 1000 });

  // ---------------------------------------------------------------- partners, February
  console.log(`${tag} partners and settlements`);
  const partner = await createPartner(r, { orgId, code: "bls-cc", name: "Bilaspur Diagnostics Point", kind: "collection_centre", branchId: bls.id, pan: "ABCDE1234F" }, actor);
  ok(partner.code === "BLS-CC" && (await r.ledgers.get(partner.ledgerId))?.name.includes("share payable"), `${tag} partner with its own payable ledger`);
  await addAgreement(r, { orgId, partnerId: partner.id, kind: "revenue_share", shareBp: 2500, effectiveFrom: "2025-04-01" }, actor);
  await bill(bls.id, asha.id, "2026-02-10", [CBC], [{ mode: "cash" }]);
  const feb = await createSettlement(r, { orgId, partnerId: partner.id, period: "2026-02" }, actor);
  ok(feb.sharePaise === 9975 && feb.tdsPaise === 0 && feb.status === "draft", `${tag} February: 25% of Rs 399 = Rs 99.75; below the TDS threshold`);
  await rejects(createSettlement(r, { orgId, partnerId: partner.id, period: "2026-02" }), ConflictError, `${tag} one live settlement per partner per month`);
  const febAcc = await accrueSettlement(r, { orgId, settlementId: feb.id }, actor);
  ok(febAcc.status === "accrued" && febAcc.accrualVoucherId, `${tag} February accrued (journal)`);

  // ---------------------------------------------------------------- lock date
  console.log(`${tag} lock dates`);
  await setLockDate(r, { orgId, upTo: "2026-02-28", reason: "February filed" }, actor);
  const cash = (await r.ledgers.findBySystemKey(orgId, "cash"))!;
  const capital = (await r.ledgers.findBySystemKey(orgId, "capital"))!;
  const jv = (date: Date, branchId = rpr.id) => postVoucher(r, { orgId, branchId, type: "journal", date, entries: [{ ledgerId: cash.id, debitPaise: 100, creditPaise: 0 }, { ledgerId: capital.id, debitPaise: 0, creditPaise: 100 }] });
  await rejects(jv(at("2026-02-28", "23:00")), PeriodLockedError, `${tag} posting on the lock date fails`);
  await rejects(jv(at("2026-02-20")), ConflictError, `${tag} posting before the lock date fails with ConflictError`);
  await rejects(cancelVoucher(r, febAcc.accrualVoucherId!), ConflictError, `${tag} cancelling a voucher in a locked period fails`);
  await rejects(cancelSettlement(r, { orgId, settlementId: feb.id }, actor), ConflictError, `${tag} editing a locked settlement (cancel) fails`);
  await rejects(bill(rpr.id, kavita.id, "2026-02-15", [CBC]), ConflictError, `${tag} a back-dated invoice into a locked month fails, and leaves nothing`);
  ok((await r.invoices.count({ orgId })) === 1, `${tag} the failed invoice left no row`);
  ok((await lockDateFor(r, orgId, rpr.id))?.toISOString() === endOfIstDay("2026-02-28").toISOString(), `${tag} lockDateFor`);

  // ---------------------------------------------------------------- GST: March at Raipur
  console.log(`${tag} GST engine`);
  const A = await bill(rpr.id, kavita.id, "2026-03-05", [CBC], [{ mode: "cash" }]);
  const B = await bill(rpr.id, ravi.id, "2026-03-05", [CBC, SYR(2)], [{ mode: "card" }]);
  const C = await bill(rpr.id, asha.id, "2026-03-05", [CBC], [{ mode: "upi" }]);
  const D = await bill(rpr.id, kavita.id, "2026-03-06", [LFT], [{ mode: "cash" }]);
  ok(B.taxPaise === 240 && B.roundOffPaise === -40 && B.totalPaise === 42100 && B.items[1]!.hsnSac === "9018" && B.items[0]!.taxability === "exempt", `${tag} rules applied: CBC exempt, syringes 12% (tax Rs 2.40, round-off −0.40)`);
  const bSales = (await r.vouchers.find({ invoiceId: B.id, type: "sales" }))[0]!;
  const cgstL = (await r.ledgers.findBySystemKey(orgId, "cgst"))!.id, sgstL = (await r.ledgers.findBySystemKey(orgId, "sgst"))!.id, igstL = (await r.ledgers.findBySystemKey(orgId, "igst"))!.id;
  ok(bSales.entries.find((e) => e.ledgerId === cgstL)?.creditPaise === 120 && bSales.entries.find((e) => e.ledgerId === sgstL)?.creditPaise === 120 && !bSales.entries.some((e) => e.ledgerId === igstL), `${tag} intra-state: CGST 1.20 + SGST 1.20, no IGST`);

  const city = await createCustomer(r, { orgId, code: "cityhosp", name: "City Care Hospital", kind: "hospital", gstin: "22AABCC1234D1Z5", creditLimitPaise: 2_000_00, creditDays: 30 }, actor);
  const mum = await createCustomer(r, { orgId, code: "MUMLAB", name: "Western Path Labs", kind: "corporate", gstin: "27AAACM1234B1Z5", creditDays: 15 }, actor);
  ok(city.stateCode === "22" && mum.stateCode === "27" && city.ledgerId !== mum.ledgerId && mum.creditLimitPaise === null, `${tag} B2B customers: state from GSTIN, own ledgers`);
  await rejects(createCustomer(r, { orgId, code: "CITYHOSP", name: "Dup", kind: "other" }), ConflictError, `${tag} duplicate customer code`);
  await rejects(createCustomer(r, { orgId, code: "BADGST", name: "Bad", kind: "other", gstin: "22ABC" }), ValidationError, `${tag} invalid GSTIN rejected`);
  const E = (await issueCustomerInvoice(r, { orgId, branchId: rpr.id, patientId: ravi.id, customerId: city.id, date: at("2026-03-07"), items: [CBC, SYR(10)] }, actor)).invoice;
  const F = (await issueCustomerInvoice(r, { orgId, branchId: rpr.id, patientId: asha.id, customerId: mum.id, date: at("2026-03-07"), items: [CBC, SYR(5)], payments: [{ amountPaise: 45500, mode: "netbanking", reference: "UTR778899" }] }, actor)).invoice;
  ok(E.customerId === city.id && E.placeOfSupply === "22" && E.buyerGstin === "22AABCC1234D1Z5", `${tag} B2B invoice carries customer, place of supply and GSTIN`);
  const fSales = (await r.vouchers.find({ invoiceId: F.id, type: "sales" }))[0]!;
  ok(F.placeOfSupply === "27" && fSales.entries.find((e) => e.ledgerId === igstL)?.creditPaise === 600 && !fSales.entries.some((e) => e.ledgerId === cgstL), `${tag} inter-state (Chhattisgarh → Maharashtra): IGST Rs 6.00`);
  ok(fSales.entries.find((e) => e.debitPaise === F.totalPaise)?.ledgerId === mum.ledgerId, `${tag} B2B sales voucher debits the customer's own ledger`);
  await rejects(issueCustomerInvoice(r, { orgId, branchId: rpr.id, patientId: ravi.id, customerId: city.id, date: at("2026-03-08"), items: [LFT, LFT, LFT] }, actor), CreditLimitError, `${tag} credit limit: Rs ${E.totalPaise / 100} outstanding + Rs 1,947 > Rs 2,000 refused`);
  const KIT = { code: "KIT", name: "Reagent kit (bulk)", category: "consumable" as const, ratePaise: 1_10_000_00 };
  const G = await bill(rpr.id, kavita.id, "2026-03-08", [KIT], [{ mode: "cheque" }], { placeOfSupply: "27" });
  const H = await bill(rpr.id, ravi.id, "2026-03-09", [ESR]);
  const { cancelInvoice } = await import("@mgpl-diagnostics/db-kit");
  await cancelInvoice(r, H.id, "duplicate", actor);
  ok(G.totalPaise === 1_23_200_00 && G.taxPaise === 13_200_00, `${tag} B2C large candidate: Rs 1,23,200 inter-state to an unregistered buyer`);

  // credit notes
  console.log(`${tag} credit notes`);
  const march = monthRange("2026-03");
  const taxBefore = await outputTax(r, orgId, march.from, march.to);
  const cn1 = await issueCreditNote(r, { orgId, invoiceId: E.id, reason: "rate correction on syringes", lines: [{ itemIndex: 1, taxablePaise: 5000 }], date: at("2026-03-20") }, actor);
  ok(cn1.creditNote.taxPaise === 600 && cn1.creditNote.cgstPaise === 300 && cn1.creditNote.totalPaise === 5600 && cn1.invoice.creditedPaise === 5600 && cn1.invoice.duePaise === E.totalPaise - 5600, `${tag} partial credit note: Rs 50 + 12% GST; the invoice owes Rs 56 less`);
  ok(/^MGPL\/RPR01\/CN\/2025-26\/000001$/.test(cn1.creditNote.noteNo), `${tag} credit note number ${cn1.creditNote.noteNo}`);
  const cn2 = await issueCreditNote(r, { orgId, invoiceId: B.id, reason: "sample not collected", date: at("2026-03-21") }, actor);
  ok(cn2.creditNote.totalPaise === B.totalPaise && cn2.creditNote.roundOffPaise === -40 && cn2.refundablePaise === B.totalPaise, `${tag} full credit note equals the invoice total (round-off reversed); Rs ${B.totalPaise / 100} refundable`);
  await rejects(issueCreditNote(r, { orgId, invoiceId: B.id, reason: "again" }), ConflictError, `${tag} a fully credited invoice cannot be credited again`);
  await rejects(issueCreditNote(r, { orgId, invoiceId: E.id, reason: "too much", lines: [{ itemIndex: 1, taxablePaise: 999999 }], date: at("2026-03-22") }), ValidationError, `${tag} credit above what is left of a line refused`);
  const taxAfter = await outputTax(r, orgId, march.from, march.to);
  ok(taxBefore.cgst - taxAfter.cgst === 300 + 120 && taxBefore.sgst - taxAfter.sgst === 300 + 120 && taxAfter.igst === taxBefore.igst, `${tag} credit notes reduce output tax (CGST and SGST −Rs 4.20 each)`);

  // ---------------------------------------------------------------- March at the collection centre, settlement
  const I1 = await bill(bls.id, asha.id, "2026-03-10", [CBC, { ...LFT, discountPaise: 4900 }], [{ mode: "cash" }], { billDiscountPaise: 5000 });
  await addAgreement(r, { orgId, partnerId: partner.id, kind: "fixed_rate", rates: [{ code: "CBC", sharePaise: 8000 }], defaultSharePaise: 5000, effectiveFrom: "2026-03-16" }, actor);
  await rejects(addAgreement(r, { orgId, partnerId: partner.id, kind: "revenue_share", shareBp: 3000, effectiveFrom: "2026-03-01", effectiveTo: "2026-03-20" }), ConflictError, `${tag} overlapping agreements refused`);
  await bill(bls.id, kavita.id, "2026-03-20", [CBC, ESR], [{ mode: "cash" }]);
  await issueCreditNote(r, { orgId, invoiceId: I1.id, reason: "LFT price correction", lines: [{ itemIndex: 1, taxablePaise: 20000 }], date: at("2026-03-25") }, actor);
  const mar = await createSettlement(r, { orgId, partnerId: partner.id, period: "2026-03", deductions: [{ label: "Courier", amountPaise: 1500 }] }, actor);
  ok(mar.lines.length === 5 && mar.grossPaise === 124700, `${tag} March: 4 test lines + 1 credit note line; net billed Rs 1,247`);
  ok(mar.sharePaise === 9476 + 14249 + 8000 + 5000 - 5000, `${tag} agreement changed mid-month: 25% before the 16th, fixed rates after; credit note takes back 25% (Rs ${mar.sharePaise / 100})`);
  ok(mar.tdsBasePaise === 31725 + 9975 && mar.tdsPaise === 800 && mar.tdsSection === "194H" && mar.tdsRateBp === 200, `${tag} TDS: threshold crossed, deducted on the year so far (Rs 417 × 2% = 8.34 → Rs 8)`);
  ok(mar.netPaise === 31725 - 1500 - 800, `${tag} net payable = share − courier − TDS = Rs ${mar.netPaise / 100}`);
  await rejects(accrueSettlement(r, { orgId, settlementId: mar.id, now: at("2026-03-31", "12:00") }, actor), ConflictError, `${tag} a month cannot be accrued before it ends`);
  const marAcc = await accrueSettlement(r, { orgId, settlementId: mar.id }, actor);
  const accV = (await r.vouchers.get(marAcc.accrualVoucherId!))!;
  const tdsL = (await r.ledgers.findBySystemKey(orgId, "tds_payable"))!.id;
  ok(accV.date.toISOString() === march.to.toISOString() && accV.entries.find((e) => e.ledgerId === tdsL)?.creditPaise === 800, `${tag} accrual journal on 31 March: Cr TDS Payable Rs 8`);
  ok((await ledgerBalance(r, { orgId, ledgerId: partner.ledgerId })) === -(9975 + mar.netPaise), `${tag} partner payable = February share + March net`);

  // ---------------------------------------------------------------- bank reconciliation (before cash closing locks those days)
  console.log(`${tag} bank reconciliation`);
  const bankL = (await r.ledgers.findBySystemKey(orgId, "bank"))!;
  const fee = applyBp(42100, 180);
  const lines = [
    ["06/03/2026", "CARD SETTLEMENT BATCH 0306", "CRD0306", "", (42100 - fee) / 100],
    ["06/03/2026", "UPI SETTLEMENT 0306", "UPI0306", "", 399],
    ["08/03/2026", "NEFT WESTERN PATH LABS", "UTR778899", "", 455],
    ["09/03/2026", "SMS / ACCOUNT CHARGES", "", 59, ""],
  ] as const;
  let bal = 0;
  const csvRows = lines.map(([d, desc, ref, dr, cr]) => {
    bal += Math.round(Number(cr || 0) * 100) - Math.round(Number(dr || 0) * 100);
    return [d, desc, ref, dr === "" ? "" : Number(dr).toFixed(2), cr === "" ? "" : Number(cr).toLocaleString("en-IN", { minimumFractionDigits: 2 }), (bal / 100).toFixed(2)];
  });
  const statementCsv = `Account Statement\r\nAccount No,XXXX1234\r\n\r\n${toCsv(["Date", "Narration", "Chq./Ref.No.", "Withdrawal Amt.", "Deposit Amt.", "Closing Balance"], csvRows)}Total,,,,,\r\n`;
  const parsed = parseBankCsv(statementCsv);
  ok(parsed.length === 4 && parsed[0]!.creditPaise === 42100 - fee && parsed[3]!.debitPaise === 5900 && parsed[2]!.reference === "UTR778899", `${tag} bank CSV parsed past the preamble (4 lines)`);
  const imp = await importBankStatement(r, { orgId, branchId: rpr.id, ledgerId: bankL.id, fileName: "march.csv", csv: statementCsv }, actor);
  const again = await importBankStatement(r, { orgId, branchId: rpr.id, ledgerId: bankL.id, fileName: "march.csv", csv: statementCsv }, actor);
  ok(imp.added === 4 && again.added === 0 && again.skipped === 4, `${tag} re-importing the same statement adds nothing`);
  const rec = await reconcileBank(r, { orgId, ledgerId: bankL.id }, actor);
  ok(rec.matched === 1 && rec.settlements === 2 && rec.unmatched === 1, `${tag} reconcile: NEFT matched to its receipt, card and UPI batches settled, charges left open`);
  const chargesL = (await r.ledgers.findBySystemKey(orgId, "bank_charges"))!;
  ok((await ledgerBalance(r, { orgId, ledgerId: chargesL.id })) === fee, `${tag} card MDR posted to Bank Charges (Rs ${fee / 100})`);
  const cardL = (await r.ledgers.findBySystemKey(orgId, "card"))!, upiL = (await r.ledgers.findBySystemKey(orgId, "upi"))!;
  ok((await ledgerBalance(r, { orgId, ledgerId: cardL.id, asOf: at("2026-03-10") })) === 0 && (await ledgerBalance(r, { orgId, ledgerId: upiL.id, asOf: at("2026-03-10") })) === 0, `${tag} card and UPI clearing ledgers settled to zero`);
  const brs = await bankReconciliation(r, { orgId, ledgerId: bankL.id, asOf: at("2026-03-10") });
  ok(brs.bankPaise === bal && brs.depositsNotCreditedPaise === G.totalPaise && brs.bankDebitsNotInBooksPaise === 5900 && brs.differencePaise === 0, `${tag} BRS: bank Rs ${bal / 100} = books + cheque not yet credited − charges not in books (difference 0)`);
  ok((await reconcileBank(r, { orgId, ledgerId: bankL.id }, actor)).matched === 0, `${tag} reconciling again matches nothing twice`);

  // ---------------------------------------------------------------- cash closing
  console.log(`${tag} day-end cash closing`);
  const short = await closeCashDay(r, { orgId, branchId: rpr.id, day: "2026-03-05", countedPaise: 38900, denominations: [{ valuePaise: 50000, count: 0 }, { valuePaise: 10000, count: 3 }, { valuePaise: 100, count: 89 }] }, actor);
  ok(short.bookPaise === A.totalPaise && short.differencePaise === -1000 && short.voucherId, `${tag} 5 March: book Rs 399, counted Rs 389 → Rs 10 short posted`);
  await rejects(jv(at("2026-03-05", "18:00")), PeriodLockedError, `${tag} a closed day rejects new postings`);
  await rejects(closeCashDay(r, { orgId, branchId: rpr.id, day: "2026-03-05", countedPaise: 38900 }, actor), ConflictError, `${tag} a day cannot be closed twice`);
  await rejects(closeCashDay(r, { orgId, branchId: rpr.id, day: "2026-03-04", countedPaise: 0 }, actor), ConflictError, `${tag} days close in order`);
  await rejects(closeCashDay(r, { orgId, branchId: rpr.id, day: "2026-03-06", countedPaise: 100, denominations: [{ valuePaise: 100, count: 2 }] }, actor), ValidationError, `${tag} denominations must add up to the count`);
  const excess = await closeCashDay(r, { orgId, branchId: rpr.id, day: "2026-03-06", countedPaise: 38900 + D.totalPaise + 100 }, actor);
  ok(excess.differencePaise === 100 && excess.bookPaise === 38900 + D.totalPaise, `${tag} 6 March: book carries the counted cash forward; Re 1 excess posted`);
  const cse = (await r.ledgers.findBySystemKey(orgId, "cash_short_excess"))!;
  ok((await ledgerBalance(r, { orgId, ledgerId: cse.id })) === 1000 - 100, `${tag} Cash Short / Excess = Rs 10 short − Re 1 excess`);
  ok((await jv(at("2026-03-05", "12:00"), bls.id)).status === "posted", `${tag} other branches stay open`);
  const blsCash = await ledgerBalance(r, { orgId, ledgerId: cash.id, branchId: bls.id, asOf: march.to });
  const blsClose = await closeCashDay(r, { orgId, branchId: bls.id, day: "2026-03-31", countedPaise: blsCash }, actor);
  ok(blsClose.differencePaise === 0 && blsClose.voucherId === null, `${tag} 31 March at the collection centre: no difference, no voucher`);
  await booksBalance(r, orgId, tag, "after March");

  // ---------------------------------------------------------------- returns
  console.log(`${tag} GSTR-1 / GSTR-3B`);
  const g1 = await gstr1(r, { orgId, from: march.from, to: march.to });
  ok(g1.gstin === "22AAAAA0000A1Z5" && g1.b2b.length === 2 && g1.b2b.every((x) => x.items.length === 1 && x.items[0]!.ratePercent === 12), `${tag} B2B: 2 invoices, taxable lines only`);
  ok(g1.b2b.find((x) => x.ctin.startsWith("27"))?.items[0]!.igstPaise === 600 && g1.b2b.find((x) => x.ctin.startsWith("22"))?.items[0]!.cgstPaise === 600, `${tag} B2B: IGST for Maharashtra, CGST/SGST for Chhattisgarh`);
  ok(g1.b2cl.length === 1 && g1.b2cl[0]!.invoiceNo === G.invoiceNo && g1.b2cl[0]!.placeOfSupply === "27", `${tag} B2C Large: the Rs 1,23,200 inter-state invoice`);
  ok(g1.b2cs.length === 0 && !g1.hsn.b2c.some((x) => x.hsnSac === "9018"), `${tag} B2C Small: B's syringes netted out by its credit note (no zero rows)`);
  ok(g1.cdnr.length === 1 && g1.cdnr[0]!.items[0]!.taxablePaise === 5000 && g1.cdnur.length === 0, `${tag} CDNR: the B2B credit note`);
  const nilUnreg = g1.nil.find((x) => x.description === "Intra-state supplies to unregistered persons")!;
  ok(nilUnreg.exemptedPaise === A.totalPaise + C.totalPaise + D.totalPaise + 39900 /* B's CBC credited */ - 39900 + I1.items.length * 0 + (37903 + 56997 - 20000) + 39900 + 9900, `${tag} nil/exempt: exempt supplies to unregistered persons Rs ${nilUnreg.exemptedPaise / 100} (net of credit notes)`);
  const docInv = g1.docs.find((d) => d.nature === "Invoices for outward supply" && d.series === "MGPL/RPR01/2025-26/")!;
  ok(docInv.total === 8 && docInv.cancelled === 1 && docInv.net === 7 && g1.docs.some((d) => d.nature === "Credit Note" && d.total === 2 && d.series === "MGPL/RPR01/CN/2025-26/"), `${tag} document summary: RPR01 invoices 8 issued, 1 cancelled; 2 credit notes`);
  const taxNow = await outputTax(r, orgId, march.from, march.to);
  ok(g1.totals.cgstPaise === taxNow.cgst && g1.totals.sgstPaise === taxNow.sgst && g1.totals.igstPaise === taxNow.igst, `${tag} GSTR-1 tax reconciles with the output GST ledgers (CGST ${taxNow.cgst}, SGST ${taxNow.sgst}, IGST ${taxNow.igst})`);
  const hsnTax = [...g1.hsn.b2b, ...g1.hsn.b2c].reduce((s, h) => s + h.igstPaise + h.cgstPaise + h.sgstPaise, 0);
  ok(hsnTax === taxNow.cgst + taxNow.sgst + taxNow.igst && g1.hsn.b2c.some((h) => h.hsnSac === "999316" && h.taxability === "exempt"), `${tag} HSN/SAC summary covers every line (exempt SAC 999316 too); its tax equals the ledgers`);
  const g3 = await gstr3b(r, { orgId, from: march.from, to: march.to });
  ok(g3.outwardTaxable.taxablePaise === g1.totals.taxablePaise && g3.outwardTaxable.igstPaise === g1.totals.igstPaise && g3.outwardTaxable.cgstPaise === g1.totals.cgstPaise, `${tag} GSTR-3B 3.1(a) = GSTR-1 totals`);
  ok(g3.outwardNilExemptPaise === g1.nil.reduce((s, x) => s + x.nilRatedPaise + x.exemptedPaise, 0) && g3.interStateUnregistered.length === 1 && g3.interStateUnregistered[0]!.igstPaise === G.taxPaise, `${tag} GSTR-3B 3.1(c) and 3.2 (inter-state to unregistered by place of supply)`);
  const invoicesTax = (await r.invoices.listByDate({ orgId, from: march.from, to: march.to })).reduce((s, i) => s + i.taxPaise, 0);
  const notesTax = (await r.creditNotes.listByDate({ orgId, from: march.from, to: march.to })).reduce((s, n) => s + n.taxPaise, 0);
  ok(invoicesTax - notesTax === hsnTax, `${tag} returns reconcile with invoices: Σ invoice tax − Σ credit-note tax = ${hsnTax}`);
  ok(g1.verifyWithCA.length > 0, `${tag} returns carry the verify-with-CA list`);

  // ---------------------------------------------------------------- exports (golden files)
  console.log(`${tag} exports`);
  const fy = fyRange("2025-26");
  const day = await dayBookCsv(r, { orgId, from: fy.from, to: fy.to });
  golden(tag, "day-book", day);
  const dbTot = csvRow(day, "TOTAL (posted)")!;
  const posted = (await r.vouchers.listByDate({ orgId, from: fy.from, to: fy.to })).flatMap((v) => v.entries);
  ok(paise(dbTot[5]) === posted.reduce((s, e) => s + e.debitPaise, 0) && paise(dbTot[5]) === paise(dbTot[6]), `${tag} day book totals = posted vouchers (Dr = Cr)`);
  const tbCsv = await trialBalanceCsv(r, { orgId, asOf: fy.to });
  golden(tag, "trial-balance", tbCsv);
  const tb = await trialBalance(r, { orgId, asOf: fy.to });
  ok(paise(csvRow(tbCsv, "TOTAL")![3]) === tb.totalDebitPaise && paise(csvRow(tbCsv, "TOTAL")![4]) === tb.totalCreditPaise, `${tag} trial balance export totals = report`);
  const plCsv = await profitAndLossCsv(r, { orgId, from: fy.from, to: fy.to });
  golden(tag, "profit-and-loss", plCsv);
  const pl = await profitAndLoss(r, { orgId, from: fy.from, to: fy.to });
  ok(paise(csvRow(plCsv, "Net profit")![3]) === pl.netProfitPaise, `${tag} P&L export net profit = report (Rs ${pl.netProfitPaise / 100})`);
  const bsCsv = await balanceSheetCsv(r, { orgId, asOf: fy.to });
  golden(tag, "balance-sheet", bsCsv);
  const bs = await balanceSheet(r, { orgId, asOf: fy.to });
  ok(paise(csvRow(bsCsv, "TOTAL assets")![3]) === bs.totalAssetsPaise && paise(csvRow(bsCsv, "TOTAL liabilities")![3]) === bs.totalLiabilitiesPaise && bs.differencePaise === 0, `${tag} balance sheet export totals = report; balances`);
  const custCsv = await ledgerCsv(r, { orgId, ledgerId: city.ledgerId, from: fy.from, to: fy.to });
  golden(tag, "ledger-city-care-hospital", custCsv);
  const g1csv = gstr1Csv(g1);
  for (const [k, v] of Object.entries(g1csv)) golden(tag, `gstr1-${k}`, v);
  const t = csvRow(g1csv.b2b, "TOTAL")!;
  ok(paise(t[7]) === g1.b2b.reduce((s, x) => s + x.items.reduce((a, i) => a + i.taxablePaise, 0), 0), `${tag} GSTR-1 B2B export total = report`);
  ok(paise(csvRow(g1csv.hsn, "TOTAL")![7]) + paise(csvRow(g1csv.hsn, "TOTAL")![8]) + paise(csvRow(g1csv.hsn, "TOTAL")![9]) === hsnTax, `${tag} GSTR-1 HSN export tax = report`);
  golden(tag, "gstr3b", gstr3bCsv(g3));
  const sCsv = await settlementCsv(r, { orgId, settlementId: mar.id });
  golden(tag, "settlement-2026-03", sCsv);
  ok(paise(csvRow(sCsv, "NET PAYABLE")![5]) === mar.netPaise, `${tag} settlement export net = settlement`);

  // ---------------------------------------------------------------- year-end close
  console.log(`${tag} year-end close`);
  const plBefore = await profitAndLoss(r, { orgId, from: fy.from, to: fy.to });
  await rejects(closeFinancialYear(r, { orgId, fy: "2026-27", now: at("2027-03-31", "23:00") }, actor), ConflictError, `${tag} a year that has not ended cannot be closed`);
  const closed = await closeFinancialYear(r, { orgId, fy: "2025-26" }, actor);
  ok(closed.vouchers.length === 2 && closed.vouchers.every((v) => v.type === "closing" && v.voucherNo.startsWith("CLS/2025-26/")) && closed.netProfitPaise === plBefore.netProfitPaise, `${tag} closing vouchers per branch (incl. BLS01, whose 31 March cash day was closed); result Rs ${closed.netProfitPaise / 100}`);
  ok((await lockDateFor(r, orgId))?.toISOString() === fy.to.toISOString() && (await lockDateFor(r, orgId, bls.id))?.toISOString() === fy.to.toISOString(), `${tag} the year is locked; BLS01's own lock is restored`);
  const nextDay = startOfIstDay("2026-04-01");
  const tbNext = await trialBalance(r, { orgId, asOf: nextDay });
  ok(tbNext.rows.every((x) => x.primaryGroup.nature !== "income" && x.primaryGroup.nature !== "expenses") && tbNext.differencePaise === 0, `${tag} next year opens with P&L ledgers at zero`);
  const re = (await r.ledgers.findBySystemKey(orgId, "retained_earnings"))!;
  ok((await ledgerBalance(r, { orgId, ledgerId: re.id, asOf: nextDay })) === -plBefore.netProfitPaise, `${tag} the result moved to Profit & Loss A/c (Reserves & Surplus)`);
  ok(tbNext.rows.find((x) => x.ledger.id === city.ledgerId)?.debitPaise === (await ledgerBalance(r, { orgId, ledgerId: city.ledgerId, asOf: fy.to })), `${tag} balance-sheet ledgers carry forward (City Care Hospital)`);
  const bsNext = await balanceSheet(r, { orgId, asOf: nextDay });
  ok(bsNext.differencePaise === 0 && bsNext.profitPaise === 0, `${tag} opening balance sheet balances with no current-year profit`);
  ok((await profitAndLoss(r, { orgId, from: fy.from, to: fy.to })).netProfitPaise === plBefore.netProfitPaise, `${tag} the closed year's P&L still shows its result`);
  await rejects(closeFinancialYear(r, { orgId, fy: "2025-26" }, actor), ConflictError, `${tag} a year closes once`);
  await rejects(jv(at("2026-03-31", "11:00"), bls.id), PeriodLockedError, `${tag} nothing posts into the closed year`);
  await booksBalance(r, orgId, tag, "after year end");

  // ---------------------------------------------------------------- FY 2026-27: payments, statements, concurrency
  console.log(`${tag} receivables and concurrency (FY 2026-27)`);
  await recordPayment(r, { invoiceId: B.id, amountPaise: cn2.refundablePaise, mode: "card", kind: "refund" }, actor);
  const bAfter = (await r.invoices.get(B.id))!;
  const recvL = (await r.ledgers.findBySystemKey(orgId, "receivables"))!.id;
  const bVouchers = new Set((await r.vouchers.find({ orgId })).filter((v) => v.narration?.includes(B.invoiceNo)).map((v) => v.id));
  const bNet = (await r.ledgerEntries.list({ orgId, ledgerId: recvL })).filter((e) => bVouchers.has(e.voucherId)).reduce((s, e) => s + e.debitPaise - e.creditPaise, 0);
  ok(bAfter.status === "refunded" && bAfter.duePaise === 0 && bVouchers.size === 4 && bNet === 0, `${tag} refund after a full credit note: invoice refunded; its receivable nets to zero (sale, receipt, credit note, refund)`);
  const stmt = await customerStatement(r, { orgId, customerId: city.id, from: fy.from, to: at("2026-05-20") });
  ok(stmt.closingPaise === E.totalPaise - 5600 && stmt.openTotalPaise === stmt.closingPaise && stmt.open[0]!.dueDay === "2026-04-06" && stmt.ageing["31-60"] === stmt.closingPaise, `${tag} customer statement: closing = open items; due 6 April, 44 days overdue on 20 May`);
  await recordPayment(r, { invoiceId: E.id, amountPaise: 10000, mode: "netbanking", reference: "CHQ-PART" }, actor);
  const stmt2 = await customerStatement(r, { orgId, customerId: city.id, from: fy.from, to: new Date() });
  ok(stmt2.closingPaise === E.totalPaise - 5600 - 10000 && stmt2.rows.at(-1)!.creditPaise === 10000 && stmt2.openingPaise === 0, `${tag} a payment lands on the customer's ledger (bill-wise against the invoice)`);
  const summary = await receivablesSummary(r, { orgId, asOf: new Date() });
  ok(summary.rows.length === 2 && summary.totalPaise === stmt2.closingPaise, `${tag} receivables summary across customers`);

  // credit limit under concurrency: each invoice fits alone, not both
  await r.customers.update(city.id, { creditLimitPaise: stmt2.closingPaise + 50000 });
  const race = await Promise.allSettled([0, 1].map(() => issueCustomerInvoice(r, { orgId, branchId: rpr.id, patientId: ravi.id, customerId: city.id, date: at("2026-04-10"), items: [CBC] }, actor)));
  ok(race.filter((x) => x.status === "fulfilled").length === 1 && race.some((x) => x.status === "rejected" && x.reason instanceof CreditLimitError), `${tag} concurrent B2B invoices: the customer lock lets one through, the other hits the limit`);

  // a lock moved while a B2B invoice is in flight: the invoice waits, then fails
  let held!: () => void;
  const holding = new Promise<void>((res) => (held = res));
  const mover = r.transaction(async (tx) => {
    const [l] = await tx.periodLocks.hold(orgId, ["org"], "update");
    held();
    await sleep(300);
    await tx.periodLocks.update(l!.id, { lockedUpTo: endOfIstDay("2026-04-30") });
  });
  await holding;
  await rejects(issueCustomerInvoice(r, { orgId, branchId: rpr.id, patientId: ravi.id, customerId: mum.id, date: at("2026-04-20"), items: [ESR] }, actor), PeriodLockedError, `${tag} concurrent lock date: an in-flight invoice in the newly locked month fails`);
  await mover;
  ok((await r.invoices.listByDate({ orgId, customerId: mum.id, from: startOfIstDay("2026-04-01") })).length === 0, `${tag} …and leaves no invoice behind`);
  await setLockDate(r, { orgId, upTo: "2026-03-31", reason: "back to the year end" }, actor);

  // cash closing racing a cash invoice: whichever wins, the closing's book is exactly the day's cash
  await bill(rpr.id, kavita.id, "2026-04-15", [CBC], [{ mode: "cash" }]);
  const [closing, late] = await Promise.allSettled([
    closeCashDay(r, { orgId, branchId: rpr.id, day: "2026-04-15", countedPaise: 0 }, actor),
    bill(rpr.id, asha.id, "2026-04-15", [ESR], [{ mode: "cash" }]),
  ]);
  const book = await ledgerBalance(r, { orgId, ledgerId: cash.id, branchId: rpr.id, asOf: endOfIstDay("2026-04-15") });
  ok(closing.status === "fulfilled" && closing.value.bookPaise + (closing.value.differencePaise < 0 ? 0 : 0) === book - closing.value.differencePaise
    && (late.status === "fulfilled" || late.reason instanceof PeriodLockedError), `${tag} cash closing vs a concurrent cash bill: the counted book is exact (${late.status === "fulfilled" ? "bill first" : "bill refused"})`);

  // payout of the March settlement
  const paid = await paySettlement(r, { orgId, settlementId: mar.id, mode: "netbanking", date: at("2026-04-05"), reference: "NEFT-P1" }, actor);
  ok(paid.status === "paid" && (await ledgerBalance(r, { orgId, ledgerId: partner.ledgerId })) === -9975, `${tag} payout voucher clears March; February's share stays payable`);
  await rejects(paySettlement(r, { orgId, settlementId: mar.id, mode: "cash" }, actor), ConflictError, `${tag} a settlement is paid once`);
  await rejects(customerStatement(r, { orgId, customerId: "00000000-0000-4000-8000-000000000000", from: fy.from, to: fy.to }), NotFoundError, `${tag} unknown customer → NotFoundError`);
  // another organisation's ids never reach this one's records (orgId comes from the session, never from the client)
  const other = await seedOrganization(r, {
    org: { name: "Other Lab", code: "OTH" }, branch: { code: "OTH01", name: "Other", stateCode: "22" },
    owner: { name: "Other Owner", email: "other@example.com", passwordHash: "scrypt$test" },
  });
  const o = other.org.id;
  await rejects(issueCreditNote(r, { orgId: o, invoiceId: B.id, reason: "x" }), NotFoundError, `${tag} tenancy: credit note on another organisation's invoice → NotFoundError`);
  await rejects(cancelSettlement(r, { orgId: o, settlementId: feb.id }, actor), NotFoundError, `${tag} tenancy: another organisation's settlement → NotFoundError`);
  await rejects(settlementCsv(r, { orgId: o, settlementId: mar.id }), NotFoundError, `${tag} tenancy: another organisation's settlement export → NotFoundError`);
  await rejects(ledgerCsv(r, { orgId: o, ledgerId: city.ledgerId, from: fy.from, to: fy.to }), NotFoundError, `${tag} tenancy: another organisation's ledger export → NotFoundError`);
  await rejects(customerStatement(r, { orgId: o, customerId: city.id, from: fy.from, to: fy.to }), NotFoundError, `${tag} tenancy: another organisation's customer → NotFoundError`);
  await booksBalance(r, orgId, tag, "end of scenario");
  assertFinancePosting(r);
}

// ------------------------------------------------------------------ the posting boundary

function postingBoundary() {
  console.log("\n[posting boundary]");
  const engine = /\b(postVoucher|cancelVoucher|seedChartOfAccounts|postInvoice|postPayment|unpostInvoice|trialBalance|profitAndLoss|balanceSheet|ledgerStatement|ledgerBalance|dayBook|cashBook|gstSummary)\b/;
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${f.name}`;
      if (f.isDirectory()) walk(p);
      else if (p !== "src/posting.ts" && p.endsWith(".ts")) {
        const imports = readFileSync(p, "utf8").match(/import[^;]*from\s+"@mgpl-diagnostics\/db-kit"/g) ?? [];
        if (imports.some((i) => engine.test(i))) offenders.push(p);
      }
    }
  };
  walk("src");
  ok(offenders.length === 0, `only src/posting.ts imports the accounting engine${offenders.length ? ` (also: ${offenders.join(", ")})` : ""}`);
}

// ------------------------------------------------------------------ main

async function main() {
  const t0 = Date.now();
  unitChecks();
  postingBoundary();

  const rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  const mongo = await createDb({ backend: "mongo", mongo: { uri: rs.getUri("finance_test") }, posting: financePosting });
  await scenario(mongo);

  rmSync(".pg-test", { recursive: true, force: true });
  const pg = new EmbeddedPostgres({ databaseDir: ".pg-test", user: "postgres", password: "postgres", port: 54331, persistent: false });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("finance_test");
  const pgdb = await createDb({ backend: "pg", pg: { url: "postgres://postgres:postgres@localhost:54331/finance_test" }, posting: financePosting });
  await scenario(pgdb);

  await mongo.close();
  await rs.stop();
  await pgdb.close();
  await pg.stop();
  rmSync(".pg-test", { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
