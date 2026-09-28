# Global spillovers: markets outside the US and the EU

The user invests mainly in the US and the EU. Other markets matter **less, but not zero**: they move US and EU assets through trade, supply chains, commodities, currencies, funding and risk appetite. This file says when to bring them in, what to check, and with which verified symbols.

## When it is material

Add a "Global spillovers" section only if at least one of these holds; otherwise skip it or give it one line:

- A region is ≥10% of the company's revenue, or a named key market in its filings. Check Fiscal.ai `company_segments_and_kpis`, FMP `revenue-geographic-segments` or the 10-K segment note.
- A critical supplier, factory or input sits there (chips from Taiwan and Korea, rare earths from China, gas and oil from the Gulf, Norway or Russia).
- The company's funding, costs or listing is in another currency (JPY, CHF, GBP, CNY, MXN, BRL).
- It is a bank or insurer with foreign subsidiaries (e.g. Santander: Brazil, Mexico, UK; BBVA: Mexico, Turkey).
- A shock in that region is currently moving global markets (a yen carry-trade unwind, Chinese stimulus or property stress, an OPEC+ decision, an emerging-market currency crisis).

Scale the depth to the exposure. Rate each point **high / medium / low** relevance, and don't let the section outweigh the company's own fundamentals.

## The six transmission channels

1. **Trade and revenue.** Where customers are. Chinese demand for EU luxury goods, cars and machinery, and for US chips and phones.
2. **Supply chain.** Where inputs and production are: semiconductors, batteries, generic drugs, nearshoring to Mexico.
3. **Commodities and energy.**
   - Oil drives inflation and energy stocks.
   - European gas prices drive EU industry and utilities.
   - Copper and iron ore signal China's industrial cycle.
   - Wheat tracks food inflation.
4. **Currencies and rates.**
   - A strong dollar tightens conditions for emerging markets.
   - Rising yen and Japanese government bond (JGB) yields can pull money back to Japan and lift global long-term rates.
   - The Swiss franc is a safe haven.
   - UK gilt stress can spread to Europe (the 2022 pension-fund LDI crisis).
5. **Financial linkages.** Banks' subsidiaries in emerging markets, cross-border lending, sovereign risk.
6. **Risk appetite and time zones.** Asia trades first. Overnight moves in the Nikkei, Hang Seng, KOSPI, USD/JPY and USD/CNH set the tone for the European open, and the US session overlaps the European afternoon.

## Region checklist (every symbol and series below was verified)

Prices come from `market_get_stock_price` (Yahoo symbols); FRED series from `macro_get_series`. FRED monthly international series lag by about 1–2 months, so use `market_get_stock_price` for the latest level.

| Region | Why it matters for US/EU | What to check | Symbols / FRED IDs |
| --- | --- | --- | --- |
| **China and Hong Kong** | Demand for EU luxury goods, autos and machinery, and for US tech; metals; export controls and tariffs | Equity trend, the yuan, copper and iron ore, stimulus and property news; the company's China revenue share | `000001.SS`, `^HSI`, `FXI`, `USDCNY=X`, `CNH=X`, `DEXCHUS`, `PCOPPUSDM`, `PIORECRUSDM`, `HG=F`; `edgar_full_text_search` `"export controls"` |
| **Japan** | Yen carry trade, JGB yields feeding global long rates, and a large holder of US Treasuries | USD/JPY moves, 10-year JGB yield, Nikkei | `^N225`, `EWJ`, `USDJPY=X`, `DEXJPUS`, `IRLTLT01JPM156N` |
| **Korea and Taiwan** | They lead the semiconductor and AI hardware cycle (TSMC, Samsung, SK Hynix) | KOSPI and TAIEX trend, the won, TSMC results (`edgar_*` on `TSM`, a 20-F filer) | `^KS11`, `^TWII`, `DEXKOUS` |
| **UK, Switzerland, Norway** (non-EU Europe) | Large weights in European indices; gilts; the franc as a safe haven; oil and gas | FTSE and SMI trends, gilt yields, GBP and CHF moves | `^FTSE`, `^SSMI`, `IRLTLT01GBM156N`, `DEXUSUK`, `DEXSZUS`, `EURCHF=X` |
| **Energy: Gulf, OPEC+, Russia** | Oil and gas drive inflation, especially in the EU; sanctions | Brent, EU gas, US gas, wheat | `DCOILBRENTEU`, `BZ=F`, `PNGASEUUSDM`, `TTF=F`, `DHHNGSP`, `PWHEAMTUSDM` |
| **Mexico** | Nearshoring and USMCA; the peso as a liquid emerging-market proxy; Spanish banks' subsidiaries | IPC index, peso, country risk premium | `^MXX`, `DEXMXUS`; FMP `economics` `market-risk-premium` |
| **Brazil, Chile, Peru** | Commodities (iron ore, copper, soy); European banks and utilities | Bovespa, real, copper | `^BVSP`, `DEXBZUS`, `PCOPPUSDM` |
| **Canada** | USMCA, energy, banks | TSX trend | `^GSPTSE` |
| **India** | Growth market; IT outsourcing peer set (vs Accenture, Capgemini) | Nifty, rupee | `^NSEI`, `DEXINUS` |
| **Australia** | A proxy for China's commodity demand | ASX 200 | `^AXJO` |
| **Emerging markets overall** | Dollar strength and credit stress | Dollar index, EM corporate spread, EM equities | `DX-Y.NYB`, `DTWEXBGS`, `BAMLEMCBPIOAS`, `EEM` |

For annual structure by country (GDP growth, inflation, debt, current account), use `macro_get_country_indicator` (World Bank). For country risk, FMP `economics` → `market-risk-premium` gives each country's risk premium and total equity risk premium.

## How to quantify it cheaply

1. **Exposure.** Revenue share by region from segments; name the supply-chain and currency exposures from the 10-K or annual report.
2. **Sensitivity.** Compute in code, from `market_get_stock_price` history, the 1-year correlation and beta of the stock (or its index) against the regional proxy. Use daily or weekly returns and align dates first. Alpha Vantage `ANALYTICS_FIXED_WINDOW` can do this too, but it spends quota.
3. **Current reading.** The latest level and the 1-month and 3-month change of each relevant proxy.
4. **Events.** Fiscal.ai `top_news` (e.g. `eventType: "regulatory"`) and `company_news` for the region. Use TipRanks only when it's worth the scarce quota.

## Output format

A short section at the end of the analysis:

**Global spillovers (secondary)**
- *Channel → region*: current reading (number, date, source) → likely direction for the holding → relevance (high/medium/low).
- 3–6 bullets at most. Say plainly when no channel is material.

Example of the level of detail (illustrative, not real data): "*Revenue → China*: 18% of sales (FY2025); Hang Seng −6% in 3 months (Yahoo, to 2026-09-25) → pressure on luxury demand → relevance **medium**."
