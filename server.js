const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const turf = require("@turf/turf");

const app = express();
app.use((req, res, next) => {
  console.log("➡️", req.method, req.url);
  next();
});
app.use(cors());
app.use(express.json());

app.get("/ping", (req, res) => res.json({ ok: true }));

// ---------- CONFIG ----------
const DATA_DIR = path.resolve("./extracted_features"); // adjust to your folder
const FLASK_EVAL_URL = "http://localhost:5000/evaluate";

// You can add/remove layers as needed (these mirror your viewer.html layerConfigs)
const LAYERS = {
  Railways: "railways.geojson",
  Water: "water.geojson",
  Footpaths: "footpaths.geojson",
  Ramps: "ramps.geojson",
  BikeLanes: "bike_lanes.geojson",
  BusStops: "bus_stops.geojson",
  TrafficLights: "small-traffic_lights.geojson",
  Intersections: "small_intersections.geojson",
  Roads: "small-nevada-roads_with_slope.geojson", // for nearest-road props/slope
};

// ---------- LOAD GEOJSON ONCE ----------
function loadGeoJSON(name) {
  const filePath = path.join(DATA_DIR, name);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

const geo = {};
for (const [label, filename] of Object.entries(LAYERS)) {
  geo[label] = loadGeoJSON(filename);
}

// ---------- SCORING (ported from your viewer.html idea) ----------
function scoreDistance(label, distMeters) {
  if (!Number.isFinite(distMeters)) return 0;

  // “Bad to be close” features
  if (["Railways", "Water", "Ramps"].includes(label)) {
    if (distMeters < 20) return 1;
    if (distMeters < 50) return 4;
    if (distMeters < 100) return 6;
    return 9;
  }

  // “Good to be close” features
  if (["Footpaths", "BikeLanes", "BusStops", "TrafficLights"].includes(label)) {
    if (distMeters < 10) return 9;
    if (distMeters < 30) return 7;
    if (distMeters < 60) return 5;
    return 2;
  }

  return 4;
}

// Compute min distance from a point to a feature (Point/LineString/Polygon)
function minDistanceToFeature(point, feature) {
  const t = feature.geometry?.type;
  if (!t) return Infinity;

  if (t === "Point") {
    return turf.distance(point, feature, { units: "meters" });
  }

  if (t === "LineString") {
    return turf.pointToLineDistance(point, feature, { units: "meters" });
  }

  if (t === "MultiLineString") {
    // Compute min distance to each LineString part
    let best = Infinity;
    const lines = feature.geometry.coordinates || [];
    for (const coords of lines) {
      if (!coords || coords.length < 2) continue;
      const line = turf.lineString(coords, feature.properties || {});
      const d = turf.pointToLineDistance(point, line, { units: "meters" });
      if (d < best) best = d;
    }
    return best;
  }

  if (t === "Polygon" || t === "MultiPolygon") {
    if (turf.booleanPointInPolygon(point, feature)) return 0;
    const boundary = turf.polygonToLine(feature);

    // boundary may be LineString or MultiLineString → handle both
    const bt = boundary.geometry?.type;
    if (bt === "LineString") {
      return turf.pointToLineDistance(point, boundary, { units: "meters" });
    }
    if (bt === "MultiLineString") {
      let best = Infinity;
      for (const coords of boundary.geometry.coordinates || []) {
        if (!coords || coords.length < 2) continue;
        const line = turf.lineString(coords);
        const d = turf.pointToLineDistance(point, line, { units: "meters" });
        if (d < best) best = d;
      }
      return best;
    }

    return Infinity;
  }

  return Infinity;
}


function getMinDistanceToLayer(point, featureCollection) {
  let min = Infinity;
  for (const f of featureCollection.features || []) {
    const d = minDistanceToFeature(point, f);
    if (d < min) min = d;
  }
  return min;
}

// Nearest road segment + props (for slope, speed, road type)
function distancePointToLineAny(point, feature) {
  const gt = feature.geometry?.type;
  if (gt === "LineString") {
    return turf.pointToLineDistance(point, feature, { units: "meters" });
  }
  if (gt === "MultiLineString") {
    let best = Infinity;
    for (const coords of feature.geometry.coordinates || []) {
      if (!coords || coords.length < 2) continue;
      const line = turf.lineString(coords, feature.properties || {});
      const d = turf.pointToLineDistance(point, line, { units: "meters" });
      if (d < best) best = d;
    }
    return best;
  }
  return Infinity;
}

function distancePointToLineAny(point, feature) {
  const gt = feature.geometry?.type;
  if (gt === "LineString") {
    return turf.pointToLineDistance(point, feature, { units: "meters" });
  }
  if (gt === "MultiLineString") {
    let best = Infinity;
    for (const coords of feature.geometry.coordinates || []) {
      if (!coords || coords.length < 2) continue;
      const line = turf.lineString(coords, feature.properties || {});
      const d = turf.pointToLineDistance(point, line, { units: "meters" });
      if (d < best) best = d;
    }
    return best;
  }
  return Infinity;
}

function getNearestRoad(point, roadsFC) {
  let best = null;
  let bestDist = Infinity;

  for (const f of roadsFC.features || []) {
    const gt = f.geometry?.type;
    if (gt !== "LineString" && gt !== "MultiLineString") continue;

    const d = distancePointToLineAny(point, f);
    if (d < bestDist) {
      bestDist = d;
      best = f;
    }
  }
  return best ? { feature: best, distMeters: bestDist } : null;
}


const widthByTypeM = {
  motorway: 22, trunk: 20, primary: 18, secondary: 16, tertiary: 14,
  residential: 10, service: 7, living_street: 6, unclassified: 8, default: 9
};

function estimateRoadWidthMeters(roadProps) {
  const type = (roadProps?.highway || "default");
  return widthByTypeM[type] ?? widthByTypeM.default;
}

// ---------- THE API ----------


app.get("/api/busstopevaluation", async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: "Invalid lat/lng" });
    }

    const point = turf.point([lng, lat]);

    // 1) Distance-based scoring
    const distanceMetrics = {};
    const distanceScores = {};

    // Decide which layers participate in distance scoring (skip Roads itself)
    const distanceLayerLabels = [
      "Railways", "Water", "Ramps",
      "Footpaths", "BikeLanes", "BusStops", "TrafficLights",
      "Intersections",
    ];

    for (const label of distanceLayerLabels) {
      const fc = geo[label];
      if (!fc) continue;

      const d = getMinDistanceToLayer(point, fc);
      distanceMetrics[label] = Number.isFinite(d) ? d : null;
      distanceScores[label] = scoreDistance(label, d);
    }

    // 2) Nearest road context (slope/speed/width)
    const nearRoad = getNearestRoad(point, geo.Roads);
    let roadContext = null;

    if (nearRoad) {
      const props = nearRoad.feature.properties || {};
      const slopePct =
        Number.isFinite(Number(props.max_abs_grade_pct_step)) ? Number(props.max_abs_grade_pct_step) :
        Number.isFinite(Number(props.grade_pct)) ? Number(props.grade_pct) :
        null;

      roadContext = {
        nearestRoadDistanceM: nearRoad.distMeters,
        roadType: props.highway ?? null,
        maxspeed: props.maxspeed ?? props.speed_limit ?? null,
        slopePct,
        slopeRule:
          slopePct == null ? "Unknown" :
          slopePct <= 5 ? "OK (≤5%)" :
          slopePct <= 8 ? "Caution (5–8%)" :
          "Too steep (>8%)",
        estimatedRoadWidthM: estimateRoadWidthMeters(props),
      };
    }

    // 3) GPT-Vision evaluation (reuse your Flask server)
    // Flask expects {lat, lon} (lon = lng) :contentReference[oaicite:3]{index=3}
    const gptResp = await fetch(FLASK_EVAL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat, lon: lng }),
    });

    if (!gptResp.ok) {
      const text = await gptResp.text();
      return res.status(502).json({ error: "Flask /evaluate failed", details: text });
    }

    const gpt = await gptResp.json();

    // 4) Combine (similar to your frontend averaging)
    // Pick score fields:
    const gptScoreKeys = Object.keys(gpt).filter(k => k.endsWith(" Score"));
    const gptScores = {};
    for (const k of gptScoreKeys) gptScores[k] = Number(gpt[k]);

    const allScores = {
      ...distanceScores,
      ...gptScores,
    };

    const vals = Object.values(allScores).filter(v => Number.isFinite(v));
    const finalAvg = vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length) : null;

    const status =
      finalAvg == null ? "Unknown" :
      finalAvg >= 7 ? "Safe" :
      finalAvg < 4 ? "Unsafe" :
      "Fair";

    return res.json({
      input: { lat, lng },
      roadContext,
      gptEvaluation: gpt,              // includes descriptions + “Score” fields
      distanceMetricsMeters: distanceMetrics,
      distanceScores,
      combined: {
        finalAvg,
        status,
        allScores,
      },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error", details: String(err?.message || err) });
  }
});

app.listen(3001, "127.0.0.1", () => {
  console.log("✅ Express listening on http://127.0.0.1:3001");
});
