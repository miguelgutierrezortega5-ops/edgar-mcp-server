#!/usr/bin/env python3
"""Base rates, tail risk and current-state panel for symbols or a portfolio.

Standard library only. Prices come from Yahoo Finance's chart endpoint (the same
one edgar-mcp-server uses) or from local CSV files ("date,close" per line) when
there is no network.

The point of this script is to replace narrative with counts: every forward
statistic is shown for several samples (unconditional and conditioned on the
current state, over the full history and the last 10 years), and the most
adverse credible sample is flagged so it cannot be quietly left out.

Examples
  python3 riskstats.py ^SOX NVDA --horizons 5,10,21
  python3 riskstats.py ^SOX ASML NVDA --market
  python3 riskstats.py --portfolio "ASML=1,NVDA=4,GOOG=3,KO=6" --fx MXN=X --cash 24300
  python3 riskstats.py --csv SOX=sox.csv --horizons 5
"""

import argparse
import json
import math
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone

UA = "Mozilla/5.0 (objective-market-analysis)"
# Young ETFs are extended with an older fund that tracks the same thing.
DEFAULT_PROXIES = {"QQQM": "QQQ", "GLDM": "GLD", "SPLG": "SPY", "IVV": "SPY", "VOO": "SPY"}
MIN_EFFECTIVE_N = 10  # samples with fewer independent episodes are shown but never flagged


# ---------------------------------------------------------------- data

def fetch_yahoo(sym, start="1990-01-01"):
    p1 = int(datetime.fromisoformat(start).replace(tzinfo=timezone.utc).timestamp())
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(sym)}"
           f"?period1={p1}&period2={int(time.time())}&interval=1d&events=div,split")
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        res = json.load(r)["chart"]["result"][0]
    ts = res.get("timestamp") or []
    ind = res["indicators"]
    closes = (ind.get("adjclose") or [{}])[0].get("adjclose") or ind["quote"][0]["close"]
    out = {}
    for t, c in zip(ts, closes):
        if c is not None:
            out[datetime.fromtimestamp(t, tz=timezone.utc).date().isoformat()] = float(c)
    # The live price of today's session, when the market is open.
    live = res["meta"].get("regularMarketPrice")
    if live and out:
        out[max(out)] = float(live)
    return sorted(out.items()), res["meta"].get("currency", "USD")


def load_csv(path):
    rows = []
    with open(path) as f:
        for line in f:
            parts = [x.strip() for x in line.replace(";", ",").split(",")]
            if len(parts) < 2:
                continue
            try:
                rows.append((parts[0][:10], float(parts[1])))
            except ValueError:
                continue  # header
    return sorted(rows), None


def load(sym, csv_map):
    if sym in csv_map:
        return load_csv(csv_map[sym])
    return fetch_yahoo(sym)


# ---------------------------------------------------------------- stats helpers

def quantile(xs, q):
    if not xs:
        return float("nan")
    s = sorted(xs)
    pos = q * (len(s) - 1)
    lo, hi = math.floor(pos), math.ceil(pos)
    return s[lo] + (s[hi] - s[lo]) * (pos - lo)


def cvar(xs, q=0.05):
    tail = sorted(xs)[: max(1, int(len(xs) * q))]
    return sum(tail) / len(tail) if tail else float("nan")


def std(xs):
    if len(xs) < 2:
        return float("nan")
    m = sum(xs) / len(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


def pct(x, d=1):
    return "—" if x is None or (isinstance(x, float) and math.isnan(x)) else f"{x * 100:+.{d}f}%"


def prob(x):
    return "—" if x is None or (isinstance(x, float) and math.isnan(x)) else f"{x * 100:.0f}%"


def pct_rank(xs, v):
    return sum(1 for x in xs if x <= v) / len(xs) if xs else float("nan")


# ---------------------------------------------------------------- features

def features(p):
    n = len(p)
    ret1 = [float("nan")] + [p[i] / p[i - 1] - 1 for i in range(1, n)]
    ret5 = [float("nan")] * 5 + [p[i] / p[i - 5] - 1 for i in range(5, n)]
    dd52 = [p[i] / max(p[max(0, i - 251): i + 1]) - 1 for i in range(n)]
    streak = [0] * n
    for i in range(1, n):
        if p[i] < p[i - 1]:
            streak[i] = (streak[i - 1] if streak[i - 1] < 0 else 0) - 1
        elif p[i] > p[i - 1]:
            streak[i] = (streak[i - 1] if streak[i - 1] > 0 else 0) + 1
    rsi = [float("nan")] * n
    if n > 15:
        g = sum(max(p[i] - p[i - 1], 0) for i in range(1, 15)) / 14
        l = sum(max(p[i - 1] - p[i], 0) for i in range(1, 15)) / 14
        for i in range(15, n):
            d = p[i] - p[i - 1]
            g = (g * 13 + max(d, 0)) / 14
            l = (l * 13 + max(-d, 0)) / 14
            rsi[i] = 100 - 100 / (1 + g / l) if l > 0 else 100.0
    return {"ret1": ret1, "ret5": ret5, "dd52": dd52, "streak": streak, "rsi": rsi}


def forward(p, idx, h):
    rs, maes, used, last = [], [], 0, -10**9
    for i in idx:
        if i + h >= len(p):
            continue
        rs.append(p[i + h] / p[i] - 1)
        maes.append(min(p[i + 1: i + h + 1]) / p[i] - 1)
        if i - last >= h:  # non-overlapping episodes
            used += 1
            last = i
    if not rs:
        return None
    return {
        "n": len(rs), "n_eff": used,
        "p_down": sum(1 for r in rs if r < 0) / len(rs),
        "p_le5": sum(1 for r in rs if r <= -0.05) / len(rs),
        "p_le10": sum(1 for r in rs if r <= -0.10) / len(rs),
        "p_ge5": sum(1 for r in rs if r >= 0.05) / len(rs),
        "med": quantile(rs, 0.5), "p5": quantile(rs, 0.05), "p95": quantile(rs, 0.95),
        "cvar5": cvar(rs), "mae_med": quantile(maes, 0.5), "mae_p25": quantile(maes, 0.25),
    }


# ---------------------------------------------------------------- single symbol report

def symbol_report(sym, rows, horizons, band):
    d = [r[0] for r in rows]
    p = [r[1] for r in rows]
    n = len(p) - 1
    if n < 300:
        print(f"\n## {sym}: historia insuficiente ({n + 1} días)")
        return
    f = features(p)
    ten_y = (date.fromisoformat(d[n]) - timedelta(days=3652)).isoformat()
    vol20 = std(f["ret1"][-20:]) * math.sqrt(252)
    vols = [std(f["ret1"][i - 19: i + 1]) * math.sqrt(252) for i in range(max(21, n - 2520), n + 1)]
    vol1y_daily = std(f["ret1"][-252:])
    sma = lambda k: sum(p[-k:]) / k
    dd_hist = [x for x, dt in zip(f["dd52"], d) if dt >= ten_y]

    print(f"\n## {sym} — estado al {d[n]} (precio {p[n]:,.2f})")
    print("| Métrica | Valor | Percentil 10 años |")
    print("|---|---|---|")
    print(f"| Retorno 1d / 5d / 21d | {pct(f['ret1'][n])} / {pct(f['ret5'][n])} / {pct(p[n] / p[n - 21] - 1)} | — |")
    print(f"| Movimiento de hoy en desviaciones (vol. 1 año) | {f['ret1'][n] / vol1y_daily:+.1f}σ | — |")
    print(f"| Distancia al máximo de 52 semanas | {pct(f['dd52'][n])} | {prob(pct_rank(dd_hist, f['dd52'][n]))} |")
    print(f"| Racha actual | {f['streak'][n]:+d} días | — |")
    print(f"| vs media 50 / 200 días | {pct(p[n] / sma(50) - 1)} / {pct(p[n] / sma(200) - 1)} | — |")
    print(f"| RSI 14 | {f['rsi'][n]:.0f} | — |")
    print(f"| Volatilidad 20d anualizada | {vol20 * 100:.0f}% | {prob(pct_rank(vols, vol20))} |")
    drift = sum(f["ret1"][1:]) / n
    print(f"\nDeriva media histórica (aritmética): {pct(drift * 252, 0)} anual ({pct(drift * 5, 2)} por semana). Las filas la incluyen: si el activo se analiza porque ya subió mucho, esa deriva infla P(sube) y la mediana.")

    # Samples: unconditional plus conditions matching today's state.
    conds = [("Base (sin condición)", lambda i: True)]
    if f["dd52"][n] <= -0.05:
        dd0 = f["dd52"][n]
        conds.append((f"Distancia al máximo {pct(dd0, 0)} ±{band * 100:.0f}pp", lambda i, dd0=dd0: abs(f["dd52"][i] - dd0) <= band))
    r5 = f["ret5"][n]
    if abs(r5) >= 0.02:
        conds.append((f"5 días {'≤' if r5 < 0 else '≥'} {pct(r5, 1)}", (lambda i, r5=r5: f["ret5"][i] <= r5) if r5 < 0 else (lambda i, r5=r5: f["ret5"][i] >= r5)))
    r1 = f["ret1"][n]
    if abs(r1) >= 2 * vol1y_daily:
        conds.append((f"Día {'≤' if r1 < 0 else '≥'} {pct(r1, 1)}", (lambda i, r1=r1: f["ret1"][i] <= r1) if r1 < 0 else (lambda i, r1=r1: f["ret1"][i] >= r1)))
    s0 = f["streak"][n]
    if abs(s0) >= 3:
        conds.append((f"Racha {'bajista' if s0 < 0 else 'alcista'} ≥ {abs(s0)} días", (lambda i, s0=s0: f["streak"][i] <= s0) if s0 < 0 else (lambda i, s0=s0: f["streak"][i] >= s0)))
    regimes = [("historia completa", lambda i: i >= 252), ("últimos 10 años", lambda i: d[i] >= ten_y)]

    for h in horizons:
        print(f"\n### {sym}: horizonte {h} días hábiles")
        print("| Muestra | n (indep.) | P(baja) | P(≤−5%) | P(≤−10%) | P(≥+5%) | Mediana | P5 | P95 | CVaR 5% | Peor punto intermedio (mediana / P25) |")
        print("|---|---|---|---|---|---|---|---|---|---|---|")
        rows_out = []
        for cname, cf in conds:
            for rname, rf in regimes:
                idx = [i for i in range(n + 1) if rf(i) and cf(i)]
                st = forward(p, idx, h)
                if st:
                    rows_out.append((f"{cname} · {rname}", st))
        credible = [r for r in rows_out if r[1]["n_eff"] >= MIN_EFFECTIVE_N]
        worst_down = max(credible, key=lambda r: r[1]["p_down"])[0] if credible else None
        worst_tail = min(credible, key=lambda r: r[1]["p5"])[0] if credible else None
        for name, st in rows_out:
            flag = (" ⚠P" if name == worst_down else "") + (" ⚠cola" if name == worst_tail else "")
            print(f"| {name}{flag} | {st['n']} ({st['n_eff']}) | {prob(st['p_down'])} | {prob(st['p_le5'])} | {prob(st['p_le10'])} | {prob(st['p_ge5'])} | "
                  f"{pct(st['med'])} | {pct(st['p5'])} | {pct(st['p95'])} | {pct(st['cvar5'])} | {pct(st['mae_med'])} / {pct(st['mae_p25'])} |")
        if credible:
            print(f"\nReferencia adversa (n indep. ≥ {MIN_EFFECTIVE_N}): mayor P(baja) → {worst_down}; peor cola P5 → {worst_tail}.")


# ---------------------------------------------------------------- market panel (fear / herding as numbers)

def market_panel(series, csv_map):
    print("\n## Panel de miedo y comportamiento de manada")
    try:
        vix, _ = load("^VIX", csv_map)
        spx, _ = load("^GSPC", csv_map)
    except Exception as e:  # noqa: BLE001
        print(f"(sin datos de VIX/S&P: {e})")
        return
    vd = dict(vix)
    last = vix[-1][0]
    ten_y = (date.fromisoformat(last) - timedelta(days=3652)).isoformat()
    v10 = [v for dt, v in vix if dt >= ten_y]
    v_now = vix[-1][1]
    print("| Indicador | Valor | Percentil 10 años | Lectura numérica |")
    print("|---|---|---|---|")
    print(f"| VIX | {v_now:.2f} | {prob(pct_rank(v10, v_now))} | — |")
    try:
        v3, _ = load("^VIX3M", csv_map)
        v3d = dict(v3)
        ratios = [(dt, vd[dt] / v3d[dt]) for dt in vd if dt in v3d and dt >= ten_y and v3d[dt]]
        r_now = ratios[-1][1]
        share_inv = sum(1 for _, r in ratios if r > 1) / len(ratios)
        print(f"| VIX / VIX3M (>1 = estrés de corto plazo) | {r_now:.2f} | {prob(pct_rank([r for _, r in ratios], r_now))} | {share_inv * 100:.0f}% de los días de 10 años estuvieron >1 |")
    except Exception:  # noqa: BLE001
        pass
    # Other fear gauges, each against its own 10-year history.
    def level_row(label, rows, note=""):
        hist = [v for dt, v in rows if dt >= ten_y]
        if len(hist) < 260:
            return
        now, prev = rows[-1][1], rows[-22][1]
        print(f"| {label} | {now:.2f} | {prob(pct_rank(hist, now))} | 21d: {pct(now / prev - 1)}{note} |")

    for sym, label in (("^VXN", "VXN (volatilidad Nasdaq 100)"), ("^VVIX", "VVIX (volatilidad del VIX)"),
                       ("^SKEW", "SKEW (demanda de cobertura contra colas)"), ("^MOVE", "MOVE (volatilidad de bonos)")):
        try:
            level_row(label, load(sym, csv_map)[0])
        except Exception:  # noqa: BLE001
            pass
    for num, den, label, note in (("HYG", "LQD", "HYG/LQD (crédito basura vs grado de inversión)", "; baja = estrés de crédito"),
                                  ("RSP", "SPY", "RSP/SPY (igual peso vs capitalización)", "; baja = subida concentrada en pocas acciones")):
        try:
            a, b = dict(load(num, csv_map)[0]), dict(load(den, csv_map)[0])
            level_row(label, [(dt, a[dt] / b[dt]) for dt in sorted(a) if dt in b], note)
        except Exception:  # noqa: BLE001
            pass
    # S&P forward 21d when VIX was in today's 10-year decile.
    sd = [x[0] for x in spx]
    sp = [x[1] for x in spx]
    dec_lo, dec_hi = quantile(v10, math.floor(pct_rank(v10, v_now) * 10) / 10), quantile(v10, min(1, math.floor(pct_rank(v10, v_now) * 10) / 10 + 0.1))
    idx = [i for i, dt in enumerate(sd) if dt >= ten_y and dt in vd and dec_lo <= vd[dt] <= dec_hi]
    st = forward(sp, idx, 21)
    if st:
        print(f"| S&P 500 a 21 días con VIX en {dec_lo:.1f}–{dec_hi:.1f} | mediana {pct(st['med'])} | — | P(baja) {prob(st['p_down'])}, P5 {pct(st['p5'])}, n indep. {st['n_eff']} |")
    spf = features(sp)
    print(f"| S&P 500 vs máximo de 52 semanas | {pct(spf['dd52'][-1])} | — | racha {spf['streak'][-1]:+d} días |")
    # Herding: average pairwise correlation of the symbols given, 20d vs 1y.
    syms = [s for s in series if len(series[s]) > 260]
    if len(syms) >= 2:
        common = sorted(set.intersection(*(set(dict(series[s])) for s in syms)))
        rets = {}
        for s in syms:
            m = dict(series[s])
            px = [m[dt] for dt in common]
            rets[s] = [px[i] / px[i - 1] - 1 for i in range(1, len(px))]

        def avg_corr(k):
            cs = []
            for a in range(len(syms)):
                for b in range(a + 1, len(syms)):
                    x, y = rets[syms[a]][-k:], rets[syms[b]][-k:]
                    mx, my = sum(x) / k, sum(y) / k
                    cov = sum((x[i] - mx) * (y[i] - my) for i in range(k))
                    vx = sum((v - mx) ** 2 for v in x)
                    vy = sum((v - my) ** 2 for v in y)
                    if vx > 0 and vy > 0:
                        cs.append(cov / math.sqrt(vx * vy))
            return sum(cs) / len(cs) if cs else float("nan")

        c20, c252 = avg_corr(20), avg_corr(252)
        print(f"| Correlación media entre {', '.join(syms)} (20d vs 1 año) | {c20:.2f} vs {c252:.2f} | — | {'sube: activos moviéndose en bloque' if c20 > c252 + 0.1 else 'sin cambio relevante'} |")
        below = sum(1 for s in syms if series[s][-1][1] < sum(v for _, v in series[s][-50:]) / 50)
        print(f"| Amplitud de la lista: debajo de su media de 50 días | {below}/{len(syms)} | — | — |")


# ---------------------------------------------------------------- portfolio

def portfolio_report(spec, fx_sym, cash, horizons, csv_map, proxies, years):
    pos = []
    for part in spec.split(","):
        sym, qty = part.split("=")
        pos.append((sym.strip(), float(qty)))
    fx = dict(load(fx_sym, csv_map)[0]) if fx_sym else None
    data = {}
    for sym, _ in pos:
        rows, cur = load(sym, csv_map)
        src = sym
        if sym in proxies:
            prow, _ = load(proxies[sym], csv_map)
            first = rows[0][0]
            # Splice the proxy's returns before the fund existed, scaled to the fund's first price.
            pm = dict(prow)
            base = pm.get(first)
            if base:
                rows = [(dt, v * rows[0][1] / base) for dt, v in prow if dt < first] + rows
                src = f"{sym} (antes de {first}: {proxies[sym]})"
        data[sym] = (dict(rows), cur or "USD", src)
    cal = sorted(set().union(*(set(m) for m, _, _ in data.values())))
    start = (date.fromisoformat(cal[-1]) - timedelta(days=int(365.25 * years))).isoformat()
    cal = [dt for dt in cal if dt >= start]

    def asof(m, keys):
        out, last = [], None
        for dt in keys:
            if dt in m:
                last = m[dt]
            out.append(last)
        return out

    fxs = asof(fx, cal) if fx else None
    series = {}
    for sym, (m, cur, _) in data.items():
        px = asof(m, cal)
        if fx and cur == "USD":
            px = [a * b if a is not None and b is not None else None for a, b in zip(px, fxs)]
        series[sym] = px
    # Drop dates where any position has no price yet.
    keep = [i for i in range(len(cal)) if all(series[s][i] is not None for s in series)]
    cal = [cal[i] for i in keep]
    for s in series:
        series[s] = [series[s][i] for i in keep]
    values = {s: q * series[s][-1] for s, q in pos}
    total = sum(values.values()) + cash
    ccy = "MXN" if fx else "USD"

    print(f"\n## Cartera — valor {total:,.0f} {ccy} al {cal[-1]} (historia usada desde {cal[0]})")
    for s, q in pos:
        print(f"- {data[s][2]}: {q:g} × → {values[s]:,.0f} {ccy} ({values[s] / total * 100:.1f}%)")
    if cash:
        print(f"- Efectivo: {cash:,.0f} {ccy} ({cash / total * 100:.1f}%)")
    n = len(cal) - 1
    # Holdings are usually past winners, so their historical drift flatters the
    # forward distribution (survivorship). The "sin deriva" rows remove each
    # asset's average daily return and keep only volatility and co-movement.
    mu = {s: sum(series[s][i] / series[s][i - 1] - 1 for i in range(1, n + 1)) / n for s in values}
    three_y_i = next((i for i, dt in enumerate(cal) if dt >= (date.fromisoformat(cal[-1]) - timedelta(days=1096)).isoformat()), 0)
    for h in horizons:
        res = {False: ([], []), True: ([], [])}
        for t in range(0, n - h + 1):
            for demean in (False, True):
                path = []
                for k in range(1, h + 1):
                    path.append(sum(values[s] * (series[s][t + k] / series[s][t] / ((1 + mu[s]) ** k if demean else 1) - 1) for s in values))
                res[demean][0].append(path[-1])
                res[demean][1].append(min(path))
        print(f"\n### Cartera: horizonte {h} días hábiles (valores actuales, rendimientos históricos)")
        print(f"| Muestra | n | P(pérdida) | P(pérdida >1%) | P(>2%) | P(>5%) | P(ganancia >2%) | Mediana | P5 | P95 | CVaR 5% | Peor punto intermedio mediano / P25 |")
        print("|---|---|---|---|---|---|---|---|---|---|---|---|")
        for name, lo, demean in (("todo el periodo", 0, False), ("últimos 3 años", three_y_i, False),
                                 ("todo el periodo, sin deriva ⚠ref", 0, True), ("últimos 3 años, sin deriva", three_y_i, True)):
            xs, ms = res[demean][0][lo:], res[demean][1][lo:]
            if not xs:
                continue
            f = lambda th: sum(1 for x in xs if x < -th * total) / len(xs)
            g2 = sum(1 for x in xs if x > 0.02 * total) / len(xs)
            print(f"| {name} | {len(xs)} | {prob(sum(1 for x in xs if x < 0) / len(xs))} | {prob(f(0.01))} | {prob(f(0.02))} | {prob(f(0.05))} | {prob(g2)} | "
                  f"{quantile(xs, .5):+,.0f} | {quantile(xs, .05):+,.0f} | {quantile(xs, .95):+,.0f} | {cvar(xs):+,.0f} | {quantile(ms, .5):+,.0f} / {quantile(ms, .25):+,.0f} |")
    print(f"\nCifras en {ccy}. ⚠ref = referencia para riesgo hacia adelante: las filas con deriva incluyen la subida pasada de activos que hoy se tienen porque subieron. Para recuperar una caída de X% hace falta subir X/(1−X): −10% → +11.1%, −20% → +25%, −30% → +42.9%.")


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("symbols", nargs="*")
    ap.add_argument("--horizons", default="5,10,21")
    ap.add_argument("--band", type=float, default=0.05, help="tolerancia para emparejar la distancia al máximo")
    ap.add_argument("--market", action="store_true", help="añade el panel de miedo y manada")
    ap.add_argument("--portfolio", help='posiciones "SYM=cantidad,..."')
    ap.add_argument("--fx", help="símbolo de tipo de cambio para convertir activos en USD (p. ej. MXN=X)")
    ap.add_argument("--cash", type=float, default=0.0)
    ap.add_argument("--years", type=float, default=20, help="años de historia para la cartera")
    ap.add_argument("--no-proxy", action="store_true", help="no extender ETFs jóvenes con su equivalente")
    ap.add_argument("--csv", action="append", default=[], help="SYM=archivo.csv con date,close")
    a = ap.parse_args()
    horizons = [int(x) for x in a.horizons.split(",") if x]
    csv_map = dict(x.split("=", 1) for x in a.csv)
    series = {}
    for s in a.symbols:
        try:
            rows, _ = load(s, csv_map)
        except Exception as e:  # noqa: BLE001
            print(f"\n## {s}: error al cargar ({e})")
            continue
        series[s] = rows
        symbol_report(s, rows, horizons, a.band)
    if a.market:
        market_panel(series, csv_map)
    if a.portfolio:
        portfolio_report(a.portfolio, a.fx, a.cash, horizons, csv_map, {} if a.no_proxy else DEFAULT_PROXIES, a.years)
    print("\nMuestras con traslape: 'n' cuenta días; 'indep.' cuenta episodios sin traslape. Las cifras son frecuencias históricas, no garantías.")


if __name__ == "__main__":
    sys.exit(main())
