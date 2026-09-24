import { httpGet } from "./http.js";

export interface Fact {
  start?: string;
  end: string;
  val: number;
  accn: string;
  fy?: number;
  fp?: string;
  form: string;
  filed: string;
  frame?: string;
}

export interface Concept {
  label?: string;
  description?: string;
  units: Record<string, Fact[]>;
}

export interface CompanyFacts {
  cik: number;
  entityName: string;
  facts: Record<string, Record<string, Concept>>;
}

export type PeriodKind = "annual" | "quarterly";

const HOUR_MS = 60 * 60 * 1000;

export function getCompanyFacts(cik: string): Promise<CompanyFacts> {
  return httpGet<CompanyFacts>("data", `/api/xbrl/companyfacts/CIK${cik}.json`, { ttl: HOUR_MS });
}

const PERIODIC_FORMS = /^(10-K|10-Q|20-F|40-F|10-KT)(\/A)?$/;
const ANNUAL_FORMS = /^(10-K|20-F|40-F|10-KT)(\/A)?$/;

export const days = (start: string, end: string) => (Date.parse(end) - Date.parse(start)) / 86_400_000;

export interface Point {
  start?: string;
  end: string;
  val: number;
  filed: string;
  form: string;
  concept: string;
  unit: string;
  derived?: boolean;
}

/** Resolve 'us-gaap:Revenues' (or bare 'Revenues', searched in us-gaap, ifrs-full, dei). */
export function findConcept(facts: CompanyFacts, name: string): { taxonomy: string; tag: string; concept: Concept } | undefined {
  const [tax, tag] = name.includes(":") ? name.split(":", 2) : [undefined, name];
  for (const taxonomy of tax ? [tax] : ["us-gaap", "ifrs-full", "dei", "srt"]) {
    const concept = facts.facts[taxonomy]?.[tag];
    if (concept) return { taxonomy, tag, concept };
  }
  return undefined;
}

function pickUnit(concept: Concept, preferred?: string): string | undefined {
  const units = Object.keys(concept.units);
  if (preferred && units.includes(preferred)) return preferred;
  if (preferred === "per_share") return units.find((u) => u.includes("/shares"));
  if (preferred === "shares") return units.find((u) => u === "shares");
  return units.find((u) => u === "USD") ?? units.find((u) => !u.includes("/")) ?? units[0];
}

const isAdditive = (unit: string) => unit !== "shares" && !unit.includes("/");

/**
 * Extract a clean period series for one concept. Duration facts are kept when they
 * span ~1 year (annual) or ~1 quarter (quarterly); instant facts keep their end date.
 * Duplicates (same period reported in several filings) resolve to the latest filing.
 * In quarterly mode, quarters that are only reported year-to-date (typical for cash
 * flows and fiscal Q4) are derived by differencing consecutive YTD values.
 */
export function conceptSeries(facts: CompanyFacts, name: string, kind: PeriodKind, unitPref?: string): Map<string, Point> {
  const out = new Map<string, Point>();
  const found = findConcept(facts, name);
  if (!found) return out;
  const unit = pickUnit(found.concept, unitPref);
  if (!unit) return out;
  const concept = `${found.taxonomy}:${found.tag}`;

  // Latest filing wins for each distinct period.
  const latest = new Map<string, Fact>();
  for (const f of found.concept.units[unit]) {
    if (!PERIODIC_FORMS.test(f.form)) continue;
    if (!f.start && kind === "annual" && !ANNUAL_FORMS.test(f.form)) continue;
    const key = `${f.start ?? ""}|${f.end}`;
    const prev = latest.get(key);
    if (!prev || f.filed > prev.filed) latest.set(key, f);
  }

  const toPoint = (f: Fact, extra: Partial<Point> = {}): Point => ({
    start: f.start, end: f.end, val: f.val, filed: f.filed, form: f.form, concept, unit, ...extra,
  });
  const durations: Fact[] = [];
  for (const f of latest.values()) {
    if (!f.start) {
      out.set(f.end, toPoint(f));
      continue;
    }
    durations.push(f);
    const d = days(f.start, f.end);
    if (kind === "annual" ? d >= 340 && d <= 380 : d >= 80 && d <= 100) out.set(f.end, toPoint(f));
  }

  if (kind === "quarterly" && isAdditive(unit)) {
    const byStart = new Map<string, Fact[]>();
    for (const f of durations) byStart.set(f.start!, [...(byStart.get(f.start!) ?? []), f]);
    for (const group of byStart.values()) {
      group.sort((a, b) => a.end.localeCompare(b.end));
      for (let i = 1; i < group.length; i++) {
        const prev = group[i - 1];
        const cur = group[i];
        const gap = days(prev.end, cur.end);
        if (out.has(cur.end) || gap < 80 || gap > 100 || days(cur.start!, cur.end) > 380) continue;
        const qStart = new Date(Date.parse(prev.end) + 86_400_000).toISOString().slice(0, 10);
        out.set(cur.end, toPoint(cur, { start: qStart, val: cur.val - prev.val, derived: true }));
      }
    }
  }
  return out;
}

// Series are derived from the cached (immutable) facts object, so memoize them per object.
const seriesMemo = new WeakMap<CompanyFacts, Map<string, Map<string, Point>>>();

/**
 * Merge candidate concepts: for each period, the first candidate with a value wins.
 * The returned map is memoized and shared between callers: do not mutate it.
 */
export function firstAvailable(facts: CompanyFacts, candidates: string[], kind: PeriodKind, unitPref?: string): Map<string, Point> {
  let memo = seriesMemo.get(facts);
  if (!memo) seriesMemo.set(facts, (memo = new Map()));
  const key = `${kind}|${unitPref ?? ""}|${candidates.join(",")}`;
  const hit = memo.get(key);
  if (hit) return hit;
  const merged = new Map<string, Point>();
  for (const c of candidates) {
    for (const [end, p] of conceptSeries(facts, c, kind, unitPref)) if (!merged.has(end)) merged.set(end, p);
  }
  memo.set(key, merged);
  return merged;
}
