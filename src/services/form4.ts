/** Parsing of Form 4 (statement of changes in beneficial ownership) XML. */

const CODES: Record<string, string> = {
  P: "Open-market buy", S: "Open-market sale", A: "Grant/award", M: "Option exercise", F: "Tax withholding",
  G: "Gift", D: "Disposed to issuer", C: "Conversion", X: "Option exercise (in the money)", J: "Other", W: "Will/inheritance",
};

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'");

/** Text of the first <name> element, or of its <value> child (Form 4 wraps most fields that way, often next to footnote refs). */
function tag(xml: string, name: string): string | undefined {
  const inner = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i"))?.[1];
  if (inner === undefined) return undefined;
  const value = inner.match(/<value>([^<]*)<\/value>/i)?.[1] ?? inner;
  return decode(value.trim()) || undefined;
}
const blocks = (xml: string, name: string) => xml.match(new RegExp(`<${name}>[\\s\\S]*?</${name}>`, "gi")) ?? [];
const num = (s?: string) => (s === undefined || s === "" ? undefined : Number(s));
const isTrue = (s?: string) => s === "1" || s?.toLowerCase() === "true";

/** A footnote that says the trade was made under a 10b5-1 plan (and not that it wasn't). */
const mentionsPlan = (text: string) => /10b5-?1/i.test(text) && !/\bnot\b[^.]{0,80}10b5-?1/i.test(text);

export interface Trade {
  filed: string;
  insider: string;
  role: string;
  date?: string;
  code?: string;
  type: string;
  shares?: number;
  price?: number;
  value?: number;
  acquiredDisposed?: string;
  ownedAfter?: number;
  plan10b5_1: boolean;
  url: string;
}

/** CIK of the company whose shares the filing reports (a filer's own Form 4 list also holds filings it made as an investor in other companies). */
export function form4IssuerCik(xml: string): number | undefined {
  const cik = Number(tag(blocks(xml, "issuer")[0] ?? "", "issuerCik"));
  return Number.isFinite(cik) && cik > 0 ? cik : undefined;
}

export function parseForm4(xml: string, filed: string, url: string): Trade[] {
  const owners = blocks(xml, "reportingOwner");
  const names = owners.map((o) => tag(o, "rptOwnerName")).filter(Boolean);
  const first = owners[0] ?? xml;
  const roles = [
    isTrue(tag(first, "isDirector")) ? "Director" : "",
    tag(first, "officerTitle") ?? (isTrue(tag(first, "isOfficer")) ? "Officer" : ""),
    isTrue(tag(first, "isTenPercentOwner")) ? "10% owner" : "",
  ].filter(Boolean);

  const footnotes = new Map(
    [...xml.matchAll(/<footnote\s+id="([^"]+)"\s*>([\s\S]*?)<\/footnote>/gi)].map((m) => [m[1], decode(m[2])]),
  );
  const transactions = blocks(xml, "nonDerivativeTransaction");
  const planByNote = transactions.map((t) => [...t.matchAll(/<footnoteId\s+id="([^"]+)"/gi)].some((m) => mentionsPlan(footnotes.get(m[1]) ?? "")));

  // Since 2023 the form has a 10b5-1 checkbox, but it covers the whole filing, which can also
  // hold gifts or tax withholdings. When it is ticked, credit the plan to the transactions whose
  // footnotes cite it; if no footnote does, to all of them. Older filings only have footnotes.
  const planBox = tag(xml, "aff10b5One");
  const plans =
    planBox === undefined ? planByNote : !isTrue(planBox) ? planByNote.map(() => false) : planByNote.some(Boolean) ? planByNote : planByNote.map(() => true);

  return transactions.map((t, i) => {
    const shares = num(tag(t, "transactionShares"));
    const price = num(tag(t, "transactionPricePerShare"));
    const code = t.match(/<transactionCode>\s*([A-Z])\s*<\/transactionCode>/)?.[1];
    const plan = plans[i];
    return {
      filed,
      insider: names.join(" / ") || "Unknown",
      role: roles.join(", ") || "–",
      date: tag(t, "transactionDate"),
      code,
      type: code ? (CODES[code] ?? code) : "–",
      shares,
      price,
      value: shares !== undefined && price ? shares * price : undefined,
      acquiredDisposed: tag(t, "transactionAcquiredDisposedCode"),
      ownedAfter: num(tag(t, "sharesOwnedFollowingTransaction")),
      plan10b5_1: plan,
      url,
    };
  });
}
