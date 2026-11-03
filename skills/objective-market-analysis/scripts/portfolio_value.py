#!/usr/bin/env python3
"""Value a portfolio file at Yahoo's latest prices, in the account currency (MXN by default).

The file is JSON and stays outside the repository (it holds the user's positions):
  {"efectivo_reporto_mxn": 0, "liquidez_mxn": 0,
   "posiciones": {"ASML": {"q": 1, "costo": 30000}, "ALPEKA.MX": {"q": 100, "costo": 1500}},
   "grupos": {"tecnología": ["ASML"]}}
Symbols ending in .MX are priced in pesos; the rest are converted with --fx (default MXN=X).

Usage: python3 portfolio_value.py cartera.json
"""

import json
import sys
import urllib.request

UA = {"User-Agent": "Mozilla/5.0 (objective-market-analysis)"}


def chart(sym, query):
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}?{query}"
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
        return json.load(r)["chart"]["result"][0]


def last(sym):
    """Latest price, the previous regular close and that bar's timestamp (the session's open)."""
    res = chart(sym, "range=5d&interval=1d")
    bars = [(t, c) for t, c in zip(res["timestamp"], res["indicators"]["quote"][0]["close"]) if c]
    return res["meta"]["regularMarketPrice"], bars[-2][1], bars[-2][0]


def price_at(sym, ts):
    """Price at a moment, from 30-minute bars. Currencies trade around the clock and their daily
    bars close on London time, so the day's change is measured from the previous US close instead."""
    res = chart(sym, "range=5d&interval=30m")
    pts = [c for t, c in zip(res["timestamp"], res["indicators"]["quote"][0]["close"]) if c and t <= ts]
    return pts[-1] if pts else None


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    fx_sym = sys.argv[sys.argv.index("--fx") + 1] if "--fx" in sys.argv else "MXN=X"
    p = json.load(open(sys.argv[1]))
    fx, fx0, _ = last(fx_sym)
    us_close = last("SPY")[2] + 6.5 * 3600  # daily bars are stamped at the 9:30 a.m. New York open
    fx0 = price_at(fx_sym, us_close) or fx0
    cash = p.get("efectivo_reporto_mxn", 0) + p.get("liquidez_mxn", 0)
    rows, total, cost, day = [], cash, 0.0, 0.0
    for s, d in p["posiciones"].items():
        px, px0, _ = last(s)
        m, m0 = (1, 1) if s.endswith(".MX") else (fx, fx0)
        v = d["q"] * px * m
        total += v
        cost += d["costo"]
        day += v - d["q"] * px0 * m0
        rows.append((s, d["q"], px, v, v - d["costo"], v / d["costo"] - 1, px / px0 - 1))
    print("| Posición | Cant. | Precio | Hoy | Valor | G/P sobre costo | % cuenta |\n|---|---|---|---|---|---|---|")
    for s, q, px, v, g, gp, dp in sorted(rows, key=lambda r: -r[3]):
        print(f"| {s} | {q} | {px:,.2f} | {dp * 100:+.1f}% | {v:,.0f} | {g:+,.0f} ({gp * 100:+.1f}%) | {v / total * 100:.1f}% |")
    inv = total - cash
    print(f"\nDólar {fx:.4f} ({(fx / fx0 - 1) * 100:+.2f}%) | invertido {inv:,.0f} | efectivo neto {cash:,.0f} ({cash / total * 100:.1f}%) | "
          f"total {total:,.0f} | hoy {day:+,.0f} ({day / (total - day) * 100:+.2f}%) | G/P {inv - cost:+,.0f} ({(inv / cost - 1) * 100:+.1f}%)")
    val = {r[0]: r[3] for r in rows}
    groups = p.get("grupos", {})
    if groups:
        print(" | ".join(f"{g} {sum(val.get(s, 0) for s in ss):,.0f} ({sum(val.get(s, 0) for s in ss) / total * 100:.1f}%)" for g, ss in groups.items()))


if __name__ == "__main__":
    main()
