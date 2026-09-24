import { CACHE_MAX_CHARS, REPO_URL, REQUEST_TIMEOUT_MS, SEC_MAX_REQUESTS_PER_SECOND, VERSION } from "../constants.js";

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

export type Host = "data" | "www" | "efts" | "yahoo" | "treasury" | "fred" | "fredapi" | "worldbank";

const HOSTS: Record<Host, string> = {
  data: "https://data.sec.gov",
  www: "https://www.sec.gov",
  efts: "https://efts.sec.gov",
  yahoo: "https://query1.finance.yahoo.com",
  treasury: "https://home.treasury.gov",
  fred: "https://fred.stlouisfed.org",
  fredapi: "https://api.stlouisfed.org",
  worldbank: "https://api.worldbank.org",
};

/** Descriptive client id; FRED's bot filter rejects generic ones such as "Mozilla/5.0" or Node's default. */
const CLIENT_UA = `edgar-mcp-server/${VERSION} (+${REPO_URL})`;

function userAgent(host: Host): string {
  if (host === "data" || host === "www" || host === "efts") return secUserAgent();
  if (host === "yahoo" || host === "treasury") return "Mozilla/5.0 (compatible; edgar-mcp-server)";
  return CLIENT_UA;
}

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

// ---------- TTL + LRU cache, bounded by size ----------

// Company facts for a large filer run to several MB each, so bound the cache by the size of
// the cached bodies (in characters) rather than by entry count.
const cache = new Map<string, { expires: number; size: number; value: unknown }>();
let cacheSize = 0;
const inflight = new Map<string, Promise<unknown>>();

function cacheDelete(key: string): void {
  const hit = cache.get(key);
  if (!hit) return;
  cacheSize -= hit.size;
  cache.delete(key);
}

function cacheGet<T>(key: string): T | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expires) {
    cacheDelete(key);
    return undefined;
  }
  cache.delete(key);
  cache.set(key, hit); // refresh LRU position
  return hit.value as T;
}

function cacheSet(key: string, value: unknown, ttl: number, size: number): void {
  if (size > CACHE_MAX_CHARS / 4) return; // one huge body must not flush everything else
  cacheDelete(key);
  cache.set(key, { expires: Date.now() + ttl, size, value });
  cacheSize += size;
  while (cacheSize > CACHE_MAX_CHARS) cacheDelete(cache.keys().next().value!);
}

/**
 * Memoize an async load under `key` for `ttl` ms. Concurrent callers share one in-flight
 * load, so parallel tool calls for the same company fetch it only once.
 */
export async function cached<T>(key: string, ttl: number, load: () => Promise<{ value: T; size: number }>): Promise<T> {
  const hit = cacheGet<T>(key);
  if (hit !== undefined) return hit;
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;
  const p = load()
    .then(({ value, size }) => {
      cacheSet(key, value, ttl, size);
      return value;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export interface GetOptions {
  as?: "json" | "text";
  /** Cache TTL in ms; 0 disables caching. */
  ttl?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_ATTEMPTS = 3;

/** Wait before retry `attempt` (0-based), honouring Retry-After (seconds) when the server sends it. */
function backoffMs(attempt: number, retryAfter?: string | null): number {
  const s = Number(retryAfter);
  return Number.isFinite(s) && s > 0 ? Math.min(s * 1000, 30_000) : 1000 * 2 ** attempt;
}

async function fetchBody(host: Host, url: string, as: "json" | "text"): Promise<string> {
  const isSec = host === "data" || host === "www" || host === "efts";
  const headers: Record<string, string> = { "User-Agent": userAgent(host), Accept: as === "json" ? "application/json" : "*/*" };

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (isSec) await throttle();
    let retryAfter: string | null = null;
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.status === 429 || res.status >= 500) {
        lastError = new HttpError(res.status, url, res.statusText);
        retryAfter = res.headers.get("retry-after");
        await res.body?.cancel().catch(() => undefined);
      } else {
        const body = await res.text();
        if (!res.ok) throw new HttpError(res.status, url, body.slice(0, 200) || res.statusText);
        return body;
      }
    } catch (e) {
      if (e instanceof HttpError) throw e;
      lastError = e; // network error or timeout: retry
    }
    if (attempt < MAX_ATTEMPTS - 1) await sleep(backoffMs(attempt, retryAfter));
  }
  throw lastError;
}

/** GET with SEC-compliant headers, throttling, retry on 429/5xx/network errors, and optional caching. */
export async function httpGet<T = unknown>(host: Host, pathAndQuery: string, opts: GetOptions = {}): Promise<T> {
  const as = opts.as ?? "json";
  const url = hostUrl(host, pathAndQuery);
  const load = async () => {
    const body = await fetchBody(host, url, as);
    return { value: (as === "json" ? JSON.parse(body) : body) as T, size: body.length };
  };
  if (!opts.ttl) return (await load()).value;
  return cached(`${as}:${url}`, opts.ttl, load);
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
