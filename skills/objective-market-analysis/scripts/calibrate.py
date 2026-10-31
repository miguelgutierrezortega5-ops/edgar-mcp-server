#!/usr/bin/env python3
"""Backtest of ways to set a probability: which one scores the best Brier out of sample.

For every symbol and every k-th trading day, each method states P(event) using only prices up to
that day; the event is then resolved with the realised h-day return. Brier scores are reported by
method and event for a training period and a later test period. Each method also gets a recalibrated
version (Platt scaling) fitted on the training dates only, so the test period stays out of sample.

Methods
  clim     share of all past h-day returns that met the event (expanding window)
  clim10   the same over the last 10 years
  state    the same, only on past days in today's state (5-day move and distance from the 52-week high)
  adverse  the most adverse of clim, clim10 and state: what step 2 of the skill flags with ⚠
  ewma_t   Student-t with 4 degrees of freedom on today's EWMA volatility (RiskMetrics, λ = 0.94), no drift
  fhs      filtered historical simulation: past h-day returns divided by the volatility of their own day,
           rescaled by today's volatility (Barone-Adesi, Giannopoulos and Vosper, 1999)
  fhs10    the same over the last 10 years
  blend    mean of fhs and clim
A "+cal" suffix marks the recalibrated version.

Brier = reliability − resolution + uncertainty. The uncertainty term, base rate × (1 − base rate), is
the score of a forecaster who always says the right base rate: for a 50/50 event it is 0.25, and only
real resolution (telling apart the days when the event is more likely) can push a score below it.

Standard library only; prices from Yahoo through riskstats.fetch_yahoo (adjusted closes).

Examples
  python3 calibrate.py --symbols ^SOX,QQQ,ASML --step 5 --split 2008-01-01
  python3 calibrate.py --log ../../../calibration/forecasts.jsonl   # also re-scores the logged forecasts
"""

import argparse
import json
import math
import sys
from bisect import bisect_left, bisect_right, insort
from collections import defaultdict, deque
from datetime import date, timedelta

from riskstats import fetch_yahoo

DEFAULT_SYMBOLS = ("^SOX,QQQ,SPY,^GSPC,^IXIC,ASML,NVDA,AMD,INTC,MU,AAPL,MSFT,GOOGL,AMZN,META,"
                   "KO,JNJ,PG,WMT,VRTX,LLY,XOM,GLD,XLP,XLE,XBI")
# horizon:op:threshold on the simple return; the menu of events this skill has been forecasting.
DEFAULT_EVENTS = ("1:le:-0.03,1:ge:0.03,5:lt:0,5:le:-0.05,5:ge:0.05,10:gt:0,"
                  "21:lt:0,21:le:-0.05,21:ge:0.05,21:le:-0.10,63:lt:0,63:le:-0.10,63:ge:0.10")
# The mix of the forecasts resolved in calibration/forecasts.jsonl by 30 October 2026.
LIVE_MIX = {"5:lt:0": 3, "10:gt:0": 1, "5:le:-0.05": 5, "5:ge:0.05": 4}
METHODS = ("clim", "clim10", "state", "adverse", "ewma_t", "fhs", "fhs10", "blend")
LAMBDA = 0.94
MIN_OBS = 250


def parse_events(s):
    out = []
    for e in s.split(","):
        h, op, th = e.split(":")
        out.append((int(h), op, float(th)))
    return out


def key(ev):
    h, op, th = ev
    return f"{h}:{op}:{th:g}"


def t4_cdf(t):
    """Student-t CDF with 4 degrees of freedom (closed form)."""
    u = t * t / (1 + t * t / 4)
    return 0.5 + 0.375 * (t / math.sqrt(1 + t * t / 4)) * (1 - u / 12)


def ecdf(sorted_vals, c, op):
    """P(X op c) from a sorted sample."""
    n = len(sorted_vals)
    if op == "le":
        return bisect_right(sorted_vals, c) / n
    if op == "lt":
        return bisect_left(sorted_vals, c) / n
    if op == "ge":
        return 1 - bisect_left(sorted_vals, c) / n
    return 1 - bisect_right(sorted_vals, c) / n


def happened(x, c, op):
    return {"le": x <= c, "lt": x < c, "ge": x >= c, "gt": x > c}[op]


class Window:
    """A sorted sample that can also drop its oldest values (for the 10-year window)."""

    def __init__(self, years=None):
        self.vals, self.q, self.years = [], deque(), years

    def add(self, d, v):
        insort(self.vals, v)
        self.q.append((d, v))

    def trim(self, today):
        if self.years is None:
            return
        cut = (date.fromisoformat(today) - timedelta(days=round(365.25 * self.years))).isoformat()
        while self.q and self.q[0][0] < cut:
            _, v = self.q.popleft()
            del self.vals[bisect_left(self.vals, v)]


def state_of(p, hi, i):
    m5 = p[i] / p[i - 5] - 1
    dd = p[i] / hi[i] - 1
    a = 0 if m5 <= -0.05 else 1 if m5 <= -0.02 else 2 if m5 < 0.02 else 3 if m5 < 0.05 else 4
    b = 0 if dd >= -0.05 else 1 if dd >= -0.15 else 2 if dd >= -0.25 else 3
    return a * 4 + b


def walk(dates, p, events, step, emit_from, want=None):
    """Walk forward through one price series; yield (date index, event, {method: p}, outcome).

    want: optional set of date strings to evaluate regardless of step (for re-scoring logged forecasts).
    """
    n = len(p)
    lr = [0.0] + [math.log(p[i] / p[i - 1]) for i in range(1, n)]
    var = sum(x * x for x in lr[1:61]) / 60
    sig = [0.0] * n
    for i in range(1, n):
        var = LAMBDA * var + (1 - LAMBDA) * lr[i] ** 2
        sig[i] = math.sqrt(var)
    hi = [max(p[max(0, i - 251): i + 1]) for i in range(n)]
    hs = sorted({h for h, _, _ in events})
    raw = {h: (Window(), Window(10)) for h in hs}
    zs = {h: (Window(), Window(10)) for h in hs}
    by_state = {h: defaultdict(list) for h in hs}
    for i in range(1, n):
        d = dates[i]
        for h in hs:  # returns that end today become known today
            j = i - h
            if j >= 60 and sig[j] > 0:
                f = math.log(p[i] / p[j])
                for w in raw[h]:
                    w.add(dates[j], f)
                for w in zs[h]:
                    w.add(dates[j], f / (sig[j] * math.sqrt(h)))
                if j >= 251:
                    insort(by_state[h][state_of(p, hi, j)], f)
            raw[h][1].trim(d)
            zs[h][1].trim(d)
        due = (want is not None and d in want) or (want is None and d >= emit_from and i % step == 0)
        if not due or i < 300 or sig[i] <= 0:
            continue
        st = state_of(p, hi, i)
        for ev in events:
            h, op, th = ev
            if i + h >= n and want is None:
                continue
            if len(raw[h][0].vals) < MIN_OBS or len(raw[h][1].vals) < MIN_OBS:
                continue
            c = math.log(1 + th)
            pr = {"clim": ecdf(raw[h][0].vals, c, op), "clim10": ecdf(raw[h][1].vals, c, op)}
            sv = by_state[h][st]
            pr["state"] = ecdf(sv, c, op) if len(sv) >= 60 else pr["clim"]
            samples = (pr["clim"], pr["clim10"], pr["state"])
            # Adverse = the sample that makes a fall likelier: highest P for a fall, lowest for a rise.
            pr["adverse"] = max(samples) if op in ("le", "lt") else min(samples)
            s = sig[i] * math.sqrt(h)
            t = c / (s * math.sqrt(0.5))
            pr["ewma_t"] = t4_cdf(t) if op in ("le", "lt") else 1 - t4_cdf(t)
            pr["fhs"] = ecdf(zs[h][0].vals, c / s, op)
            pr["fhs10"] = ecdf(zs[h][1].vals, c / s, op)
            pr["blend"] = (pr["fhs"] + pr["clim"]) / 2
            y = None if i + h >= n else int(happened(math.log(p[i + h] / p[i]), c, op))
            yield i, ev, pr, y


def logit(x):
    x = min(max(x, 1e-4), 1 - 1e-4)
    return math.log(x / (1 - x))


def platt_fit(ps, ys):
    """Fit y ~ sigmoid(a + b·logit(p)) by Newton's method; returns (a, b)."""
    a, b = 0.0, 1.0
    xs = [logit(p) for p in ps]
    for _ in range(50):
        ga = gb = haa = hab = hbb = 0.0
        for x, y in zip(xs, ys):
            q = 1 / (1 + math.exp(-(a + b * x)))
            w = q * (1 - q)
            ga += q - y
            gb += (q - y) * x
            haa += w
            hab += w * x
            hbb += w * x * x
        det = haa * hbb - hab * hab + 1e-12
        da, db = (hbb * ga - hab * gb) / det, (haa * gb - hab * ga) / det
        a, b = a - da, b - db
        if abs(da) + abs(db) < 1e-9:
            break
    return a, b


def platt(ab, p):
    a, b = ab
    return 1 / (1 + math.exp(-(a + b * logit(p))))


def brier(rows):
    return sum((p - y) ** 2 for p, y in rows) / len(rows) if rows else float("nan")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--symbols", default=DEFAULT_SYMBOLS)
    ap.add_argument("--events", default=DEFAULT_EVENTS)
    ap.add_argument("--step", type=int, default=5, help="evaluate every k-th trading day")
    ap.add_argument("--split", default="2008-01-01", help="first date of the test period")
    ap.add_argument("--start", default="1994-01-01", help="first forecast date")
    ap.add_argument("--log", help="forecasts.jsonl: also re-score its probability forecasts point-in-time")
    a = ap.parse_args()
    events = parse_events(a.events)
    keys = [key(e) for e in events]
    res = defaultdict(list)  # (period, event key, method) -> [(p, y)]
    base = defaultdict(list)
    series = {}
    for sym in a.symbols.split(","):
        try:
            rows, _ = fetch_yahoo(sym, "1985-01-01")
        except Exception as e:  # one missing symbol should not stop the run
            print(f"Sin datos de {sym}: {e}", file=sys.stderr)
            continue
        series[sym] = rows
        dates, p = [d for d, _ in rows], [c for _, c in rows]
        for i, ev, pr, y in walk(dates, p, events, a.step, a.start):
            if y is None:
                continue
            period = "test" if dates[i] >= a.split else "train"
            for m, v in pr.items():
                res[(period, key(ev), m)].append((v, y))
            base[(period, key(ev))].append(y)
        print(f"{sym}: {len(p)} días desde {dates[0]}", file=sys.stderr)

    cal = {}
    for k in keys:
        for m in METHODS:
            tr = res[("train", k, m)]
            if len(tr) >= 200:
                cal[(k, m)] = platt_fit([p for p, _ in tr], [y for _, y in tr])
    for k in keys:
        for m in METHODS:
            if (k, m) in cal:
                for period in ("train", "test"):
                    res[(period, k, m + "+cal")] = [(platt(cal[(k, m)], p), y) for p, y in res[(period, k, m)]]
    allm = [m for m in METHODS] + [m + "+cal" for m in METHODS]

    print(f"# Brier fuera de muestra (prueba desde {a.split}; ajuste de calibración con fechas anteriores)\n")
    print("| Evento | n prueba | Frecuencia | Piso sin resolución | " + " | ".join(allm) + " |")
    print("|---|---|---|---|" + "---|" * len(allm))
    best = {}
    for k in keys:
        ys = base[("test", k)]
        if not ys:
            continue
        f = sum(ys) / len(ys)
        scores = {m: brier(res[("test", k, m)]) for m in allm}
        best[k] = min(scores, key=lambda m: scores[m] if not math.isnan(scores[m]) else 9)
        cells = [f"**{scores[m]:.4f}**" if m == best[k] else f"{scores[m]:.4f}" for m in allm]
        print(f"| {k} | {len(ys)} | {f:.1%} | {f * (1 - f):.4f} | " + " | ".join(cells) + " |")

    print("\n## Mezcla de los pronósticos que he dado (pesos: " + ", ".join(f"{k}×{w}" for k, w in LIVE_MIX.items()) + ")")
    tw = sum(LIVE_MIX.values())
    for m in allm:
        s = sum(w * brier(res[("test", k, m)]) for k, w in LIVE_MIX.items() if res[("test", k, m)])
        print(f"- {m}: {s / tw:.4f}")
    floor = sum(w * (lambda ys: (sum(ys) / len(ys)) * (1 - sum(ys) / len(ys)))(base[("test", k)]) for k, w in LIVE_MIX.items()) / tw
    print(f"- piso sin resolución (frecuencia exacta del periodo, conocida de antemano): {floor:.4f}")

    if a.log:
        fcs = [json.loads(l) for l in open(a.log) if l.strip()]
        fcs = [r for r in fcs if r["kind"] == "prob"]
        print("\n## Pronósticos registrados, recalculados con cada método en su fecha (retrospectivo, no cambia el registro)")
        print("| # | Símbolo | Evento | Fecha | Di | Resultado | " + " | ".join(allm) + " |")
        print("|---|---|---|---|---|---|" + "---|" * len(allm))
        tot = defaultdict(float)
        nres = 0
        for r in fcs:
            sym = r["symbol"]
            if sym not in series:
                try:
                    series[sym] = fetch_yahoo(sym, "1985-01-01")[0]
                except Exception:
                    continue
            rows = series[sym]
            dates, p = [d for d, _ in rows], [c for _, c in rows]
            ev = (r["horizon"], r["op"], r["threshold"])
            got = None
            for i, e, pr, y in walk(dates, p, [ev], 1, a.start, want={r["start_date"]}):
                got = pr
            if not got:
                continue
            k = key(ev)
            out = {m: got[m] for m in METHODS}
            out.update({m + "+cal": platt(cal[(k, m)], got[m]) for m in METHODS if (k, m) in cal})
            y = r.get("outcome")
            if y is not None:
                nres += 1
                tot["dado"] += (r["prob"] - y) ** 2
                for m in allm:
                    if m in out:
                        tot[m] += (out[m] - y) ** 2
            print(f"| {r['id']} | {sym} | {k} | {r['start_date']} | {r['prob']:.0%} | {'—' if y is None else y} | "
                  + " | ".join(f"{out[m]:.0%}" if m in out else "—" for m in allm) + " |")
        if nres:
            print(f"\nBrier de los {nres} resueltos: dado {tot['dado'] / nres:.3f}; "
                  + "; ".join(f"{m} {tot[m] / nres:.3f}" for m in allm))


if __name__ == "__main__":
    sys.exit(main())
