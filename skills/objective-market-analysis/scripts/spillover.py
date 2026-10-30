#!/usr/bin/env python3
"""Spillover map, rotation check and refuge base rates.

Answers three questions with counts instead of narrative:
  map       Which large companies move each holding when they have news of their own?
            A bellwether's news days are days its return net of the market, its sector and semiconductors
            is at least k standard deviations (mostly earnings, guidance and deals). On those days the holding's move is
            regressed on the bellwether's, e.g. "por cada −10% de INTC en su noticia, ASML hizo −3%".
  rotation  Did a holding rise on its own report or on days money left tech?
            Splits its return over a window into its own report days, tech-down days (^SOX ≤ −2%),
            tech-up days (^SOX ≥ +2%) and the rest, and compares its correlation with ^SOX in the
            window with the same-length correlation over the previous 3 years.
  refuge    Where did money go on tech shock days, and did moving there after the shock pay?
            For each day ^SOX fell 4% or more (episodes at least 21 days apart), each candidate's
            return that day and over the next 5, 21 and 63 days, alone and against QQQ.

Standard library only; prices from Yahoo through riskstats.fetch_yahoo (adjusted closes).

Examples
  python3 spillover.py map --holdings ASML,KO,JNJ --bellwethers INTC,NVDA,TSM,AMD --values ASML=30000,KO=10000
  python3 spillover.py rotation --symbols KO,JNJ,VRTX --start 2026-09-30 --reports KO=2026-10-21 --sector KO=XLP,JNJ=XLV
  python3 spillover.py refuge --candidates XLP,XLV,XLU,XLE,GLD,TLT,MXN=X
"""

import argparse
import math
import sys
from datetime import date, timedelta

from riskstats import fetch_yahoo, pct, prob, pct_rank, quantile, std

SAME_COMPANY = [{"GOOG", "GOOGL"}, {"BRK-A", "BRK-B"}, {"QQQ", "QQQM"}, {"GLD", "GLDM", "IAU"}]
# News is what is left after the market, the company's sector and semiconductors, so a defensive
# stock rising while tech falls (rotation) is not mistaken for news of its own. Anything not listed is measured against SPY.
SECTOR = {etf: etf for etf in ("SMH", "XLK", "XLC", "XLY", "XLP", "XLV", "XLE", "XLU")}
for etf, names in {
    "SMH": "NVDA AVGO TSM AMD INTC MU AMAT LRCX KLAC QCOM ARM ASML ON MRVL TXN ADI",
    "XLK": "MSFT AAPL ORCL DELL SMCI ANET PLTR CSCO CRM ADBE NOW IBM HPQ",
    "XLC": "GOOGL GOOG META NFLX DIS",
    "XLY": "AMZN TSLA HD MCD NKE SBUX LOW",
    "XLP": "PG PEP KO COST WMT PM MO CL MDLZ",
    "XLV": "LLY NVO UNH MRK ABBV PFE AMGN REGN JNJ VRTX BMY GILD TMO ABT",
    "XLE": "XOM CVX PBR COP SLB",
    "XLU": "CEG VST NEE DUK SO",
}.items():
    SECTOR.update(dict.fromkeys(names.split(), etf))


def split(s):
    return [x.strip() for x in (s or "").split(",") if x.strip()]


def pairs(s):
    return dict(x.split("=", 1) for x in split(s))


def load(syms, start):
    out = {}
    for s in sorted(set(syms)):
        try:
            out[s] = dict(fetch_yahoo(s, start)[0])
        except Exception as e:  # one missing symbol should not stop the report
            print(f"Sin datos de {s}: {e}", file=sys.stderr)
    return out


def aligned(data, base):
    """Daily returns on the base symbol's calendar; other series are carried over their own holidays."""
    days = sorted(data[base])
    rets = {}
    for s, px in data.items():
        keys, j, last, vals = sorted(px), 0, None, []
        for d in days:
            while j < len(keys) and keys[j] <= d:
                last, j = px[keys[j]], j + 1
            vals.append(last)
        rets[s] = [None if a is None or b is None else b / a - 1 for a, b in zip(vals, vals[1:])]
    return days[1:], rets


def ols(xs, ys):
    """Slope, its standard error and n over the pairs where both values exist."""
    p = [(x, y) for x, y in zip(xs, ys) if x is not None and y is not None]
    n = len(p)
    if n < 3:
        return None, None, n
    mx, my = sum(x for x, _ in p) / n, sum(y for _, y in p) / n
    sxx = sum((x - mx) ** 2 for x, _ in p)
    if not sxx:
        return None, None, n
    b = sum((x - mx) * (y - my) for x, y in p) / sxx
    resid = sum((y - my - b * (x - mx)) ** 2 for x, y in p)
    return b, math.sqrt(resid / (n - 2) / sxx), n


def corr(xs, ys):
    p = [(x, y) for x, y in zip(xs, ys) if x is not None and y is not None]
    if len(p) < 3:
        return float("nan")
    sx, sy = std([x for x, _ in p]), std([y for _, y in p])
    mx, my = sum(x for x, _ in p) / len(p), sum(y for _, y in p) / len(p)
    return sum((x - mx) * (y - my) for x, y in p) / (len(p) - 1) / (sx * sy) if sx and sy else float("nan")


def compound(rs):
    out = 1.0
    for r in rs:
        if r is not None:
            out *= 1 + r
    return out - 1


def same(a, b):
    return a == b or any(a in g and b in g for g in SAME_COMPANY)


def mxn(x):
    return f"{x:+,.0f}"


# ---------------------------------------------------------------- map

def residuals(y, factors):
    """Residuals of y after an intercept and the factors (least squares, normal equations)."""
    rows = [i for i in range(len(y)) if y[i] is not None and all(f[i] is not None for f in factors)]
    X = [[1.0] + [f[i] for f in factors] for i in rows]
    k = len(X[0])
    A = [[sum(x[p] * x[q] for x in X) for q in range(k)] + [sum(x[p] * y[i] for x, i in zip(X, rows))] for p in range(k)]
    for c in range(k):  # Gauss-Jordan with partial pivoting
        piv = max(range(c, k), key=lambda j: abs(A[j][c]))
        A[c], A[piv] = A[piv], A[c]
        for j in range(k):
            if j != c and A[c][c]:
                f = A[j][c] / A[c][c]
                A[j] = [u - f * v for u, v in zip(A[j], A[c])]
    beta = [A[j][k] / A[j][j] if A[j][j] else 0.0 for j in range(k)]
    out = [None] * len(y)
    for x, i in zip(X, rows):
        out[i] = y[i] - sum(b * v for b, v in zip(beta, x))
    return out


def news_days(r, factors, k):
    """Days the move left after the market, the sector and semiconductors is at least k standard deviations."""
    ex = residuals(r, factors)
    sd = std([e for e in ex if e is not None])
    return [i for i, e in enumerate(ex) if e is not None and abs(e) >= k * sd]


def cmd_map(a):
    hold, bells, values = split(a.holdings), split(a.bellwethers), {k: float(v) for k, v in pairs(a.values).items()}
    start = (date.today() - timedelta(days=round(365.25 * a.years) + 10)).isoformat()
    data = load(hold + bells + ["SPY", "SMH"] + [SECTOR.get(b, "SPY") for b in bells], start)
    days, r = aligned(data, "SPY")
    bells = [b for b in bells if b in r]
    factors = lambda b: [r[f] for f in dict.fromkeys(["SPY", "SMH", SECTOR.get(b, "SPY")])]
    shocks = {b: news_days(r[b], factors(b), a.k) for b in bells}
    print(f"# Contagio en días de noticia propia ({days[0]} a {days[-1]})")
    print(f"Noticia = movimiento que queda tras quitar mercado (SPY), sector y semiconductores (SMH) ≥ {a.k} desviaciones. Solo relaciones con pendiente ≥ {a.t} errores estándar, también sin el día más extremo de la empresa (con cientos de pares, un umbral bajo deja pasar casualidades).\n")
    print("| Empresa grande | Medida contra | Días de noticia | Última (movimiento) |\n|---|---|---|---|")
    for b in bells:
        i = shocks[b][-1] if shocks[b] else None
        print(f"| {b} | {SECTOR.get(b, 'SPY')} | {len(shocks[b])} | {days[i] + ' (' + pct(r[b][i]) + ')' if i is not None else '—'} |")
    sens = {b: 0.0 for b in bells}
    for h in hold:
        if h not in r:
            continue
        rows = []
        for b in bells:
            idx = shocks[b]
            xs, ys = [r[b][i] for i in idx], [r[h][i] for i in idx]
            s, se, n = ols(xs, ys)
            if h == b:
                s, se = 1.0, 0.0
            if s is None:
                continue
            if h != b:
                # One extreme day (e.g. 27 Jan 2025) can carry a whole regression: the link must hold
                # without the bellwether's largest move, and the smaller of the two slopes is reported.
                drop = max(range(len(xs)), key=lambda j: abs(xs[j]) if xs[j] is not None else -1)
                s2, se2, _ = ols(xs[:drop] + xs[drop + 1:], ys[:drop] + ys[drop + 1:])
                if s2 is None or abs(s) < a.t * se or abs(s2) < a.t * se2 or s * s2 < 0:
                    continue
                if abs(s2) < abs(s):
                    s, se = s2, se2
            if h in values:
                sens[b] += values[h] * s * -0.10
            if same(h, b) or n < a.min_n:
                continue
            down = [(x, y) for x, y in zip(xs, ys) if x is not None and y is not None and x < 0]
            up = [(x, y) for x, y in zip(xs, ys) if x is not None and y is not None and x > 0]
            agree = sum(1 for x, y in zip(xs, ys) if x is not None and y is not None and x * y > 0) / n
            normal = ols(r[b], r[h])[0]
            avg = lambda ps, j: sum(p[j] for p in ps) / len(ps) if ps else float("nan")
            rows.append((b, n, s, se, normal, avg(down, 0), avg(down, 1), len(down), avg(up, 0), avg(up, 1), agree))
        rows.sort(key=lambda t: -abs(t[2]))
        print(f"\n## {h}" + (f" ({values[h]:,.0f} MXN)" if h in values else ""))
        print("| Empresa | n | Por −10% de la empresa | Días normales | En sus caídas (empresa → tú) | En sus subidas | Mismo signo |")
        print("|---|---|---|---|---|---|---|")
        for b, n, s, se, normal, dx, dy, dn, ux, uy, agree in rows[: a.top]:
            print(f"| {b} | {n} | {pct(-0.1 * s)} (±{abs(0.1 * se) * 100:.1f}) | {pct(-0.1 * normal) if normal is not None else '—'} | "
                  f"{pct(dx)} → {pct(dy)} ({dn}) | {pct(ux)} → {pct(uy)} ({n - dn}) | {prob(agree)} |")
    if values:
        print("\n## Tu cartera si la empresa cae 10% en su noticia (MXN, suma de las sensibilidades)")
        print("| Empresa | MXN | % de lo invertido en estas posiciones |\n|---|---|---|")
        tot = sum(values.values())
        for b in sorted(bells, key=lambda b: sens[b]):
            print(f"| {b} | {mxn(sens[b])} | {pct(sens[b] / tot)} |")


# ---------------------------------------------------------------- rotation

def cmd_rotation(a):
    syms, sector, tech = split(a.symbols), pairs(a.sector), a.tech
    reports = {k: set(v.split(";")) for k, v in pairs(a.reports).items()}
    end = a.end or date.today().isoformat()
    hist_start = (date.fromisoformat(a.start) - timedelta(days=365 * 3 + 30)).isoformat()
    data = load(syms + list(sector.values()) + [tech, "SPY"], hist_start)
    days, r = aligned(data, "SPY")
    win = [i for i, d in enumerate(days) if a.start < d <= end]
    hist = [i for i, d in enumerate(days) if d <= a.start]
    down = [i for i in win if r[tech][i] is not None and r[tech][i] <= -a.move]
    up = [i for i in win if r[tech][i] is not None and r[tech][i] >= a.move]
    print(f"# Rotación: {days[win[0]]} a {days[win[-1]]} ({len(win)} sesiones)")
    print(f"{tech} {pct(compound(r[tech][i] for i in win))}; SPY {pct(compound(r['SPY'][i] for i in win))}. "
          f"Días de {tech} ≤ −{a.move:.0%}: {len(down)} ({', '.join(days[i][5:] for i in down) or '—'}); "
          f"≥ +{a.move:.0%}: {len(up)} ({', '.join(days[i][5:] for i in up) or '—'}).\n")
    print(f"| Símbolo | Total | Reporte propio | Días {tech} ≤ −{a.move:.0%} | Días {tech} ≥ +{a.move:.0%} | Resto | vs su sector | Correlación con {tech}: ventana / normal (percentil) |")
    print("|---|---|---|---|---|---|---|---|")
    m = len(win)
    for s in syms + [v for v in dict.fromkeys(sector.values()) if v not in syms]:
        if s not in r:
            continue
        own = [i for i in win if days[i] in reports.get(s, ())]
        rest = [i for i in win if i not in own and i not in down and i not in up]
        part = lambda idx: pct(compound(r[s][i] for i in idx)) if idx else "—"
        total = compound(r[s][i] for i in win)
        vs = f"{pct(total - compound(r[sector[s]][i] for i in win))} vs {sector[s]}" if s in sector and sector[s] in r else "—"
        c = corr([r[s][i] for i in win], [r[tech][i] for i in win])
        rolling = [corr(r[s][j - m + 1: j + 1], r[tech][j - m + 1: j + 1]) for j in hist[m:]]
        rolling = [x for x in rolling if not math.isnan(x)]
        normal = f"{quantile(rolling, .5):+.2f} ({prob(pct_rank(rolling, c))})" if rolling else "—"
        print(f"| {s} | {pct(total)} | {part(own)} | {part([i for i in down if i not in own])} | "
              f"{part([i for i in up if i not in own])} | {part(rest)} | {vs} | {c:+.2f} / {normal} |")


# ---------------------------------------------------------------- refuge

def cmd_refuge(a):
    cands, shock, bench = split(a.candidates), a.shock, a.bench
    data = load(cands + [shock, bench], "1990-01-01")
    days, r = aligned(data, shock)
    # Level of the shock index rebuilt from its returns, for the 200-day regime split.
    lvl = [1.0]
    for x in r[shock]:
        lvl.append(lvl[-1] * (1 + (x or 0)))
    eps, last = [], -10 ** 9
    for i, x in enumerate(r[shock]):
        if x is not None and x <= a.drop and i - last >= a.gap and i + 1 >= 200:
            eps.append(i)
            last = i
    ten = (date.today() - timedelta(days=3652)).isoformat()
    below = [i for i in eps if lvl[i + 1] < sum(lvl[i - 198: i + 2]) / 200]
    samples = [("todos", eps), ("últimos 10 años", [i for i in eps if days[i] >= ten]),
               (f"{shock} debajo de su promedio de 200 días", below)]
    print(f"# Refugios en días de golpe a tecnología: {shock} ≤ {pct(a.drop, 0)} en un día, episodios separados {a.gap} sesiones")
    print(f"Desde {days[eps[0]]}; último episodio {days[eps[-1]]} ({pct(r[shock][eps[-1]])}).")
    for name, idx in samples:
        print(f"\n## {name}: {len(idx)} episodios")
        print(f"| Símbolo | Día del golpe: mediana (sube) | +5 días: mediana (le gana a {bench}) | +21 días | +63 días | P5 a 63 días | Peor punto en 63 días (mediana) |")
        print("|---|---|---|---|---|---|---|")
        for s in [bench] + cands:
            if s not in r:
                continue
            day0 = [r[s][i] for i in idx if r[s][i] is not None]
            cells = []
            for h in (5, 21, 63):
                fw = [(compound(r[s][i + 1: i + 1 + h]), compound(r[bench][i + 1: i + 1 + h]))
                      for i in idx if i + h < len(days) and r[s][i + 1] is not None]
                if not fw:
                    cells.append("—")
                    continue
                med = quantile([x for x, _ in fw], .5)
                beat = sum(1 for x, b in fw if x > b) / len(fw)
                cells.append(f"{pct(med)} ({prob(beat)})" if s != bench else f"{pct(med)} (sube {prob(sum(1 for x, _ in fw if x > 0) / len(fw))})")
            f63 = [compound(r[s][i + 1: i + 64]) for i in idx if i + 63 < len(days) and r[s][i + 1] is not None]
            worst = []
            for i in idx:
                if i + 63 < len(days) and r[s][i + 1] is not None:
                    v, lo = 1.0, 0.0
                    for x in r[s][i + 1: i + 64]:
                        v *= 1 + (x or 0)
                        lo = min(lo, v - 1)
                    worst.append(lo)
            up0 = sum(1 for x in day0 if x > 0) / len(day0) if day0 else float("nan")
            print(f"| {s} | {pct(quantile(day0, .5))} ({prob(up0)}) | {' | '.join(cells)} | {pct(quantile(f63, .05))} | {pct(quantile(worst, .5))} |")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    m = sub.add_parser("map")
    m.add_argument("--holdings", required=True)
    m.add_argument("--bellwethers", required=True)
    m.add_argument("--values", help="valor de cada posición en MXN: SYM=valor,...")
    m.add_argument("--years", type=float, default=5)
    m.add_argument("--k", type=float, default=2.5, help="desviaciones del movimiento neto que cuentan como noticia")
    m.add_argument("--min-n", type=int, default=8)
    m.add_argument("--t", type=float, default=3, help="errores estándar mínimos de la pendiente")
    m.add_argument("--top", type=int, default=6)
    ro = sub.add_parser("rotation")
    ro.add_argument("--symbols", required=True)
    ro.add_argument("--start", required=True, help="último cierre antes de la ventana")
    ro.add_argument("--end")
    ro.add_argument("--reports", help="días de reacción a su propio reporte: SYM=fecha;fecha,...")
    ro.add_argument("--sector", help="ETF de su sector: SYM=ETF,...")
    ro.add_argument("--tech", default="^SOX")
    ro.add_argument("--move", type=float, default=0.02)
    rf = sub.add_parser("refuge")
    rf.add_argument("--candidates", required=True)
    rf.add_argument("--shock", default="^SOX")
    rf.add_argument("--bench", default="QQQ")
    rf.add_argument("--drop", type=float, default=-0.04)
    rf.add_argument("--gap", type=int, default=21)
    a = ap.parse_args()
    {"map": cmd_map, "rotation": cmd_rotation, "refuge": cmd_refuge}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
