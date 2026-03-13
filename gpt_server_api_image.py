from flask import Flask, request, jsonify
import requests
import base64
from io import BytesIO
from openai import OpenAI
import json
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

GOOGLE_API_KEY = ""
client = OpenAI(base_url="http://localhost:1234/v1", api_key="lm-studio")
model_name = "qwen/qwen3-vl-30b"

def get_streetview_b64(lat, lon, heading):
    url = (
        f"https://maps.googleapis.com/maps/api/streetview"
        f"?size=640x640&location={lat},{lon}&heading={heading}&pitch=0&fov=90"
        f"&key={GOOGLE_API_KEY}"
    )
    response = requests.get(url)
    response.raise_for_status()
    return base64.b64encode(response.content).decode("utf-8")

# === Evaluation Prompt and Schema ===
PROMPT_TEMPLATE = """
You are evaluating a potential **school bus stop** using four 360-degree Street View images at coordinates ({lat}, {lon}).

SCORING SCALE (IMPORTANT):
- **9** = Excellent / very safe condition (ideal for a school bus stop)
- **7–8** = Good / generally safe with minor issues
- **4–6** = Fair / usable but with noticeable concerns
- **2–3** = Poor / unsafe with clear safety problems
- **1** = Very poor / highly unsafe
- If a criterion cannot be clearly evaluated from the images, use **5** and explain that it is not clearly visible.

You must assign a **numeric score from 1 to 9** for each criterion based on the standards below, and provide a **brief explanation** based only on visible evidence.  
Do **not** assume features that are not clearly visible.

STANDARDS FOR EACH CRITERION:

1. **Posted Stop with Bus Access**
   - Score **8–9** if an official bus stop sign, pole marking, or clear designated stop area is visible AND a bus can safely pull over.
   - Score **1–3** if no official stop indicator is visible or the bus cannot safely pull over.

2. **Obstacles Near Stop**
   - Score **8–9** if the waiting area is clear with no major obstacles.
   - Score **1–3** if parked vehicles, landscaping, fences, dumpsters, or other objects restrict safe waiting space.

3. **Visibility to Other Vehicles**
   - Score **8–9** if the roadway is straight/clear and approaching drivers would easily see students from a distance.
   - Score **1–3** if curves, hills, parked vehicles, vegetation, or road geometry significantly reduce visibility.

4. **ADA Accessibility**
   - Score **8–9** if curb ramps, sidewalks, paved paths, or other accessible features are clearly present.
   - Score **1–3** if no accessible path, curb ramp, or sidewalk is visible.

5. **Crossing Hazards**
   - Score **8–9** if crossing the roadway appears low-risk (few lanes, clear crosswalk markings, signage, or controlled crossing).
   - Score **1–3** if there are multiple lanes, driveways, turning traffic, or missing crosswalk markings/signage.

6. **Obstructions to Visibility for Drivers**
   - Score **8–9** if drivers’ views of the stop are mostly unobstructed (few vehicles, minimal trees/poles/fences).
   - Score **1–3** if fences, trees, poles, parked vehicles, walls, or other objects block drivers’ views.

OUTPUT FORMAT:
Respond in strict JSON with exactly these six keys.
Each key must have an object with:
- "score": number (1–9)
- "reason": string (one or two sentences explaining the score)

Do not include any additional text outside the JSON.
"""


RESPONSE_SCHEMA = {
    "type": "json_schema",
    "json_schema": {
        "name": "School Bus Stop Evaluation",
        "schema": {
            "type": "object",
            "properties": {
                "Posted Stop with Bus Access": {"type": "string"},
                "Obstacles Near Stop": {"type": "string"},
                "Visibility to Other Vehicles": {"type": "string"},
                "ADA Accessibility": {"type": "string"},
                "Crossing Hazards": {"type": "string"},
                "Obstructions to Visibility for Drivers": {"type": "string"}
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

@app.route("/evaluate", methods=["POST"])
def evaluate():
    data = request.get_json()
    lat = data.get("lat")
    lon = data.get("lon")

    if not lat or not lon:
        return jsonify({"error": "Missing lat/lon"}), 400

    headings = [0, 90, 180, 270]

    prompt = PROMPT_TEMPLATE.format(lat=lat, lon=lon)

    b64_images = [get_streetview_b64(lat, lon, h) for h in headings]

    message = [{
        "role": "user",
        "content": [{"type": "text", "text": prompt.strip()}] + [
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}} for b64 in b64_images
        ]
    }]

    response = client.chat.completions.create(
        model=model_name,
        messages=message,
        response_format=RESPONSE_SCHEMA
    )

    content = response.choices[0].message.content.strip()
    results = json.loads(content)

    # Define scoring heuristics (you can refine these!)
    def score(text):
        text = text.lower()
        if any(word in text for word in ["no", "none", "missing", "not visible", "blocked", "dangerous"]):
            return 2
        elif any(word in text for word in ["some", "partial", "limited", "unclear"]):
            return 5
        elif any(word in text for word in ["yes", "visible", "clear", "accessible", "safe", "marked"]):
            return 8
        return 4  # default average

    # Add score fields
    scored_results = {}
    for key, desc in results.items():
        scored_results[key] = desc
        scored_results[key + " Score"] = score(desc)

    return jsonify(scored_results)

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