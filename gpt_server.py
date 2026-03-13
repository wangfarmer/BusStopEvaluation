from flask import Flask, request, jsonify
import requests
import base64
from io import BytesIO
from openai import OpenAI
import json
from flask_cors import CORS
import os
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from reportlab.lib import colors
from reportlab.platypus import Table, TableStyle
import datetime
from flask import send_file
import uuid

app = Flask(__name__)
CORS(app)

GOOGLE_API_KEY = ""
client = OpenAI(base_url="http://localhost:1234/v1", api_key="lm-studio")
model_name = "qwen/qwen3-vl-30b"


# === Evaluation Prompt and Schema ===
PROMPT_TEMPLATE = """
You are evaluating a potential **school bus stop** location at coordinates ({lat}, {lon}) using **5 Street View images**.

IMPORTANT CONTEXT ABOUT THE IMAGES:
- The 5 images are the **same location** with the camera turned slightly left/right.
- A **red dot** appears in every image and marks the **target bus stop point** (where students would wait / where the stop is being evaluated).
- Use ALL images together to understand the surroundings, but keep your evaluation centered on the **red-dot location**.

CRITICAL RULES:
1) **Evidence-only**: Only describe and score what is clearly visible. Do NOT guess.
2) If something is not visible or is ambiguous, say so and use a score of **5**.
3) Do not “invent” signs, crosswalks, sidewalks, ramps, or visibility conditions that you cannot see.
4) If different images disagree (e.g., one view shows sidewalk, another does not), explain the uncertainty and score conservatively.

SCORING SCALE (1–9):
- **9** = Excellent / very safe (ideal, clearly safe with strong supportive features)
- **7–8** = Good / generally safe (minor issues but clearly usable)
- **4–6** = Fair / mixed (usable but notable concerns or uncertainty)
- **2–3** = Poor / unsafe (clear safety problems)
- **1** = Very poor / highly unsafe (severe hazards, unacceptable for a school stop)
- If cannot be evaluated from images: **5** and explain what is missing/unclear.

HOW TO SCORE (ANCHORS):
- Score higher when the red-dot area provides **safe waiting space**, **good driver visibility**, and **safe bus operations**.
- Score lower when the red-dot area has **no shoulder/space**, **fast traffic close by**, **blocked visibility**, **no pedestrian infrastructure**, or **dangerous crossings**.

EVALUATION CRITERIA (score each 1–9 + give a brief reason):
1) **Posted Stop with Bus Access**
   What to look for near the red dot:
   - Bus stop sign, school bus stop sign, pole marking, painted curb, turnout/shoulder, pull-off space.
   - Whether a bus can stop **without blocking traffic dangerously**, and whether there is a safe curbside stopping area.
   Score guidance:
   - **8–9**: Clear designated stop + bus can safely pull over/stop.
   - **4–6**: Some stopping space but not clearly designated OR bus stopping seems awkward.
   - **1–3**: No indication of a stop AND bus stopping would be dangerous/impractical.

2) **Obstacles Near Stop**
   Evaluate the waiting area around the red dot:
   - Parked cars, driveways, fences/walls, dumpsters, bushes, poles, uneven ground, narrow sidewalk, debris.
   - Whether students have a **clear, safe standing area** away from the travel lane.
   Score guidance:
   - **8–9**: Waiting area is open/clear and separated from traffic.
   - **4–6**: Some obstacles or limited space.
   - **1–3**: Major obstacles or no safe standing space.

3) **Visibility to Other Vehicles**
   From drivers’ perspective approaching the red dot:
   - Straight vs curve, crest/hill, visual clutter, parked vehicles blocking, shadows, lane count, speed context.
   - Would drivers have enough time to see students and a stopped bus?
   Score guidance:
   - **8–9**: Long clear sightline and obvious stop area.
   - **4–6**: Sightline is moderate/partly blocked.
   - **1–3**: Drivers would have limited time to react (blind curve, heavy obstruction, etc.).

4) **ADA Accessibility**
   At/near the red dot:
   - Sidewalk presence/continuity, curb ramps, paved paths, smooth surfaces, wheelchair access to the waiting point.
   Score guidance:
   - **8–9**: Sidewalk/paved access and curb ramps clearly present.
   - **4–6**: Some pedestrian infrastructure but incomplete/unclear.
   - **1–3**: No sidewalk/ramps/paved access visible near the stop.

5) **Crossing Hazards**
   Consider whether students may need to cross near the red dot and how safe that would be:
   - Number of lanes, speed context, crosswalk markings, signals, median/refuge, stop signs, turning traffic, driveways.
   - If no crossing is visible/needed from images, state uncertainty and score conservatively (often 5–7 depending on road context).
   Score guidance:
   - **8–9**: Controlled crossing (signals/crosswalk/stop control) or low-speed low-lane road.
   - **4–6**: Some crossing risk (multiple lanes, unclear markings, moderate speed).
   - **1–3**: High-risk crossing (multi-lane, fast traffic, no control/markings, many driveways/turn lanes).

6) **Obstructions to Visibility for Drivers**
   Focus specifically on objects that hide the red-dot area from drivers:
   - Parked vehicles, fences/walls, trees, utility poles, signs, large structures, corners.
   Score guidance:
   - **8–9**: Minimal obstructions; drivers can clearly see the waiting area.
   - **4–6**: Some obstructions but still partly visible.
   - **1–3**: Major obstructions that significantly hide students/stop.

OUTPUT FORMAT (STRICT):
Return ONLY strict JSON with exactly these six top-level keys:
- "Posted Stop with Bus Access"
- "Obstacles Near Stop"
- "Visibility to Other Vehicles"
- "ADA Accessibility"
- "Crossing Hazards"
- "Obstructions to Visibility for Drivers"

Each key must map to an object:
{{
  "score": <integer 1-9>,
  "reason": "<1-3 sentences, evidence-based, referencing what is visible in the images near the red dot>"
}}

Do not include any extra keys, no markdown, no commentary outside JSON.
"""

RESPONSE_SCHEMA = {
    "type": "json_schema",
    "json_schema": {
        "name": "SchoolBusStopEvaluation",
        "schema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "Posted Stop with Bus Access": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "score": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": 9
                        },
                        "reason": {
                            "type": "string"
                        }
                    },
                    "required": ["score", "reason"]
                },
                "Obstacles Near Stop": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "score": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": 9
                        },
                        "reason": {
                            "type": "string"
                        }
                    },
                    "required": ["score", "reason"]
                },
                "Visibility to Other Vehicles": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "score": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": 9
                        },
                        "reason": {
                            "type": "string"
                        }
                    },
                    "required": ["score", "reason"]
                },
                "ADA Accessibility": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "score": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": 9
                        },
                        "reason": {
                            "type": "string"
                        }
                    },
                    "required": ["score", "reason"]
                },
                "Crossing Hazards": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "score": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": 9
                        },
                        "reason": {
                            "type": "string"
                        }
                    },
                    "required": ["score", "reason"]
                },
                "Obstructions to Visibility for Drivers": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "score": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": 9
                        },
                        "reason": {
                            "type": "string"
                        }
                    },
                    "required": ["score", "reason"]
                }
            },
            "required": [
                "Posted Stop with Bus Access",
                "Obstacles Near Stop",
                "Visibility to Other Vehicles",
                "ADA Accessibility",
                "Crossing Hazards",
                "Obstructions to Visibility for Drivers"
            ]
        }
    }
}




def build_pdf_report(pdf_path, lat, lon, evaluation, combined, images_paths):
    """
    evaluation: dict like results from LLM schema:
      {
        "Posted Stop with Bus Access": {"score": 7, "reason": "..."},
        ...
      }
    combined: {"finalAvg": ..., "status": ...}
    images_paths: list of file paths for the 5 images
    """
    c = canvas.Canvas(pdf_path, pagesize=letter)
    W, H = letter
    margin = 40
    y = H - margin

    # Header
    c.setFont("Helvetica-Bold", 16)
    c.drawString(margin, y, "Bus Stop Safety Evaluation Report")
    y -= 18

    c.setFont("Helvetica", 10)
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    c.drawString(margin, y, f"Generated: {now}")
    y -= 14
    c.drawString(margin, y, f"Location: lat={lat}, lon={lon}")
    y -= 18

    # Overall summary
    c.setFont("Helvetica-Bold", 12)
    c.drawString(margin, y, "Overall Summary")
    y -= 14

    c.setFont("Helvetica", 10)
    c.drawString(margin, y, f"Status: {combined.get('status', 'Unknown')}")
    y -= 12
    avg = combined.get("finalAvg", None)
    c.drawString(margin, y, f"Final Average Score: {avg if avg is not None else 'N/A'}")
    y -= 18

    # Criteria table
    c.setFont("Helvetica-Bold", 12)
    c.drawString(margin, y, "Criteria Scores and Reasons")
    y -= 12

    rows = [["Criterion", "Score", "Reason"]]
    for k, v in evaluation.items():
        score = v.get("score", "")
        reason = v.get("reason", "")
        rows.append([k, str(score), reason])

    table = Table(rows, colWidths=[170, 50, W - margin*2 - 220])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,0), colors.lightgrey),
        ("FONTNAME", (0,0), (-1,0), "Helvetica-Bold"),
        ("FONTSIZE", (0,0), (-1,0), 9),
        ("FONTSIZE", (0,1), (-1,-1), 8),
        ("VALIGN", (0,0), (-1,-1), "TOP"),
        ("GRID", (0,0), (-1,-1), 0.25, colors.grey),
        ("ROWBACKGROUNDS", (0,1), (-1,-1), [colors.whitesmoke, colors.white]),
    ]))

    tw, th = table.wrapOn(c, W - margin*2, y)
    if y - th < margin:
        c.showPage()
        y = H - margin
    table.drawOn(c, margin, y - th)
    y -= th + 18

    # Images
    c.setFont("Helvetica-Bold", 12)
    if y < 120:
        c.showPage()
        y = H - margin
    c.drawString(margin, y, "Street View Images (Red dot = target point)")
    y -= 14

    # layout: 2 images per row, then last row 1 image
    max_img_w = (W - margin*2 - 10) / 2
    max_img_h = 160

    def draw_img(path, x, y_top):
        img = ImageReader(path)
        iw, ih = img.getSize()
        scale = min(max_img_w / iw, max_img_h / ih)
        w = iw * scale
        h = ih * scale
        c.drawImage(img, x, y_top - h, width=w, height=h, preserveAspectRatio=True, mask="auto")
        return h

    x1 = margin
    x2 = margin + max_img_w + 10

    for i, p in enumerate(images_paths):
        if y < margin + max_img_h + 20:
            c.showPage()
            y = H - margin
        # captions
        c.setFont("Helvetica", 9)
        caption = os.path.basename(p)
        if i % 2 == 0:
            c.drawString(x1, y, caption)
            h_used = draw_img(p, x1, y - 10)
        else:
            c.drawString(x2, y, caption)
            h_used = draw_img(p, x2, y - 10)
            y -= max(h_used + 20, max_img_h + 20)

    c.save()

@app.route("/evaluate", methods=["POST"])
def evaluate():
    data = request.get_json(silent=True) or {}
    lat = data.get("lat")
    lon = data.get("lon")

    if not lat or not lon:
        return jsonify({"error": "Missing lat/lon"}), 400

    prompt = PROMPT_TEMPLATE.format(lat=lat, lon=lon).strip()

    base_dir = os.path.dirname(os.path.abspath(__file__))

    offsets = ["minus90", "minus45", "center", "plus45", "plus90"]
    b64_images = []

    for tag in offsets:
        filename = os.path.join(base_dir, f"streetview_zoom_in_{tag}.jpg")
        if not os.path.exists(filename):
            return jsonify({"error": f"Missing image file: {filename}"}), 400

        with open(filename, "rb") as f:
            b64_images.append(base64.b64encode(f.read()).decode("utf-8"))

    message = [{
        "role": "user",
        "content": [{"type": "text", "text": prompt}] + [
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}}
            for b64 in b64_images
        ]
    }]

    response = client.chat.completions.create(
        model=model_name,
        messages=message,
        response_format=RESPONSE_SCHEMA
    )

    content = response.choices[0].message.content.strip()
    results = json.loads(content)

    # Compute overall average score
    scores = []
    for v in results.values():
        if isinstance(v, dict) and "score" in v:
            try:
                scores.append(int(v["score"]))
            except:
                pass

    finalAvg = sum(scores) / len(scores) if scores else None

    if finalAvg is None:
        status = "Unknown"
    elif finalAvg >= 7:
        status = "Safe"
    elif finalAvg < 4:
        status = "Unsafe"
    else:
        status = "Fair"

    return jsonify({
        "input": {"lat": lat, "lon": lon},
        "images_used": [f"streetview_zoom_in_{tag}.jpg" for tag in offsets],
        "evaluation": results,
        "combined": {
            "finalAvg": finalAvg,
            "status": status
        }
    })

@app.route("/report", methods=["POST"])
def report():
    data = request.get_json(silent=True) or {}
    lat = data.get("lat")
    lon = data.get("lon")
    if not lat or not lon:
        return jsonify({"error": "Missing lat/lon"}), 400

    # Reuse your evaluate() logic but as a function call:
    # Here I’ll assume you call evaluate internally or re-run the same code and get:
    # results (evaluation dict) + combined dict + offsets list

    # If you already have evaluate code returning these, call it and unpack.
    # For clarity: assume you already computed:
    # results = {...}  # evaluation
    # combined = {"finalAvg": ..., "status": ...}

    # Load image paths
    base_dir = os.path.dirname(os.path.abspath(__file__))
    offsets = ["minus30", "minus15", "center", "plus15", "plus30"]
    image_paths = [os.path.join(base_dir, f"streetview_centered_{t}.jpg") for t in offsets]

    # Make sure files exist
    for p in image_paths:
        if not os.path.exists(p):
            return jsonify({"error": f"Missing image file: {p}"}), 400

    # IMPORTANT: call your model here or call your evaluate() internal logic to get results
    # ---- You already have this logic in /evaluate; reuse it to get "results" ----
    # Example: results = ... (dict with score/reason)
    # combined = ... (status/finalAvg)

    # For now: easiest is to call your existing evaluate function body as a helper.
    # If you want, I can refactor your evaluate() into a shared function cleanly.

    # TEMP: call OpenAI the same way you do in /evaluate to compute results:
    prompt = PROMPT_TEMPLATE.format(lat=lat, lon=lon).strip()
    b64_images = []
    for p in image_paths:
        with open(p, "rb") as f:
            b64_images.append(base64.b64encode(f.read()).decode("utf-8"))

    message = [{
        "role": "user",
        "content": [{"type": "text", "text": prompt}] + [
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}}
            for b64 in b64_images
        ]
    }]

    resp = client.chat.completions.create(
        model=model_name,
        messages=message,
        response_format=RESPONSE_SCHEMA
    )

    results = json.loads(resp.choices[0].message.content.strip())

    scores = [int(v["score"]) for v in results.values()]
    finalAvg = sum(scores) / len(scores) if scores else None
    if finalAvg is None:
        status = "Unknown"
    elif finalAvg >= 7:
        status = "Safe"
    elif finalAvg < 4:
        status = "Unsafe"
    else:
        status = "Fair"

    combined = {"finalAvg": finalAvg, "status": status}

    # Build PDF
    out_name = f"bus_stop_report_{uuid.uuid4().hex[:8]}.pdf"
    pdf_path = os.path.join(base_dir, out_name)
    build_pdf_report(pdf_path, lat, lon, results, combined, image_paths)

    return send_file(pdf_path, mimetype="application/pdf", as_attachment=True, download_name=out_name)


# In your Flask app
import requests
from flask import jsonify

@app.route("/nv511/roadconditions")
def nv511_roadconditions():
    r = requests.get("https://www.nvroads.com/api/v2/get/roadconditions?key=&format=json")
    return jsonify(r.json())

@app.route("/nv511/events")
def nv511_events():
    r = requests.get("https://www.nvroads.com/api/v2/get/event?key=&format=json")
    return jsonify(r.json())

# === Start Server ===
if __name__ == "__main__":
    app.run(debug=True)