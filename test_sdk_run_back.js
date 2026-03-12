// test_sdk_run.js (CommonJS)
const util = require("util");
const fs = require("fs");
const path = require("path");

(async () => {
  try {
    const sdkModule = await import("./evaluation_sdk/dist/index.js");
    const { BusStopSDK } = sdkModule;

    const BASE_URL = "http://127.0.0.1:3001";

    const sdk = new BusStopSDK({
      baseUrl: BASE_URL,
      timeoutMs: 600000
    });

    // ping
    if (typeof sdk.ping === "function") {
      console.log("ping:", await sdk.ping());
    }

    // allow CLI args, fallback to your defaults
    const lat = process.argv[2] ? Number(process.argv[2]) : 36.1523113;
    const lng = process.argv[3] ? Number(process.argv[3]) : -115.1571111;

    console.log("\nCalling evaluate...");
    const resp = await sdk.evaluate(lat, lng);

    console.log("\n=== FULL BUS STOP EVALUATION MATRIX ===");
    console.log(util.inspect(resp, { depth: null, colors: true, maxArrayLength: null }));

    // ---- NEW: download PDF report from same server ----
    console.log("\nRequesting PDF report...");
    const r = await fetch(`${BASE_URL}/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat, lon: lng }) // NOTE: use lon if your server expects lon
    });

    if (!r.ok) {
      const text = await r.text();
      throw new Error(`PDF report failed: ${r.status} ${r.statusText}\n${text}`);
    }

    const pdfBytes = Buffer.from(await r.arrayBuffer());
    const outName = `busstop_report_${lat}_${lng}.pdf`.replace(/[^0-9._-]/g, "_");
    const outPath = path.resolve(process.cwd(), outName);
    fs.writeFileSync(outPath, pdfBytes);
    console.log("✅ Saved PDF:", outPath);

  } catch (err) {
    console.error("Test failed:", err);
    process.exit(1);
  }
})();
