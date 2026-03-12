import type { BusStopEvaluationResponse, BusStopSDKOptions } from "./types";
export declare class BusStopSDK {
    private baseUrl;
    private timeoutMs;
    private apiKey?;
    constructor(opts: BusStopSDKOptions);
    /**
     * Optional: quick health check.
     * Add a /ping endpoint on your Node server if you want this to work.
     */
    ping(): Promise<boolean>;
    /**
     * Calls:
     * GET {baseUrl}/api/busstopevaluation?lat=...&lng=...
     */
    evaluate(lat: number, lng: number): Promise<BusStopEvaluationResponse>;
    private _fetch;
}
