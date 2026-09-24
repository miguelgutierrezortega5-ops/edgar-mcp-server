/** Keep in sync with package.json (checked by the unit tests). */
export const VERSION = "1.1.0";
export const REPO_URL = "https://github.com/miguelgutierrezortega5-ops/edgar-mcp-server";
export const CHARACTER_LIMIT = 25_000;
export const REQUEST_TIMEOUT_MS = 30_000;
/** SEC fair-access policy allows 10 requests/second; stay safely below it. */
export const SEC_MAX_REQUESTS_PER_SECOND = 8;
/**
 * Response cache budget, in characters of response body; parsed JSON takes ≈ 2-3× that in memory.
 * Company facts for a large filer are 5-8 MB, so the 100 MB default holds about 15 companies.
 */
export const CACHE_MAX_CHARS = (Number(process.env.EDGAR_CACHE_MAX_MB) || 100) * 1_000_000;

export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}
