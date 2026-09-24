import { REQUEST_TIMEOUT_MS, SEC_MAX_REQUESTS_PER_SECOND } from "../constants.js";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export type Host = "data" | "www" | "efts" | "yahoo" | "treasury";

const HOSTS: Record<Host, string> = {
  data: "https://data.sec.gov",
  www: "https://www.sec.gov",
  efts: "https://efts.sec.gov",
  yahoo: "https://query1.finance.yahoo.com",
  treasury: "https://home.treasury.gov",
};

/** Build a URL; EDGAR_MOCK_BASE redirects every host to a local mock (used by tests). */
export function hostUrl(host: Host, pathAndQuery: string): string {
  const mock = process.env.EDGAR_MOCK_BASE;
  return mock ? `${mock.replace(/\/$/, "")}/${host}${pathAndQuery}` : HOSTS[host] + pathAndQuery;
}

export function secUserAgent(): string {
  const ua = process.env.SEC_USER_AGENT;
  if (!ua) throw new Error("SEC_USER_AGENT is not set. The SEC requires a contact, e.g. 'Your Name your.email@example.com'.");
  return ua;
}

// ---------- SEC throttle (sliding one-second window) ----------

const recent: number[] = [];
async function throttle(): Promise<void> {
  for (;;) {
    const now = Date.now();
    while (recent.length && now - recent[0] >= 1000) recent.shift();
    if (recent.length < SEC_MAX_REQUESTS_PER_SECOND) {
      recent.push(now);
      return;
    }
    await new Promise((r) => setTimeout(r, 1000 - (now - recent[0]) + 5));
  }
}

// ---------- Small TTL + LRU cache ----------

const CACHE_MAX_ENTRIES = 40;
const cache = new Map<string, { at: number; ttl: number; value: unknown }>();

function cacheGet<T>(key: string): T | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > hit.ttl) {
    cache.delete(key);
    return undefined;
  }
  cache.delete(key);
  cache.set(key, hit); // refresh LRU position
  return hit.value as T;
}

function cacheSet(key: string, value: unknown, ttl: number): void {
  cache.set(key, { at: Date.now(), ttl, value });
  while (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value!);
}

export interface GetOptions {
  as?: "json" | "text";
  /** Cache TTL in ms; 0 disables caching. */
  ttl?: number;
}

/** GET with SEC-compliant headers, throttling, retry on 429/5xx, and optional caching. */
export async function httpGet<T = unknown>(host: Host, pathAndQuery: string, opts: GetOptions = {}): Promise<T> {
  const as = opts.as ?? "json";
  const url = hostUrl(host, pathAndQuery);
  const key = `${as}:${url}`;
  if (opts.ttl) {
    const hit = cacheGet<T>(key);
    if (hit !== undefined) return hit;
  }

  const isSec = host === "data" || host === "www" || host === "efts";
  const headers: Record<string, string> = {
    "User-Agent": isSec ? secUserAgent() : "Mozilla/5.0 (compatible; edgar-mcp-server)",
    Accept: as === "json" ? "application/json" : "*/*",
  };

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (isSec) await throttle();
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.status === 429 || res.status >= 500) {
        lastError = new HttpError(res.status, url, res.statusText);
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      const body = await res.text();
      if (!res.ok) throw new HttpError(res.status, url, body.slice(0, 200) || res.statusText);
      const value = (as === "json" ? JSON.parse(body) : body) as T;
      if (opts.ttl) cacheSet(key, value, opts.ttl);
      return value;
    } catch (e) {
      if (e instanceof HttpError) throw e;
      lastError = e;
      if (e instanceof SyntaxError) break;
    }
  }
  throw lastError;
}

export function formatError(error: unknown): string {
  if (error instanceof HttpError) {
    switch (error.status) {
      case 403:
        return `Error: Access denied by ${new URL(error.url).host} (HTTP 403). For SEC endpoints make sure SEC_USER_AGENT contains a real name and email, and stay under 10 requests/second.`;
      case 404:
        return "Error: Not found (HTTP 404). Check the company identifier, accession number or XBRL concept name. Use edgar_search_companies or edgar_search_concepts to find valid values.";
      case 429:
        return "Error: Rate limited (HTTP 429) after retries. Wait a few seconds and make fewer parallel calls.";
      default:
        return `Error: Request failed with HTTP ${error.status}: ${error.message}`;
    }
  }
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return "Error: Request timed out. Try again or narrow the request.";
    return `Error: ${error.message}`;
  }
  return `Error: ${String(error)}`;
}
