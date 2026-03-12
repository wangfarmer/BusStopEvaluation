// test_sdk_run.js (CommonJS)
// Usage: node test_sdk_run.js
//
// - Calls your existing Node API via SDK (baseUrl :3001)
// - Reads local images: streetview_centered_minus30.jpg ... plus30.jpg
// - Writes a PDF report: bus_stop_report.pdf

const util = require("util");
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

function safeText(x) {
  if (x == null) return "";
  if (typeof x === "string") return x;
  try { return JSON.stringify(x); } catch { return String(x); }
}

// Supports both old format (string + " Score") and new format ({score, reason})
function getLlmBlock(resp) {
  // Your real structure:
  // resp.gptEvaluation = { combined, evaluation, images_used, input }
  const g = resp?.gptEvaluation || {};
  const evaluation = g?.evaluation || {};
  const llmCombined = g?.combined || null;
  const imagesUsed = g?.images_used || [];
  return { evaluation, llmCombined, imagesUsed };
}

function computeOverall(evalObj) {
  const scores = [];
  for (const v of Object.values(evalObj || {})) {
    const s = v?.score;
    const n = Number(s);
    if (Number.isFinite(n)) scores.push(n);
  }
  const finalAvg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  const status =
    finalAvg == null ? "Unknown" :
    finalAvg >= 7 ? "Safe" :
    finalAvg < 4 ? "Unsafe" :
    "Fair";
  return { finalAvg, status };
}

/** ---------------------------
 *  THEME + LAYOUT HELPERS
 *  ---------------------------
 */

const THEME = {
  page: { size: "LETTER", margin: 50 },
  font: {
    regular: "Helvetica",
    bold: "Helvetica-Bold",
    italic: "Helvetica-Oblique",
  },
  color: {
    ink: "#111827",        // slate-900
    muted: "#6B7280",      // gray-500
    line: "#E5E7EB",       // gray-200
    panel: "#F9FAFB",      // gray-50
    panel2: "#F3F4F6",     // gray-100
    brand: "#2563EB",      // blue-600
    brand2: "#1D4ED8",     // blue-700
    safe: "#16A34A",       // green-600
    fair: "#F59E0B",       // amber-500
    unsafe: "#DC2626",     // red-600
    unknown: "#6B7280",    // gray-500
    white: "#FFFFFF",
  },
  radius: 10,
};

function statusColor(status) {
  const s = String(status || "").toLowerCase();
  if (s === "safe") return THEME.color.safe;
  if (s === "fair") return THEME.color.fair;
  if (s === "unsafe") return THEME.color.unsafe;
  return THEME.color.unknown;
}

function fmtNum(x, digits = 2) {
  const n = Number(x);
  if (!Number.isFinite(n)) return "";
  return n.toFixed(digits);
}

function nowStamp() {
  const d = new Date();
  // Simple local stamp, avoids extra deps
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// --- replace ensureSpace with this (reserves footer area) ---
const FOOTER_RESERVE = 44; // points reserved for page footer

function ensureSpace(doc, neededHeight) {
  // bottom usable coordinate (account for margins + footer reserve)
  const bottom = doc.page.height - doc.page.margins.bottom - FOOTER_RESERVE;
  if (doc.y + neededHeight > bottom) {
    doc.addPage();
  }
}

function drawDivider(doc, y) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  doc.save();
  doc.strokeColor(THEME.color.line).lineWidth(1);
  doc.moveTo(left, y).lineTo(right, y).stroke();
  doc.restore();
}

function drawRoundedRect(doc, x, y, w, h, r, fill, stroke) {
  doc.save();
  if (fill) doc.fillColor(fill);
  if (stroke) doc.strokeColor(stroke);
  doc.roundedRect(x, y, w, h, r);
  if (fill && stroke) doc.fillAndStroke(fill, stroke);
  else if (fill) doc.fill();
  else if (stroke) doc.stroke();
  doc.restore();
}

function drawHeader(doc, { title, subtitle, badgeText, badgeColor }) {
  const left = doc.page.margins.left;
  const top = doc.page.margins.top;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;

  const headerH = 84;

  // Brand banner
  drawRoundedRect(doc, left, top - 10, width, headerH, THEME.radius, THEME.color.brand, null);

  // Title + subtitle
  doc.save();
  doc.fillColor(THEME.color.white);
  doc.font(THEME.font.bold).fontSize(18).text(title, left + 18, top + 10, { width: width - 160 });
  doc.font(THEME.font.regular).fontSize(10).text(subtitle, left + 18, top + 36, { width: width - 160 });
  doc.font(THEME.font.regular).fontSize(9).fillColor("#DBEAFE").text(`Generated: ${nowStamp()}`, left + 18, top + 54);
  doc.restore();

  // Badge (status pill)
  if (badgeText) {
    const pillW = 120;
    const pillH = 28;
    const pillX = right - pillW - 18;
    const pillY = top + 18;
    drawRoundedRect(doc, pillX, pillY, pillW, pillH, 14, badgeColor || THEME.color.white, null);

    doc.save();
    doc.fillColor(THEME.color.white);
    doc.font(THEME.font.bold).fontSize(11).text(badgeText, pillX, pillY + 7, { width: pillW, align: "center" });
    doc.restore();
  }

  doc.y = top + headerH + 10;
}

function drawFooter(doc, pageNum, totalPages) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const bottom = doc.page.height - doc.page.margins.bottom;

  doc.save();
  doc.strokeColor(THEME.color.line).lineWidth(1);
  doc.moveTo(left, bottom - 18).lineTo(right, bottom - 18).stroke();

  doc.fillColor(THEME.color.muted).font(THEME.font.regular).fontSize(9);
  doc.text("Bus Stop Safety Evaluation Report", left, bottom - 14, { width: 300 });
  doc.text(`Page ${pageNum}${totalPages ? ` / ${totalPages}` : ""}`, right - 120, bottom - 14, { width: 120, align: "right" });

  doc.restore();
}

function drawSectionTitle(doc, title, opts = {}) {
  const left = doc.page.margins.left;
  ensureSpace(doc, 36);

  doc.save();
  doc.fillColor(THEME.color.ink);
  doc.font(THEME.font.bold).fontSize(12).text(title, left, doc.y);
  doc.restore();

  if (opts.divider !== false) {
    const y = doc.y + 8;
    drawDivider(doc, y);
    doc.y = y + 10;
  } else {
    doc.moveDown(0.6);
  }
}

function drawKeyValueGrid(doc, pairs, { columns = 2 } = {}) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;

  const colGap = 14;
  const colW = (width - colGap * (columns - 1)) / columns;

  const rowH = 18;
  const pad = 10;

  const rows = [];
  for (let i = 0; i < pairs.length; i += columns) {
    rows.push(pairs.slice(i, i + columns));
  }

  for (const row of rows) {
    ensureSpace(doc, rowH + pad * 2 + 8);

    const y = doc.y;
    const h = rowH + pad * 2;

    // background panel
    drawRoundedRect(doc, left, y, width, h, THEME.radius, THEME.color.panel, THEME.color.line);

    // content
    for (let c = 0; c < columns; c++) {
      const cell = row[c];
      if (!cell) continue;

      const x = left + c * (colW + colGap) + pad;
      const key = cell[0];
      const val = safeText(cell[1]);

      doc.save();
      doc.fillColor(THEME.color.muted).font(THEME.font.bold).fontSize(9).text(key, x, y + pad, { width: colW - pad * 2 });
      doc.fillColor(THEME.color.ink).font(THEME.font.regular).fontSize(10).text(val, x, y + pad + 10, { width: colW - pad * 2 });
      doc.restore();
    }

    doc.y = y + h + 10;
  }
}

function drawStatusCard(doc, { label, status, score }) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;

  ensureSpace(doc, 96);

  const y = doc.y;
  const h = 86;
  drawRoundedRect(doc, left, y, width, h, THEME.radius, THEME.color.panel, THEME.color.line);

  // left side text
  doc.save();
  doc.fillColor(THEME.color.muted).font(THEME.font.bold).fontSize(9).text(label, left + 14, y + 14);
  doc.fillColor(THEME.color.ink).font(THEME.font.bold).fontSize(16).text(String(status || "Unknown"), left + 14, y + 30);
  doc.fillColor(THEME.color.muted).font(THEME.font.regular).fontSize(10)
    .text(score == null ? "" : `Average score: ${fmtNum(score, 2)} / 9.00`, left + 14, y + 52);

  // right side pill
  const pillText = String(status || "Unknown");
  const pillColor = statusColor(status);
  const pillW = 120;
  const pillH = 30;
  const pillX = right - pillW - 14;
  const pillY = y + 28;
  drawRoundedRect(doc, pillX, pillY, pillW, pillH, 15, pillColor, null);

  doc.fillColor(THEME.color.white).font(THEME.font.bold).fontSize(11)
    .text(pillText, pillX, pillY + 8, { width: pillW, align: "center" });

  doc.restore();

  doc.y = y + h + 12;
}

// ----- REPLACE your existing drawScoreGauge with this (keeps standalone behavior) -----
function drawScoreGauge(doc, { label, value, min = 0, max = 9 }) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;

  ensureSpace(doc, 56);

  const y = doc.y;
  const h = 46;
  drawRoundedRect(doc, left, y, width, h, THEME.radius, THEME.color.panel, THEME.color.line);

  const v = Number(value);
  const pct = Number.isFinite(v) ? Math.max(0, Math.min(1, (v - min) / (max - min))) : 0;

  // label
  doc.save();
  doc.fillColor(THEME.color.ink).font(THEME.font.bold).fontSize(10)
    .text(label, left + 14, y + 10, { width: width - 140 });

  // bar background
  const barX = left + 14;
  const barY = y + 26;
  const barW = width - 160;
  const barH = 10;
  drawRoundedRect(doc, barX, barY, barW, barH, 5, THEME.color.panel2, null);

  // bar fill (color by score bands)
  let fill = THEME.color.unknown;
  if (Number.isFinite(v)) {
    fill = v >= 7 ? THEME.color.safe : (v < 4 ? THEME.color.unsafe : THEME.color.fair);
  }
  drawRoundedRect(doc, barX, barY, Math.max(6, barW * pct), barH, 5, fill, null);

  // number on the right
  doc.fillColor(THEME.color.ink).font(THEME.font.bold).fontSize(11)
    .text(Number.isFinite(v) ? `${fmtNum(v, 1)} / ${max}` : "—", right - 130, y + 16, { width: 120, align: "right" });

  doc.restore();

  doc.y = y + h + 10;
}

// ----- ADD this helper: a compact mini-bar + chip for inside cards -----
function drawMiniScoreInCard(doc, { x, y, value, chipRightX, chipW = 70, chipH = 24, barW = 120, barH = 8 }) {
  // value: numeric score (0-9)
  const v = Number(value);
  const pct = Number.isFinite(v) ? Math.max(0, Math.min(1, v / 9)) : 0;

  // Determine chip color
  let chipColor = THEME.color.unknown;
  if (Number.isFinite(v)) chipColor = v >= 7 ? THEME.color.safe : (v < 4 ? THEME.color.unsafe : THEME.color.fair);

  // Draw chip (right aligned at chipRightX)
  const chipX = chipRightX - chipW;
  const chipY = y;
  drawRoundedRect(doc, chipX, chipY, chipW, chipH, 12, chipColor, null);
  doc.save();
  doc.fillColor(THEME.color.white).font(THEME.font.bold).fontSize(10)
    .text(Number.isFinite(v) ? `${fmtNum(v, 1)}/9` : "—", chipX, chipY + 6, { width: chipW, align: "center" });
  doc.restore();

  // Draw small bar to left of chip
  const barX = chipX - 14 - barW;
  const barY = y + Math.round((chipH - barH) / 2);
  drawRoundedRect(doc, barX, barY, barW, barH, 6, THEME.color.panel2, null);
  const fillW = Math.max(4, barW * pct);
  let fillCol = THEME.color.unknown;
  if (Number.isFinite(v)) fillCol = v >= 7 ? THEME.color.safe : (v < 4 ? THEME.color.unsafe : THEME.color.fair);
  drawRoundedRect(doc, barX, barY, fillW, barH, 6, fillCol, null);
}

function drawZebraTable(doc, { title, rows }) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;

  if (title) drawSectionTitle(doc, title);

  // column widths: key/value
  const col1 = Math.floor(width * 0.62);
  const col2 = width - col1;

  const headerH = 22;
  const rowH = 18;

  ensureSpace(doc, headerH + 10);

  // header row
  const y0 = doc.y;
  drawRoundedRect(doc, left, y0, width, headerH, THEME.radius, THEME.color.brand2, null);

  doc.save();
  doc.fillColor(THEME.color.white).font(THEME.font.bold).fontSize(9);
  doc.text("Metric", left + 12, y0 + 6, { width: col1 - 20 });
  doc.text("Value", left + col1, y0 + 6, { width: col2 - 12, align: "right" });
  doc.restore();

  let y = y0 + headerH;

  for (let i = 0; i < rows.length; i++) {
    ensureSpace(doc, rowH + 6);
    const bg = i % 2 === 0 ? THEME.color.panel : THEME.color.white;

    // row bg
    doc.save();
    doc.fillColor(bg);
    doc.rect(left, y, width, rowH).fill();
    doc.restore();

    // text
    const [k, v] = rows[i];
    doc.save();
    doc.fillColor(THEME.color.ink).font(THEME.font.regular).fontSize(9);
    doc.text(String(k), left + 12, y + 5, { width: col1 - 20 });
    doc.text(String(v), left + col1, y + 5, { width: col2 - 12, align: "right" });
    doc.restore();

    // line
    doc.save();
    doc.strokeColor(THEME.color.line).lineWidth(1);
    doc.moveTo(left, y + rowH).lineTo(right, y + rowH).stroke();
    doc.restore();

    y += rowH;
  }

  doc.y = y + 10;
}

// ----- REPLACE your existing drawCriteriaCards with this improved version -----
function drawCriteriaCards(doc, criteriaOrder, llmEval) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;

  for (const c of criteriaOrder) {
    const item = llmEval?.[c];
    const score = item?.score;
    const reason = safeText(item?.reason || "");

    // Estimate heights:
    const baseH = 48;        // title + small top padding
    const reasonMaxH = 90;   // reason box
    ensureSpace(doc, baseH + reasonMaxH + 18);

    const y = doc.y;
    const cardH = baseH + reasonMaxH;
    drawRoundedRect(doc, left, y, width, cardH, THEME.radius, THEME.color.panel, THEME.color.line);

    // Title on left
    doc.save();
    doc.fillColor(THEME.color.ink).font(THEME.font.bold).fontSize(11)
      .text(c, left + 14, y + 12, { width: width - 200 }); // leave room on right for chip+mini-bar
    doc.restore();

    // Compact score: render a chip + small bar inline (no extra "Score" label)
    const chipRightX = right - 14;
    drawMiniScoreInCard(doc, { x: left + 14, y: y + 12, value: score, chipRightX });

    // Reason box (inside card)
    const reasonX = left + 14;
    const reasonY = y + baseH;
    const reasonW = width - 28;
    const reasonH = reasonMaxH;

    drawRoundedRect(doc, reasonX, reasonY, reasonW, reasonH, 8, THEME.color.white, THEME.color.line);

    doc.save();
    doc.fillColor(THEME.color.muted).font(THEME.font.bold).fontSize(9)
      .text("Reason", reasonX + 10, reasonY + 8);

    doc.fillColor(THEME.color.ink).font(THEME.font.regular).fontSize(9);
    doc.text(reason, reasonX + 10, reasonY + 22, {
      width: reasonW - 20,
      height: reasonH - 30,
      ellipsis: true
    });
    doc.restore();

    doc.y = y + cardH + 12;
  }
}

function reorderStreetViewImages(imagePaths) {
  if (!Array.isArray(imagePaths)) return [];

  const lower = (p) => path.basename(p).toLowerCase();

  // center first
  const centerIdx = imagePaths.findIndex(p => lower(p).includes("center"));
  const arr = [...imagePaths];
  if (centerIdx !== -1) {
    const [center] = arr.splice(centerIdx, 1);
    arr.unshift(center);
  }

  // order remaining: minus90, minus45, plus45, plus90
  const rank = (p) => {
    const name = lower(p);
    if (name.includes("minus90")) return 1;
    if (name.includes("minus45")) return 2;
    if (name.includes("plus45")) return 3;
    if (name.includes("plus90")) return 4;
    return 99;
  };

  const center = arr.shift();          // first is center if present
  arr.sort((a, b) => rank(a) - rank(b));
  return center ? [center, ...arr] : arr;
}

function addImageGrid(doc, existingImages) {
  if (!Array.isArray(existingImages) || existingImages.length === 0) {
    drawSectionTitle(doc, "Street View Images");
    doc.font(THEME.font.italic).fontSize(9).fillColor(THEME.color.muted)
      .text("No local images found to embed.");
    return;
  }

  // reorder (center first)
  const imgs = reorderStreetViewImages(existingImages);

  // Compact sizing parameters (smaller than previous)
  const pad = 6;          // inner padding
  const gap = 8;          // gap between tiles
  const capFont = 7.5;    // caption font size
  const subFont = 8;      // subtitle font
  const captionH = 10;    // reserved caption height
  // smaller images to fit with title on same page
  const mainImgH = 120;
  const aroundImgH = 90;

  // geometry
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const W = right - left;
  const tileW = (W - gap) / 2;

  // tile heights
  const mainTileH = pad + captionH + 4 + mainImgH + pad;
  const tileH = pad + captionH + 4 + aroundImgH + pad;

  // block height calculation:
  // Title (we'll use drawSectionTitle which reserves ~36) + small subtitle + main tile + label + 2 rows of around tiles
  const sectionTitleHeight = 36; // drawSectionTitle reserve
  const subtitleH = 12;
  const aroundLabelH = 14;
  const rowsNeeded = Math.ceil(Math.max(0, imgs.length - 1) / 2);
  const aroundRowsH = rowsNeeded * tileH + (rowsNeeded - 1) * gap;

  const blockH = sectionTitleHeight + subtitleH + mainTileH + 8 + aroundLabelH + 6 + aroundRowsH + 12;

  // If it won't fit on current page, start fresh so title + block are together
  ensureSpace(doc, blockH);

  // draw compact section title (so title and block spacing match)
  doc.save();
  doc.fillColor(THEME.color.ink).font(THEME.font.bold).fontSize(11)
    .text("Street View Images", left, doc.y);
  doc.restore();

  const divY = doc.y + 6;
  drawDivider(doc, divY);
  doc.y = divY + 10;

  doc.save();
  doc.fillColor(THEME.color.muted).font(THEME.font.regular).fontSize(subFont)
    .text("Main looking first (center) then Around looking (compact).", left, doc.y);
  doc.restore();
  doc.moveDown(0.4);

  // starting cursor
  let y = doc.y;

  // ---- Main tile (first image if exists) ----
  const mainPath = imgs[0];
  drawRoundedRect(doc, left, y, W, mainTileH, THEME.radius, THEME.color.panel, THEME.color.line);

  const mainCaption = mainPath ? `Main looking — ${path.basename(mainPath)}` : "Main looking";
  doc.save();
  doc.fillColor(THEME.color.muted).font(THEME.font.bold).fontSize(capFont)
    .text(mainCaption, left + pad, y + pad, { width: W - pad * 2 });
  doc.restore();

  if (mainPath) {
    try {
      doc.image(mainPath, left + pad, y + pad + captionH + 4, { fit: [W - pad * 2, mainImgH] });
    } catch (e) {
      doc.save();
      doc.fillColor(THEME.color.unsafe).font(THEME.font.regular).fontSize(capFont)
        .text("(Failed to load image)", left + pad, y + pad + captionH + 20, { width: W - pad * 2 });
      doc.restore();
    }
  }

  y += mainTileH + 8;

  // ---- Around label ----
  doc.save();
  doc.fillColor(THEME.color.ink).font(THEME.font.bold).fontSize(9)
    .text("Around looking", left, y);
  doc.restore();
  y += aroundLabelH;

  // ---- Around tiles (up to 4) ----
  const around = imgs.slice(1, 5); // take up to 4
  for (let i = 0; i < around.length; i++) {
    const r = Math.floor(i / 2);
    const c = i % 2;
    const x = left + c * (tileW + gap);
    const yy = y + r * (tileH + gap);

    drawRoundedRect(doc, x, yy, tileW, tileH, THEME.radius, THEME.color.panel, THEME.color.line);

    const p = around[i];
    const cap = path.basename(p);

    doc.save();
    doc.fillColor(THEME.color.muted).font(THEME.font.bold).fontSize(capFont)
      .text(cap, x + pad, yy + pad, { width: tileW - pad * 2 });
    doc.restore();

    try {
      doc.image(p, x + pad, yy + pad + captionH + 4, { fit: [tileW - pad * 2, aroundImgH] });
    } catch (e) {
      doc.save();
      doc.fillColor(THEME.color.unsafe).font(THEME.font.regular).fontSize(capFont)
        .text("(Failed to load image)", x + pad, yy + pad + captionH + 12, { width: tileW - pad * 2 });
      doc.restore();
    }
  }

  // advance doc.y to below the entire image block
  const finalRows = Math.ceil(around.length / 2);
  const finalAroundHeight = finalRows * tileH + (finalRows - 1) * gap;
  doc.y = y + finalAroundHeight + 12;
}

function drawStatusCardCompact(doc, { label, status, score }) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;

  // smaller card
  ensureSpace(doc, 72);

  const y = doc.y;
  const h = 62;
  drawRoundedRect(doc, left, y, width, h, THEME.radius, THEME.color.panel, THEME.color.line);

  doc.save();
  // smaller fonts
  doc.fillColor(THEME.color.muted).font(THEME.font.bold).fontSize(8).text(label, left + 12, y + 10);
  doc.fillColor(THEME.color.ink).font(THEME.font.bold).fontSize(14).text(String(status || "Unknown"), left + 12, y + 24);

  if (score != null && score !== "") {
    doc.fillColor(THEME.color.muted).font(THEME.font.regular).fontSize(9)
      .text(`Average score: ${fmtNum(score, 2)} / 9.00`, left + 12, y + 42);
  }
  doc.restore();

  // smaller pill
  const pillText = String(status || "Unknown");
  const pillColor = statusColor(status);
  const pillW = 96;
  const pillH = 24;
  const pillX = right - pillW - 12;
  const pillY = y + 19;

  drawRoundedRect(doc, pillX, pillY, pillW, pillH, 12, pillColor, null);

  doc.save();
  doc.fillColor(THEME.color.white).font(THEME.font.bold).fontSize(10)
    .text(pillText, pillX, pillY + 6, { width: pillW, align: "center" });
  doc.restore();

  doc.y = y + h + 10;
}

function drawKeyValueGridCompact(doc, pairs, { columns = 2 } = {}) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;

  const colGap = 12;
  const colW = (width - colGap * (columns - 1)) / columns;

  // tighter row + padding
  const rowH = 14;
  const pad = 8;
  const keySize = 8;
  const valSize = 9;

  const rows = [];
  for (let i = 0; i < pairs.length; i += columns) rows.push(pairs.slice(i, i + columns));

  for (const row of rows) {
    ensureSpace(doc, rowH + pad * 2 + 6);

    const y = doc.y;
    const h = rowH + pad * 2;

    drawRoundedRect(doc, left, y, width, h, THEME.radius, THEME.color.panel, THEME.color.line);

    for (let c = 0; c < columns; c++) {
      const cell = row[c];
      if (!cell) continue;

      const x = left + c * (colW + colGap) + pad;
      const key = String(cell[0] ?? "");
      const val = safeText(cell[1]);

      doc.save();
      doc.fillColor(THEME.color.muted).font(THEME.font.bold).fontSize(keySize)
        .text(key, x, y + pad, { width: colW - pad * 2, lineGap: 1 });

      doc.fillColor(THEME.color.ink).font(THEME.font.regular).fontSize(valSize)
        .text(val, x, y + pad + 9, { width: colW - pad * 2, lineGap: 1 });

      doc.restore();
    }

    doc.y = y + h + 8;
  }
}

function drawZebraTableCompact(doc, { title, rows }) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;

  if (title) drawSectionTitle(doc, title);

  // tighter columns
  const col1 = Math.floor(width * 0.64);
  const col2 = width - col1;

  // tighter row sizing + fonts
  const headerH = 18;   // was 22
  const rowH = 14;      // was 18
  const headerSize = 8; // was 9
  const cellSize = 8;   // was 9

  ensureSpace(doc, headerH + 8);

  const y0 = doc.y;
  drawRoundedRect(doc, left, y0, width, headerH, THEME.radius, THEME.color.brand2, null);

  doc.save();
  doc.fillColor(THEME.color.white).font(THEME.font.bold).fontSize(headerSize);
  doc.text("Metric", left + 10, y0 + 5, { width: col1 - 16 });
  doc.text("Value", left + col1, y0 + 5, { width: col2 - 10, align: "right" });
  doc.restore();

  let y = y0 + headerH;

  for (let i = 0; i < rows.length; i++) {
    ensureSpace(doc, rowH + 4);
    const bg = i % 2 === 0 ? THEME.color.panel : THEME.color.white;

    doc.save();
    doc.fillColor(bg);
    doc.rect(left, y, width, rowH).fill();
    doc.restore();

    const [k, v] = rows[i];

    doc.save();
    doc.fillColor(THEME.color.ink).font(THEME.font.regular).fontSize(cellSize);
    doc.text(String(k), left + 10, y + 3.5, { width: col1 - 16 });
    doc.text(String(v), left + col1, y + 3.5, { width: col2 - 10, align: "right" });
    doc.restore();

    doc.save();
    doc.strokeColor(THEME.color.line).lineWidth(1);
    doc.moveTo(left, y + rowH).lineTo(right, y + rowH).stroke();
    doc.restore();

    y += rowH;
  }

  doc.y = y + 8;
}

/** ---------------------------
 *  MAIN
 *  ---------------------------
 */

(async () => {
  try {
    // dynamic import of the built SDK bundle (ES module)
    const sdkModule = await import("./evaluation_sdk/dist/index.js");
    const { BusStopSDK } = sdkModule;

    // ✅ keep your previous server
    const sdk = new BusStopSDK({
      baseUrl: "http://127.0.0.1:3001",
      timeoutMs: 600000
    });

    // ping (optional)
    if (typeof sdk.ping === "function") {
      console.log("ping:", await sdk.ping());
    }

    // ✅ fixed coords for now (no CLI args)
    const lat = 36.1523113;
    const lng = -115.1571111;

    console.log("\nCalling evaluate...");
    const resp = await sdk.evaluate(lat, lng);

    console.log("\n=== FULL BUS STOP EVALUATION MATRIX ===");
    console.log(util.inspect(resp, { depth: null, colors: true, maxArrayLength: null }));

    // --- Load images from disk (two sets) ---
    const baseDir = __dirname;
    const tags = ["center", "minus90", "minus45", "plus45", "plus90"];

    // Zoom-in set (LLM eval inputs, red dot)
    const zoomInPathsOnDisk = tags.map(t => path.join(baseDir, `streetview_zoom_in_${t}.jpg`));

    // Zoom-out set (PDF-only evidence, no dot)
    const zoomOutPathsOnDisk = tags.map(t => path.join(baseDir, `streetview_zoom_out_${t}.jpg`));

    const { evaluation: llmEval, llmCombined, imagesUsed } = getLlmBlock(resp);

    // --- 1) Images used for LLM evaluation (prefer server list, fallback to zoom-in files) ---
    const evalImagePaths = (Array.isArray(imagesUsed) && imagesUsed.length)
      ? imagesUsed.map(name => path.join(baseDir, name))   // server-provided filenames
      : zoomInPathsOnDisk;                                // fallback to local zoom-in set

    const existingEvalImages = evalImagePaths.filter(p => fs.existsSync(p));

    // --- 2) Images to DISPLAY in the PDF evidence section (zoom-out set) ---
    const displayImagePaths = zoomOutPathsOnDisk;
    const existingDisplayImages = displayImagePaths.filter(p => fs.existsSync(p));

    // Use combined results if present; otherwise compute from LLM eval
    const combinedStatus = resp?.combined?.status ?? llmCombined?.status ?? computeOverall(llmEval).status;
    const combinedAvg = resp?.combined?.finalAvg ?? llmCombined?.finalAvg ?? computeOverall(llmEval).finalAvg;

    // --- Generate PDF ---
    const outPath = path.resolve(process.cwd(), "bus_stop_report.pdf");

    // NOTE: we use bufferedPages so we can add footers with page counts at the end.
    const doc = new PDFDocument({ ...THEME.page, bufferPages: true });
    doc.pipe(fs.createWriteStream(outPath));

    // ===== Cover/Header =====
    drawHeader(doc, {
      title: "Bus Stop Safety Evaluation Report",
      subtitle: "Automated roadside safety screening using imagery + distance-based metrics",
      badgeText: String(combinedStatus || "Unknown"),
      badgeColor: statusColor(combinedStatus),
    });

    // ===== Snapshot =====
    drawSectionTitle(doc, "Snapshot");

    drawStatusCardCompact(doc, {
      label: "Overall Result",
      status: combinedStatus,
      score: combinedAvg
    });

    // Inputs as grid
    const inputPairs = [
      ["Latitude", resp?.input?.lat ?? lat],
      ["Longitude", resp?.input?.lng ?? lng],
      ["Eval Images (zoom-in)", String(existingEvalImages.length)],
      ["Display Images (zoom-out)", String(existingDisplayImages.length)],
      ["Source", resp?.roadContext?.source ?? resp?.input?.source ?? "SDK / Server"],
    ];
    drawKeyValueGridCompact(doc, inputPairs, { columns: 2 });

    // ===== Distance-based scores =====
    // All Scores (Distance-based)
    const allScores = resp?.combined?.allScores || {};
    const allScoresRows = Object.entries(allScores).map(([k, v]) => [k, v]);

    if (allScoresRows.length) {
      drawZebraTableCompact(doc, { title: "Distance-Based Score Breakdown", rows: allScoresRows });
    }

    // ===== Road Context =====
    const rc = resp?.roadContext || {};
    const rcRows = Object.entries(rc).map(([k, v]) => [k, safeText(v)]);
    if (rcRows.length) {
      drawZebraTableCompact(doc, { title: "Road Context", rows: rcRows });
    }

    // ===== LLM Evaluation =====
    doc.addPage();
    drawHeader(doc, {
      title: "LLM Visual Evaluation",
      subtitle: "Criteria scored from street view imagery (red dot target point)",
      badgeText: String(llmCombined?.status ?? "—"),
      badgeColor: statusColor(llmCombined?.status),
    });

    drawSectionTitle(doc, "LLM Overall");
    drawStatusCard(doc, {
      label: "LLM Combined Result",
      status: llmCombined?.status ?? "",
      score: llmCombined?.finalAvg ?? null
    });

    // LLM criteria cards
    drawSectionTitle(doc, "Criteria Details");

    const criteriaOrder = [
      "Posted Stop with Bus Access",
      "Obstacles Near Stop",
      "Visibility to Other Vehicles",
      "ADA Accessibility",
      "Crossing Hazards",
      "Obstructions to Visibility for Drivers",
    ];
    drawCriteriaCards(doc, criteriaOrder, llmEval);

    // ===== Distance Metrics + Scores =====
    doc.addPage();
    drawHeader(doc, {
      title: "Distance & Scoring Metrics",
      subtitle: "Numeric measurements and derived 1–9 score signals",
      badgeText: String(combinedStatus || "Unknown"),
      badgeColor: statusColor(combinedStatus),
    });

    const dm = resp?.distanceMetricsMeters || {};
    const dmRows = Object.entries(dm).map(([k, v]) => [k, Number.isFinite(Number(v)) ? fmtNum(v, 2) : safeText(v)]);
    if (dmRows.length) {
      drawZebraTable(doc, { title: "Distance Metrics (meters)", rows: dmRows });
    }

    const ds = resp?.distanceScores || {};
    const dsRows = Object.entries(ds).map(([k, v]) => [k, safeText(v)]);
    if (dsRows.length) {
      drawZebraTable(doc, { title: "Distance Scores (1–9)", rows: dsRows });
    }

    // ===== Images (DISPLAY zoom-out set at end) =====
    if (existingDisplayImages.length) {
      doc.addPage();
      drawHeader(doc, {
        title: "Street View Evidence",
        subtitle: "Zoom-out context images (not used by LLM evaluation)",
        badgeText: `${existingDisplayImages.length} images`,
        badgeColor: THEME.color.brand2,
      });

      addImageGrid(doc, existingDisplayImages);
    } else {
      drawSectionTitle(doc, "Street View Images");
      doc.font(THEME.font.italic).fontSize(10).fillColor(THEME.color.muted)
        .text("No local zoom-out images found to embed.");
    }

    // ===== Add footers with page numbers (after content is done) =====
    const range = doc.bufferedPageRange(); // { start, count }
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      drawFooter(doc, i + 1, range.count);
    }

    doc.end();
    console.log("\n✅ Saved PDF:", outPath);

  } catch (err) {
    console.error("Test failed:", err);
    process.exit(1);
  }
})();