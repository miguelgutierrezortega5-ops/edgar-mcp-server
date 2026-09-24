// Offline unit tests (no network): run with `npm test`. Live end-to-end checks: `npm run test:live`.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, test } from "node:test";

import { readFileSync } from "node:fs";

import { VERSION } from "../dist/constants.js";
import { summarizeDividends } from "../dist/services/dividends.js";
import { findSection } from "../dist/services/filings.js";
import { diffHoldings, parseInfoTable } from "../dist/services/holdings.js";
import { parseFredCsv, searchFred } from "../dist/services/macro.js";
import { buildStatement } from "../dist/services/statements.js";
import { parseForm4 } from "../dist/services/form4.js";
import { cached } from "../dist/services/http.js";
import { getYieldCurve, parseYieldCsv } from "../dist/services/treasury.js";
import { computeValuation, trailing } from "../dist/services/valuation.js";
import { conceptSeries, firstAvailable } from "../dist/services/xbrl.js";

// ---------- synthetic XBRL company facts ----------

let accn = 0;
const fact = (start, end, val, form = "10-Q", filed = end) => ({ start, end, val, form, filed, accn: String(++accn) });
const instant = (end, val, form = "10-Q", filed = end) => ({ end, val, form, filed, accn: String(++accn) });

function makeFacts(usGaap, dei = {}, currency = "USD") {
  const wrap = (facts, unit) => Object.fromEntries(Object.entries(facts).map(([k, v]) => [k, { label: k, units: { [k.includes("Shares") ? "shares" : unit]: v } }]));
  return { cik: 1, entityName: "Test Corp", facts: { "us-gaap": wrap(usGaap, currency), dei: wrap(dei, currency) } };
}

// Calendar-year company: Q1-Q3 reported discretely, Q4 only inside the 10-K annual total.
const quarters = (year, vals) => [
  fact(`${year}-01-01`, `${year}-03-31`, vals[0]),
  fact(`${year}-04-01`, `${year}-06-30`, vals[1]),
  fact(`${year}-07-01`, `${year}-09-30`, vals[2]),
  fact(`${year}-01-01`, `${year}-09-30`, vals[0] + vals[1] + vals[2]),
  fact(`${year}-01-01`, `${year}-12-31`, vals.reduce((a, b) => a + b, 0), "10-K", `${year + 1}-02-15`),
];

describe("xbrl", () => {
  test("derives fiscal Q4 from the annual total minus the nine-month YTD", () => {
    const facts = makeFacts({ Revenues: quarters(2025, [10, 20, 30, 40]) });
    const q = conceptSeries(facts, "Revenues", "quarterly");
    assert.equal(q.get("2025-12-31").val, 40);
    assert.equal(q.get("2025-12-31").derived, true);
    assert.equal(conceptSeries(facts, "Revenues", "annual").get("2025-12-31").val, 100);
  });

  test("latest filing wins for a restated period", () => {
    const facts = makeFacts({ Revenues: [fact("2025-01-01", "2025-03-31", 10), fact("2025-01-01", "2025-03-31", 12, "10-Q", "2026-05-01")] });
    assert.equal(conceptSeries(facts, "Revenues", "quarterly").get("2025-03-31").val, 12);
  });

  test("firstAvailable memoizes per facts object", () => {
    const facts = makeFacts({ Revenues: quarters(2025, [1, 2, 3, 4]) });
    assert.equal(firstAvailable(facts, ["Revenues"], "quarterly"), firstAvailable(facts, ["Revenues"], "quarterly"));
  });
});

describe("trailing", () => {
  test("sums four consecutive quarters", () => {
    const facts = makeFacts({ Revenues: [...quarters(2024, [1, 1, 1, 1]), ...quarters(2025, [10, 20, 30, 40])] });
    assert.deepEqual(trailing(facts, "revenue"), { value: 100, through: "2025-12-31", basis: "TTM", unit: "USD" });
  });

  test("falls back to the fiscal year when a quarter is missing", () => {
    // Q2 2025 missing: the last four quarters would span more than a year.
    const facts = makeFacts({
      Revenues: [
        ...quarters(2024, [1, 2, 3, 4]),
        fact("2025-01-01", "2025-03-31", 10),
        fact("2025-07-01", "2025-09-30", 30),
      ],
    });
    const t = trailing(facts, "revenue");
    assert.equal(t.basis, "FY");
    assert.equal(t.value, 10);
    assert.equal(t.through, "2024-12-31");
  });

  test("uses annual data for filers without quarters (20-F)", () => {
    const facts = makeFacts({ Revenues: [fact("2025-01-01", "2025-12-31", 500, "20-F", "2026-04-01")] });
    assert.deepEqual(trailing(facts, "revenue"), { value: 500, through: "2025-12-31", basis: "FY", unit: "USD" });
  });
});

describe("computeValuation", () => {
  const base = (dei = {}, currency = "USD") =>
    makeFacts(
      {
        Revenues: quarters(2025, [100, 100, 100, 100]),
        NetIncomeLoss: quarters(2025, [10, 10, 10, 10]),
        WeightedAverageNumberOfDilutedSharesOutstanding: [fact("2025-10-01", "2025-12-31", 50)],
        CashAndCashEquivalentsAtCarryingValue: [instant("2025-12-31", 30)],
        LongTermDebt: [instant("2025-12-31", 20)],
      },
      dei,
      currency,
    );

  test("computes market cap, EV and multiples", () => {
    const v = computeValuation({ facts: base({ EntityCommonStockSharesOutstanding: [instant("2026-01-20", 40, "10-K")] }), ticker: "TST", price: 10, priceCurrency: "USD", tickers: ["TST"] });
    assert.equal(v.sharesOutstanding, 40);
    assert.equal(v.marketCap, 400);
    assert.equal(v.enterpriseValue, 390);
    assert.equal(v.multiples.pe, 10);
    assert.equal(v.multiples.ps, 1);
    assert.deepEqual(v.warnings, []);
  });

  test("refuses to mix a USD share price with fundamentals in another currency (ADRs)", () => {
    assert.throws(() => computeValuation({ facts: base({}, "TWD"), ticker: "TSM", price: 400, priceCurrency: "USD", tickers: ["TSM"] }), /reports in TWD but TSM trades in USD/);
  });

  test("ignores a stale cover-page share count and flags several share classes", () => {
    const v = computeValuation({ facts: base({ EntityCommonStockSharesOutstanding: [instant("2011-02-17", 1_000, "10-K")] }), ticker: "BRK-B", price: 10, priceCurrency: "USD", tickers: ["BRK-A", "BRK-B"] });
    assert.equal(v.sharesOutstanding, 50);
    assert.match(v.sharesBasis, /weighted-average diluted/);
    assert.match(v.warnings[0], /Several share classes/);
  });

  test("refuses when only some inputs are in another currency (USD revenue, TWD cash)", () => {
    const facts = base();
    facts.facts["us-gaap"].CashAndCashEquivalentsAtCarryingValue = { units: { TWD: [instant("2025-12-31", 900)] } };
    assert.throws(() => computeValuation({ facts, ticker: "TSM", price: 10, priceCurrency: "USD", tickers: ["TSM"] }), /reports in TWD/);
  });

  test("refuses when no share count is current", () => {
    const facts = base({ EntityCommonStockSharesOutstanding: [instant("2011-02-17", 1_000, "10-K")] });
    facts.facts["us-gaap"].WeightedAverageNumberOfDilutedSharesOutstanding.units.shares = [fact("2015-07-01", "2015-09-30", 50)];
    assert.throws(() => computeValuation({ facts, ticker: "BRK-B", price: 10, priceCurrency: "USD", tickers: ["BRK-A", "BRK-B"] }), /No current share count.*latest is from 2015-09-30/);
  });

  test("refuses when price and share count are on different bases", () => {
    // 50 Class-A-equivalent shares priced at a Class B price: market cap 5 < TTM net income 40.
    assert.throws(() => computeValuation({ facts: base(), ticker: "BRK-B", price: 0.1, priceCurrency: "USD", tickers: ["BRK-A", "BRK-B"] }), /different bases/);
  });

  test("warns when a newer report is not yet in the XBRL data", () => {
    const v = computeValuation({ facts: base(), ticker: "TST", price: 10, priceCurrency: "USD", tickers: ["TST"], latestReport: { form: "10-Q", reportDate: "2026-03-31", filingDate: "2026-04-30" } });
    assert.match(v.warnings.join(" "), /not yet in the SEC's XBRL dataset/);
  });
});

describe("parseForm4", () => {
  const form4 = ({ box, notes = "", owners = ["DOE JANE"] }) => `<?xml version="1.0"?>
<ownershipDocument>
  ${box === undefined ? "" : `<aff10b5One>${box}</aff10b5One>`}
  ${owners.map((n) => `<reportingOwner><reportingOwnerId><rptOwnerName>${n}</rptOwnerName></reportingOwnerId><reportingOwnerRelationship><isOfficer>1</isOfficer><officerTitle>CFO</officerTitle></reportingOwnerRelationship></reportingOwner>`).join("")}
  <nonDerivativeTable>
    <nonDerivativeTransaction><transactionDate><value>2026-05-01</value></transactionDate><transactionCoding><transactionCode>S</transactionCode><footnoteId id="F1"/></transactionCoding>
      <transactionAmounts><transactionShares><value>100</value></transactionShares><transactionPricePerShare><value>10</value></transactionPricePerShare><transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode></transactionAmounts></nonDerivativeTransaction>
    <nonDerivativeTransaction><transactionDate><value>2026-05-02</value></transactionDate><transactionCoding><transactionCode>G</transactionCode><footnoteId id="F2"/></transactionCoding>
      <transactionAmounts><transactionShares><value>50</value></transactionShares><transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode></transactionAmounts></nonDerivativeTransaction>
  </nonDerivativeTable>
  <footnotes>${notes}</footnotes>
</ownershipDocument>`;
  const planNote = '<footnote id="F1">Effected pursuant to a Rule 10b5-1 trading plan adopted on May 22, 2026.</footnote><footnote id="F2">Gift to a family trust.</footnote>';

  test("credits the 10b5-1 checkbox only to transactions whose footnotes cite the plan", () => {
    const t = parseForm4(form4({ box: 1, notes: planNote }), "2026-05-03", "u");
    assert.deepEqual(t.map((x) => x.plan10b5_1), [true, false]);
    assert.equal(t[0].value, 1000);
    assert.equal(t[0].type, "Open-market sale");
    assert.equal(t[0].role, "CFO");
  });

  test("an unticked checkbox wins over footnotes", () => {
    assert.deepEqual(parseForm4(form4({ box: 0, notes: planNote }), "d", "u").map((x) => x.plan10b5_1), [false, false]);
  });

  test("older filings: 'not pursuant to a 10b5-1 plan' is not a plan trade", () => {
    const notes = '<footnote id="F1">This sale was not made pursuant to a Rule 10b5-1 trading plan.</footnote>';
    assert.deepEqual(parseForm4(form4({ notes }), "d", "u").map((x) => x.plan10b5_1), [false, false]);
    assert.deepEqual(parseForm4(form4({ notes: planNote }), "d", "u").map((x) => x.plan10b5_1), [true, false]);
  });

  test("lists every reporting owner", () => {
    assert.equal(parseForm4(form4({ owners: ["FUND A LP", "FUND B LLC"] }), "d", "u")[0].insider, "FUND A LP / FUND B LLC");
  });
});

describe("treasury yields", () => {
  const csv = (rows) => ['Date,"1 Mo","10 Yr"', ...rows].join("\n");
  let server;
  before(async () => {
    server = createServer((req, res) => {
      if (req.url.includes("/2026/")) res.end(csv(["01/05/2026,4.10,4.20", "01/02/2026,4.00,4.10"]));
      else if (req.url.includes("/2025/")) res.end(csv(["12/31/2025,3.90,4.05", "12/30/2025,3.80,4.00"]));
      else res.end("");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    process.env.EDGAR_MOCK_BASE = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => {
    delete process.env.EDGAR_MOCK_BASE;
    server.close();
  });

  test("parses the CSV newest first", () => {
    const rows = parseYieldCsv(csv(["12/30/2025,3.80,", "12/31/2025,3.90,4.05"]));
    assert.deepEqual(rows[0], { date: "2025-12-31", yields: { "1 Mo": 3.9, "10 Yr": 4.05 } });
    assert.equal(rows[1].yields["10 Yr"], null);
  });

  test("returns the closest trading day on or before the date", async () => {
    assert.equal((await getYieldCurve("2026-01-04")).date, "2026-01-02");
  });

  test("falls back to the previous year before the first trading day of January", async () => {
    const row = await getYieldCurve("2026-01-01");
    assert.equal(row.date, "2025-12-31");
    assert.equal(row.yields["10 Yr"], 4.05);
  });
});

describe("cached", () => {
  test("shares one in-flight load between concurrent callers", async () => {
    let loads = 0;
    const load = async () => {
      loads++;
      await new Promise((r) => setTimeout(r, 10));
      return { value: "v", size: 1 };
    };
    const results = await Promise.all([cached("k-dedup", 60_000, load), cached("k-dedup", 60_000, load), cached("k-dedup", 60_000, load)]);
    assert.deepEqual(results, ["v", "v", "v"]);
    assert.equal(await cached("k-dedup", 60_000, load), "v");
    assert.equal(loads, 1);
  });

  test("does not cache failures", async () => {
    let calls = 0;
    const load = async () => {
      if (++calls === 1) throw new Error("boom");
      return { value: 42, size: 1 };
    };
    await assert.rejects(cached("k-fail", 60_000, load), /boom/);
    assert.equal(await cached("k-fail", 60_000, load), 42);
  });
});

describe("findSection", () => {
  test("skips the table of contents and returns the body section", () => {
    const text = "Item 1A. Risk Factors 12\nItem 1B. Unresolved 20\n...\nItem 1A. Risk Factors\nOur business faces many risks. " + "x".repeat(500) + "\nItem 1B. Unresolved Staff Comments";
    const loc = findSection(text, "risk_factors");
    assert.ok(text.slice(loc.start, loc.end).includes("Our business faces many risks"));
  });
});

describe("units and currencies", () => {
  test("foreign filers read their home currency, not patchy USD convenience figures", () => {
    const facts = {
      cik: 2,
      entityName: "Foreign Co",
      facts: {
        "ifrs-full": {
          Revenue: {
            units: {
              TWD: [fact("2023-01-01", "2023-12-31", 2000, "20-F"), fact("2024-01-01", "2024-12-31", 2900, "20-F")],
              USD: [fact("2024-01-01", "2024-12-31", 90, "20-F")],
            },
          },
          CashAndCashEquivalents: { units: { TWD: [instant("2024-12-31", 1500, "20-F")], USD: [instant("2024-12-31", 47, "20-F")] } },
        },
      },
    };
    const t = buildStatement(facts, "income", "annual", 5);
    assert.equal(t.currency, "TWD");
    assert.deepEqual(t.rows.find((r) => r.key === "revenue").values, [2000, 2900]);
    const b = buildStatement(facts, "balance", "annual", 5);
    assert.deepEqual(b.rows.find((r) => r.key === "cash").values, [1500]);
  });

  test("US filers keep USD", () => {
    const t = buildStatement(makeFacts({ Revenues: quarters(2025, [1, 2, 3, 4]) }), "income", "annual", 5);
    assert.equal(t.currency, "USD");
  });
});

describe("13F", () => {
  const row = (issuer, cusip, value, shares, extra = "") =>
    `<ns1:infoTable><ns1:nameOfIssuer>${issuer}</ns1:nameOfIssuer><ns1:titleOfClass>COM</ns1:titleOfClass><ns1:cusip>${cusip}</ns1:cusip><ns1:value>${value}</ns1:value>` +
    `<ns1:shrsOrPrnAmt><ns1:sshPrnamt>${shares}</ns1:sshPrnamt><ns1:sshPrnamtType>SH</ns1:sshPrnamtType></ns1:shrsOrPrnAmt>${extra}</ns1:infoTable>`;
  const table = (...rows) => `<ns1:informationTable xmlns:ns1="x">${rows.join("")}</ns1:informationTable>`;

  test("merges rows of the same security and sorts by value", () => {
    const h = parseInfoTable(table(row("APPLE INC", "037833100", 100, 10), row("AT&amp;T INC", "00206R102", 500, 50), row("APPLE INC", "037833100", 50, 5)));
    assert.deepEqual(h.map((x) => [x.issuer, x.value, x.shares]), [["AT&T INC", 500, 50], ["APPLE INC", 150, 15]]);
  });

  test("keeps options apart from shares and scales pre-2023 values", () => {
    const h = parseInfoTable(table(row("NVIDIA", "67066G104", 7, 1), row("NVIDIA", "67066G104", 3, 1, "<ns1:putCall>Put</ns1:putCall>")), 1000);
    assert.equal(h.length, 2);
    assert.equal(h[0].value, 7000);
    assert.equal(h[1].putCall, "Put");
  });

  test("classifies changes versus the previous quarter", () => {
    const prev = parseInfoTable(table(row("A", "1", 10, 10), row("B", "2", 10, 10), row("C", "3", 10, 10)));
    const cur = parseInfoTable(table(row("A", "1", 20, 15), row("B", "2", 5, 5), row("D", "4", 1, 1)));
    const { changes, exited } = diffHoldings(cur, prev);
    assert.deepEqual(changes.map((c) => [c.holding.issuer, c.status, c.shareChange]), [["A", "added", 0.5], ["B", "reduced", -0.5], ["D", "new", null]]);
    assert.deepEqual(exited.map((h) => h.issuer), ["C"]);
  });
});

describe("FRED", () => {
  test("parses fredgraph CSV with missing values", () => {
    assert.deepEqual(parseFredCsv("observation_date,DGS10\n2026-09-04,4.78\n2026-09-07,\n2026-09-08,.\n"), [
      { date: "2026-09-04", value: 4.78 },
      { date: "2026-09-07", value: null },
      { date: "2026-09-08", value: null },
    ]);
  });

  test("rejects an HTML error page", () => {
    assert.throws(() => parseFredCsv("<!DOCTYPE html><html>"));
  });

  test("catalog search works without an API key", async () => {
    delete process.env.FRED_API_KEY;
    const res = await searchFred("treasury yield", 10);
    assert.equal(res.source, "catalog");
    assert.ok(res.hits.some((h) => h.id === "DGS10"));
  });
});

describe("dividends", () => {
  const pay = (date, amount) => ({ date, amount });
  test("TTM, yield, CAGR and streak", () => {
    const payments = [];
    for (let y = 2014; y <= 2025; y++) for (const m of ["03", "06", "09", "12"]) payments.push(pay(`${y}-${m}-15`, 0.25 * 1.05 ** (y - 2014)));
    payments.push(pay("2026-03-15", 0.5));
    const d = summarizeDividends(payments, 50, "2026-04-01");
    assert.equal(d.paymentsPerYear, 4);
    assert.ok(Math.abs(d.cagr5y - 0.05) < 1e-9);
    assert.equal(d.consecutiveIncreases, 11);
    assert.ok(Math.abs(d.ttm - (0.25 * 1.05 ** 11 * 3 + 0.5)) < 1e-9);
    assert.ok(Math.abs(d.ttmYield - d.ttm / 50) < 1e-12);
    assert.equal(d.annual.at(-1).partial, true);
  });

  test("a first partial year does not count as an increase", () => {
    const d = summarizeDividends([pay("2024-06-10", 0.2), pay("2024-09-10", 0.2), pay("2025-03-10", 0.2), pay("2025-06-10", 0.2), pay("2025-09-10", 0.2), pay("2025-12-10", 0.2)], 10, "2026-01-15");
    assert.equal(d.annual[0].partial, true);
    assert.equal(d.consecutiveIncreases, 0);
  });
});

test("VERSION matches package.json", () => {
  assert.equal(VERSION, JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
});
