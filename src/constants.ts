export const CHARACTER_LIMIT = 25_000;
export const REQUEST_TIMEOUT_MS = 30_000;
/** SEC fair-access policy allows 10 requests/second; stay safely below it. */
export const SEC_MAX_REQUESTS_PER_SECOND = 8;

export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}
