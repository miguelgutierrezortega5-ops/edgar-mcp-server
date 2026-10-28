#!/usr/bin/env python3
"""Forecast log: record every probabilistic claim, resolve it against prices, score calibration.

Two kinds of forecast:
  prob   a binary event with a probability, e.g. "^SOX return over 5 trading days <= -3%" with p=0.35
  range  an interval with a stated coverage, e.g. "ASML next-day return between +4% and +9%" (coverage 0.8)

Commands
  add      python3 forecast_log.py add --kind prob --symbol ^SOX --horizon 5 --op le --threshold -0.03 --prob 0.35 --claim "SOX cae ≥3% en 5 días"
           python3 forecast_log.py add --kind range --symbol ASML --horizon 1 --low 0.04 --high 0.09 --coverage 0.8 --claim "..."
           Add --start-date/--start-price for a past forecast, and --outcome/--realized to record one already resolved.
  resolve  python3 forecast_log.py resolve        (fills outcomes whose horizon has passed, using Yahoo closes)
  score    python3 forecast_log.py score          (Brier score, calibration by bucket, range coverage, every miss)

Log: JSON lines; path from --log (default ./forecasts.jsonl). In the edgar-mcp-server repo use calibration/forecasts.jsonl and commit it.
"""

import argparse
import json
import os
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone

UA = "Mozilla/5.0 (objective-market-analysis)"


def closes(sym, start):
    p1 = int(datetime.fromisoformat(start).replace(tzinfo=timezone.utc).timestamp()) - 86400 * 7
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(sym)}"
           f"?period1={p1}&period2={int(datetime.now(timezone.utc).timestamp())}&interval=1d")
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=30) as r:
        res = json.load(r)["chart"]["result"][0]
    # While a session is open its daily bar holds the live price, not a close: leave it out.
    session = res["meta"].get("currentTradingPeriod", {}).get("regular", {})
    open_from = session.get("start") if datetime.now(timezone.utc).timestamp() < session.get("end", 0) else None
    out = {}
    for t, c in zip(res.get("timestamp") or [], res["indicators"]["quote"][0]["close"]):
        if c is not None and not (open_from and t >= open_from):
            out[datetime.fromtimestamp(t, tz=timezone.utc).date().isoformat()] = float(c)
    return sorted(out.items())


def read(path):
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


def write(path, rows):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def judge(fc, realized):
    if fc["kind"] == "prob":
        th = fc["threshold"]
        return int({"le": realized <= th, "lt": realized < th, "ge": realized >= th, "gt": realized > th}[fc["op"]])
    return int(fc["low"] <= realized <= fc["high"])


def cmd_add(a):
    rows = read(a.log)
    start_date, start_price = a.start_date, a.start_price
    if not start_price:
        px = closes(a.symbol, start_date or datetime.now(timezone.utc).date().isoformat())
        start_date, start_price = px[-1] if not start_date else next((d, c) for d, c in reversed(px) if d <= start_date)
    fc = {
        "id": max([r["id"] for r in rows], default=0) + 1,
        "created": datetime.now(timezone.utc).isoformat(timespec="minutes"),
        "kind": a.kind, "claim": a.claim, "symbol": a.symbol, "horizon": a.horizon,
        "start_date": start_date or datetime.now(timezone.utc).date().isoformat(), "start_price": start_price,
    }
    if a.kind == "prob":
        fc.update(op=a.op, threshold=a.threshold, prob=a.prob)
    else:
        fc.update(low=a.low, high=a.high, coverage=a.coverage)
    if a.realized is not None:
        fc.update(realized=a.realized, outcome=judge(fc, a.realized), resolved=datetime.now(timezone.utc).date().isoformat())
    if a.note:
        fc["note"] = a.note
    rows.append(fc)
    write(a.log, rows)
    print(json.dumps(fc, ensure_ascii=False))


def cmd_resolve(a):
    rows = read(a.log)
    changed = 0
    for fc in rows:
        if "outcome" in fc:
            continue
        px = closes(fc["symbol"], fc["start_date"])
        after = [(d, c) for d, c in px if d > fc["start_date"]]
        if len(after) < fc["horizon"]:
            continue
        d, c = after[fc["horizon"] - 1]
        fc["realized"] = c / fc["start_price"] - 1
        fc["outcome"] = judge(fc, fc["realized"])
        fc["resolved"] = d
        changed += 1
    write(a.log, rows)
    print(f"Resueltos: {changed}. Pendientes: {sum(1 for r in rows if 'outcome' not in r)}.")


def cmd_score(a):
    rows = read(a.log)
    probs = [r for r in rows if r["kind"] == "prob" and "outcome" in r]
    ranges = [r for r in rows if r["kind"] == "range" and "outcome" in r]
    pending = [r for r in rows if "outcome" not in r]
    print(f"Pronósticos: {len(rows)} | resueltos {len(probs) + len(ranges)} | pendientes {len(pending)}")
    if probs:
        brier = sum((r["prob"] - r["outcome"]) ** 2 for r in probs) / len(probs)
        base = sum(r["outcome"] for r in probs) / len(probs)
        ref = sum((base - r["outcome"]) ** 2 for r in probs) / len(probs)
        print(f"Brier (0 = perfecto, 0.25 = decir 50% siempre): {brier:.3f} con n={len(probs)}; referencia de frecuencia base {ref:.3f}")
        print("| Probabilidad dada | n | Frecuencia real |")
        print("|---|---|---|")
        for lo in (0, .2, .4, .6, .8):
            b = [r for r in probs if lo <= r["prob"] < lo + .2 or (lo == .8 and r["prob"] == 1)]
            if b:
                print(f"| {lo:.0%}–{lo + .2:.0%} | {len(b)} | {sum(r['outcome'] for r in b) / len(b):.0%} |")
    if ranges:
        hit = sum(r["outcome"] for r in ranges) / len(ranges)
        nominal = [r["coverage"] for r in ranges if r.get("coverage")]
        print(f"Rangos: aciertos {hit:.0%} (n={len(ranges)}) frente a cobertura declarada media {sum(nominal) / len(nominal):.0%}" if nominal else f"Rangos: aciertos {hit:.0%} (n={len(ranges)})")
    misses = [r for r in rows if "outcome" in r and ((r["kind"] == "range" and r["outcome"] == 0) or (r["kind"] == "prob" and abs(r["prob"] - r["outcome"]) >= 0.5))]
    for r in misses:
        print(f"- Fallo #{r['id']} ({r['start_date']}): {r['claim']} → realizado {r['realized'] * 100:+.1f}%")
    for r in pending:
        print(f"- Pendiente #{r['id']} ({r['start_date']}, {r['horizon']} días): {r['claim']}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--log", default="forecasts.jsonl")
    sub = ap.add_subparsers(dest="cmd", required=True)
    ad = sub.add_parser("add")
    ad.add_argument("--kind", choices=["prob", "range"], required=True)
    ad.add_argument("--claim", required=True)
    ad.add_argument("--symbol", required=True)
    ad.add_argument("--horizon", type=int, required=True, help="días hábiles")
    ad.add_argument("--op", choices=["le", "lt", "ge", "gt"])
    ad.add_argument("--threshold", type=float)
    ad.add_argument("--prob", type=float)
    ad.add_argument("--low", type=float)
    ad.add_argument("--high", type=float)
    ad.add_argument("--coverage", type=float)
    ad.add_argument("--start-date")
    ad.add_argument("--start-price", type=float)
    ad.add_argument("--realized", type=float, help="retorno realizado si ya se conoce")
    ad.add_argument("--note")
    sub.add_parser("resolve")
    sub.add_parser("score")
    a = ap.parse_args()
    if a.cmd == "add":
        if a.kind == "prob" and None in (a.op, a.threshold, a.prob):
            ap.error("prob necesita --op, --threshold y --prob")
        if a.kind == "range" and None in (a.low, a.high):
            ap.error("range necesita --low y --high")
        cmd_add(a)
    elif a.cmd == "resolve":
        cmd_resolve(a)
    else:
        cmd_score(a)


if __name__ == "__main__":
    sys.exit(main())
