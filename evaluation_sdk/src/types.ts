export type BusStopStatus = "Unknown" | "Safe" | "Fair" | "Unsafe";

export type RoadContext = {
  nearestRoadDistanceM: number;
  roadType: string | null;
  maxspeed: string | number | null;
  slopePct: number | null;
  slopeRule: "Unknown" | "OK (≤5%)" | "Caution (5–8%)" | "Too steep (>8%)";
  estimatedRoadWidthM: number;
};

export type BusStopEvaluationResponse = {
  input: { lat: number; lng: number };
  roadContext: RoadContext | null;
  gptEvaluation: Record<string, any>;
  distanceMetricsMeters: Record<string, number | null>;
  distanceScores: Record<string, number>;
  combined: {
    finalAvg: number | null;
    status: BusStopStatus;
    allScores: Record<string, number>;
  };
};

export type BusStopSDKOptions = {
  baseUrl: string;       // e.g. "http://127.0.0.1:3001"
  timeoutMs?: number;    // default 30000
  apiKey?: string;       // optional
};
