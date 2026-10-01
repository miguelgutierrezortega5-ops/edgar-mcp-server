export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly body: string,
  ) {
    super(`HTTP ${status} en ${url.split("?")[0]}: ${body.slice(0, 300)}`);
    this.name = "HttpError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** JSON request with a timeout; retries network errors, 429 and 5xx on GET only (orders are never resent). */
export async function httpJson<T>(url: string, init: RequestInit = {}, retries = 3): Promise<T> {
  const method = init.method ?? "GET";
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      if (method !== "GET" || attempt >= retries) throw err;
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    const text = await res.text();
    if (res.ok) return (text ? JSON.parse(text) : {}) as T;
    const retryable = res.status === 429 || res.status >= 500;
    if (method !== "GET" || !retryable || attempt >= retries) throw new HttpError(res.status, url, text);
    const after = Number(res.headers.get("retry-after"));
    await sleep(after > 0 ? Math.min(after, 30) * 1000 : 1000 * 2 ** attempt);
  }
}
