/**
 * US Treasury auction results (Fiscal Data API): demand measured by bid-to-cover and by how much of
 * the issue primary dealers had to absorb, each compared with the previous auctions of the same tenor.
 */
import { httpGet } from "../services/http.js";

interface Raw {
  auction_date: string;
  security_type: string;
  security_term: string;
  original_security_term: string;
  high_yield: string;
  bid_to_cover_ratio: string;
  primary_dealer_accepted: string;
  indirect_bidder_accepted: string;
  total_accepted: string;
  offering_amt: string;
  reopening: string;
  floating_rate: string;
  inflation_index_security: string;
}

export interface AuctionResult {
  date: string;
  type: string;
  term: string;
  reopening: boolean;
  highYield: number | null;
  bidToCover: number | null;
  dealerShare: number | null;
  indirectShare: number | null;
  offering: number | null;
  /** Averages over up to 6 previous auctions of the same original tenor. */
  prevBidToCover: number | null;
  prevDealerShare: number | null;
}

const num = (s: string) => (s && s !== "null" ? Number(s) : null);
const avg = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x !== null && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

export function summarizeAuctions(rows: Raw[], limit: number): AuctionResult[] {
  const parsed = rows
    // Floating-rate notes have no yield and a different buyer base; TIPS are labelled.
    .filter((r) => num(r.bid_to_cover_ratio) && r.floating_rate !== "Yes")
    .map((r) => {
      const total = num(r.total_accepted);
      return {
        date: r.auction_date,
        type: r.security_type,
        term: `${r.original_security_term || r.security_term}${r.inflation_index_security === "Yes" ? " TIPS" : ""}`,
        reopening: r.reopening === "Yes",
        highYield: num(r.high_yield),
        bidToCover: num(r.bid_to_cover_ratio),
        dealerShare: total ? (num(r.primary_dealer_accepted) ?? 0) / total : null,
        indirectShare: total ? (num(r.indirect_bidder_accepted) ?? 0) / total : null,
        offering: num(r.offering_amt),
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
  return parsed.slice(0, limit).map((a) => {
    const prev = parsed.filter((p) => p.term === a.term && p.date < a.date).slice(0, 6);
    return { ...a, prevBidToCover: avg(prev.map((p) => p.bidToCover)), prevDealerShare: avg(prev.map((p) => p.dealerShare)) };
  });
}

export async function getAuctions(limit: number, today = new Date().toISOString().slice(0, 10)): Promise<AuctionResult[]> {
  const fields = "auction_date,security_type,security_term,original_security_term,high_yield,bid_to_cover_ratio,primary_dealer_accepted,indirect_bidder_accepted,total_accepted,offering_amt,reopening,floating_rate,inflation_index_security";
  const res = await httpGet<{ data: Raw[] }>(
    "fiscaldata",
    `/services/api/fiscal_service/v1/accounting/od/auctions_query?fields=${fields}&filter=security_type:in:(Note,Bond),auction_date:lte:${today}&sort=-auction_date&page%5Bsize%5D=300`,
    { ttl: 6 * 3600 * 1000 },
  );
  return summarizeAuctions(res.data ?? [], limit);
}
