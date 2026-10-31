// Last price, including pre- and after-market, against the previous regular close (Yahoo chart API).
// Usage: node quote.mjs [--since YYYY-MM-DD] SYM...
const H = { headers: { "User-Agent": "Mozilla/5.0 (objective-market-analysis)" } };
const args = process.argv.slice(2);
const i = args.indexOf("--since");
const since = i >= 0 ? args.splice(i, 2)[1] : null;
const chart = async (s, q) => (await (await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?${q}`, H)).json()).chart.result[0];
const pct = (a, b) => `${a / b >= 1 ? "+" : ""}${((a / b - 1) * 100).toFixed(2)}%`;
const rows = await Promise.all(args.map(async (s) => {
  try {
    const d = await chart(s, "range=1mo&interval=1d");
    const off = d.meta.gmtoffset ?? 0;
    const days = d.timestamp.map((t, k) => [new Date((t + off) * 1000).toISOString().slice(0, 10), d.indicators.quote[0].close[k]]).filter((x) => x[1] != null);
    const m = await chart(s, "range=1d&interval=1m&includePrePost=true");
    const c = m.indicators.quote[0].close || [];
    let k = c.length - 1;
    while (k >= 0 && c[k] == null) k--;
    const last = k >= 0 ? c[k] : m.meta.regularMarketPrice;
    const at = k >= 0 ? new Date(m.timestamp[k] * 1000).toISOString().slice(11, 16) + "Z" : "-";
    const today = new Date((Date.now() / 1000 + off) * 1000).toISOString().slice(0, 10);
    const prev = days.filter((x) => x[0] < today).at(-1);
    const base = since ? days.filter((x) => x[0] <= since).at(-1) : null;
    return `${s.padEnd(10)} ${last.toFixed(2)} @${at} | cierre ${prev[0]} ${prev[1].toFixed(2)} ${pct(last, prev[1])}`
      + (base ? ` | vs ${base[0]} ${pct(last, base[1])}` : "")
      + ` | ${days.slice(-4).map((x) => x[0].slice(5) + " " + x[1].toFixed(2)).join(", ")}`;
  } catch (e) {
    return `${s} ERROR ${String(e).slice(0, 80)}`;
  }
}));
console.log(rows.join("\n"));
