import { HttpError } from "../http.js";

/** Binance refuses some countries with HTTP 451 (or 403 from its CDN). */
export const isGeoBlock = (err: unknown): err is HttpError => err instanceof HttpError && (err.status === 451 || err.status === 403);

/**
 * Remembers that an API refused the country the connection comes from, and asks again after a while: a
 * phone can come out through another country for a time (a VPN, roaming) and then back to Mexico.
 */
export class GeoBlock {
  private retryAt = 0;
  private blocked = false;

  constructor(private readonly retryMs = 30 * 60_000) {}

  /** Worth asking the API now. */
  get open(): boolean {
    return Date.now() >= this.retryAt;
  }

  get isBlocked(): boolean {
    return this.blocked;
  }

  /** Records a refusal; true the first time, to tell the user once. */
  refuse(): boolean {
    this.retryAt = Date.now() + this.retryMs;
    const first = !this.blocked;
    this.blocked = true;
    return first;
  }

  /** Records an answer; true when it comes after a refusal. */
  accept(): boolean {
    const was = this.blocked;
    this.blocked = false;
    this.retryAt = 0;
    return was;
  }

  /** For tests: forget everything, or only the waiting time. */
  reset(keepBlocked = false): void {
    this.retryAt = 0;
    if (!keepBlocked) this.blocked = false;
  }
}
