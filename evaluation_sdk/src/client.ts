import type { BusStopEvaluationResponse, BusStopSDKOptions } from "./types";

export class BusStopSDK {
  private baseUrl: string;
  private timeoutMs: number;
  private apiKey?: string;

  constructor(opts: BusStopSDKOptions) {
    if (!opts?.baseUrl) throw new Error("baseUrl is required");
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.apiKey = opts.apiKey;
  }

  /**
   * Optional: quick health check.
   * Add a /ping endpoint on your Node server if you want this to work.
   */
  async ping(): Promise<boolean> {
    const url = new URL(`${this.baseUrl}/ping`);
    const res = await this._fetch(url.toString());
    return res.ok;
  }

  /**
   * Calls:
   * GET {baseUrl}/api/busstopevaluation?lat=...&lng=...
   */
  async evaluate(lat: number, lng: number): Promise<BusStopEvaluationResponse> {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new Error("lat/lng must be finite numbers");
    }

    const url = new URL(`${this.baseUrl}/api/busstopevaluation`);
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lng", String(lng));

    const res = await this._fetch(url.toString());

    const text = await res.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }

    if (!res.ok) {
      const msg = typeof data === "string" ? data : JSON.stringify(data);
      throw new Error(`BusStopSDK.evaluate failed: HTTP ${res.status} ${msg}`);
    }

    return data as BusStopEvaluationResponse;
  }

  // -----------------------
  // internal fetch wrapper
  // -----------------------
  private async _fetch(url: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {
        Accept: "application/json"
      };
      if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

      return await fetch(url, {
        method: "GET",
        headers,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
