/**
 * HTML pricing report generator for the model-prices extension.
 *
 * Builds a single self-contained HTML file (no CDN, works offline) with:
 *   - Filters: provider, type (reasoning), price range
 *   - Charts: input-vs-output scatter, count by type, count by category
 *     (derived tier), average price by provider, histogram by price bracket
 *   - Comparison: searchable multi-select model picker, grouped bar chart
 *     and side-by-side table for 2+ models
 *   - Sortable full table of every model
 */

export interface ReportCost {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ReportModel {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  cost?: ReportCost | null;
}

const PALETTE = [
  "#4cc2ff", "#f2a33c", "#57d9a3", "#e05d8f", "#b58cff",
  "#ffd166", "#6bd5e1", "#ff8a5c", "#9aa7ff", "#7dd87d",
  "#f07cb9", "#a3e635", "#f87171", "#67e8f9", "#c4b5fd",
];

export function buildReport(models: ReportModel[]): string {
  const serialized = models.map((m) => ({
    provider: m.provider,
    id: m.id,
    name: m.name ?? m.id,
    reasoning: !!m.reasoning,
    contextWindow: m.contextWindow ?? 0,
    maxTokens: m.maxTokens ?? 0,
    cost: m.cost
      ? {
          input: typeof m.cost.input === "number" ? m.cost.input : null,
          output: typeof m.cost.output === "number" ? m.cost.output : null,
          cacheRead: typeof m.cost.cacheRead === "number" ? m.cost.cacheRead : null,
          cacheWrite: typeof m.cost.cacheWrite === "number" ? m.cost.cacheWrite : null,
        }
      : null,
  }));

  // Safe embedding: escape < so "</script>" can never appear inside the JSON.
  const dataJson = JSON.stringify(serialized).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Model pricing report</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0f1419; color: #d7dde4; font: 14px/1.45 system-ui, sans-serif; }
  header { padding: 18px 24px 10px; border-bottom: 1px solid #232a33; }
  header h1 { margin: 0; font-size: 20px; color: #fff; }
  header .meta { margin-top: 4px; color: #8a94a0; font-size: 12.5px; }
  main { padding: 16px 24px 48px; max-width: 1280px; margin: 0 auto; }
  .card { background: #151b22; border: 1px solid #232a33; border-radius: 10px; padding: 14px 16px; margin-bottom: 18px; }
  .card h2 { margin: 0 0 10px; font-size: 14px; color: #aab4bf; text-transform: uppercase; letter-spacing: .05em; }
  .filters { display: flex; flex-wrap: wrap; gap: 10px 18px; align-items: center; }
  .filters label { font-size: 12.5px; color: #9aa4af; }
  .filters input[type=number] { width: 90px; background: #0f1419; color: #e6ebf0; border: 1px solid #2c3540; border-radius: 6px; padding: 4px 6px; }
  .filters select { background: #0f1419; color: #e6ebf0; border: 1px solid #2c3540; border-radius: 6px; padding: 4px 6px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { background: #0f1419; border: 1px solid #2c3540; color: #c3ccd6; border-radius: 999px; padding: 3px 10px; font-size: 12px; cursor: pointer; user-select: none; }
  .chip.on { background: #1c3a52; border-color: #3b7ea8; color: #bfe3ff; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
  @media (max-width: 900px) { .grid2 { grid-template-columns: 1fr; } }
  canvas.chart { width: 100%; height: 260px; display: block; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #1d242c; white-space: nowrap; }
  th { color: #8a94a0; cursor: pointer; position: sticky; top: 0; background: #151b22; }
  th:hover { color: #cfe7ff; }
  td.num, th.num { text-align: right; }
  tr:hover td { background: #1a222b; }
  .pill { border-radius: 999px; padding: 1px 8px; font-size: 11px; }
  .pill.yes { background: #173c2b; color: #7fe3b1; }
  .pill.no { background: #3a2b17; color: #ffd28a; }
  .pill.free { background: #173c2b; color: #7fe3b1; }
  .pill.na { background: #232a33; color: #7c8792; }
  .cmp-row { display: flex; gap: 16px; flex-wrap: wrap; }
  .cmp-pick { flex: 1 1 360px; }
  .cmp-pick input[type=search] { width: 100%; background: #0f1419; color: #e6ebf0; border: 1px solid #2c3540; border-radius: 6px; padding: 6px 8px; margin-bottom: 8px; }
  .cmp-list { max-height: 240px; overflow-y: auto; border: 1px solid #232a33; border-radius: 8px; padding: 4px; }
  .cmp-item { display: flex; gap: 8px; align-items: center; padding: 3px 6px; border-radius: 6px; font-size: 12.5px; }
  .cmp-item:hover { background: #1a222b; }
  .cmp-item label { display: flex; gap: 8px; align-items: center; width: 100%; cursor: pointer; }
  .cmp-item .p { margin-left: auto; color: #8a94a0; }
  .empty { color: #7c8792; padding: 12px 4px; font-size: 13px; }
  .scroll { overflow-x: auto; }
  .chips-cmp { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; min-height: 26px; }
  .chip-sel { background: #1c3a52; border: 1px solid #3b7ea8; color: #bfe3ff; border-radius: 999px; padding: 3px 10px; font-size: 12px; }
  .chip-sel .x { margin-left: 6px; cursor: pointer; color: #7fb7d8; }
  .note { color: #7c8792; font-size: 12px; margin-top: 6px; }
</style>
</head>
<body>
<header>
  <h1>Model pricing report</h1>
  <div class="meta">Generated by pi model-prices · <span id="meta-count"></span> · rates are USD per 1M tokens from the local model registry (models-store.json) · <span id="meta-date"></span></div>
</header>
<main>

  <div class="card">
    <h2>Filters</h2>
    <div class="filters">
      <label>Type <select id="f-type"><option value="all">all</option><option value="yes">reasoning</option><option value="no">non-reasoning</option></select></label>
      <label>Input $/M from <input type="number" id="f-min" min="0" step="0.01" value="0"></label>
      <label>to <input type="number" id="f-max" min="0" step="0.01" placeholder="∞"></label>
      <div id="f-providers" class="chips"></div>
      <button id="f-reset" style="background:#2c3540;color:#e6ebf0;border:1px solid #3a4550;border-radius:6px;padding:4px 10px;cursor:pointer">reset</button>
    </div>
  </div>

  <div class="grid2">
    <div class="card">
      <h2>Input vs output price (per 1M tokens)</h2>
      <canvas id="c-scatter" class="chart"></canvas>
      <div class="note">Hover for details. Free models sit at the origin; log scale.</div>
    </div>
    <div class="card">
      <h2>Models by price bracket (input $/M)</h2>
      <canvas id="c-hist" class="chart"></canvas>
    </div>
    <div class="card">
      <h2>Count by type</h2>
      <canvas id="c-type" class="chart"></canvas>
    </div>
    <div class="card">
      <h2>Count by category (derived tier)</h2>
      <canvas id="c-cat" class="chart"></canvas>
    </div>
    <div class="card">
      <h2>Average price by provider</h2>
      <canvas id="c-prov" class="chart"></canvas>
    </div>
    <div class="card">
      <h2>Reasoning vs non-reasoning avg price</h2>
      <canvas id="c-reason" class="chart"></canvas>
    </div>
  </div>

  <div class="card">
    <h2>Compare models</h2>
    <div class="cmp-row">
      <div class="cmp-pick">
        <input type="search" id="cmp-search" placeholder="Search models…">
        <div class="cmp-list" id="cmp-list"></div>
      </div>
      <div style="flex:2 1 420px; min-width:0">
        <div class="chips-cmp" id="cmp-chips"></div>
        <canvas id="c-cmp" class="chart" style="height:240px"></canvas>
        <div class="scroll"><table id="cmp-table"></table></div>
      </div>
    </div>
  </div>

  <div class="card">
    <h2>All models</h2>
    <div class="scroll"><table id="t-main"></table></div>
  </div>

</main>
<script>
const MODELS = ${dataJson};

const $ = (id) => document.getElementById(id);
const PALETTE = ${JSON.stringify(PALETTE)};

const state = {
  providers: new Set(),
  type: "all",
  minPrice: 0,
  maxPrice: Infinity,
  sortKey: "provider",
  sortAsc: true,
  selected: [],
  cmpSearch: "",
};

const hasPrice = (m) => m.cost && typeof m.cost.input === "number";
const inPrice = (m) => (m.cost && typeof m.cost.input === "number" ? m.cost.input : null);
const outPrice = (m) => (m.cost && typeof m.cost.output === "number" ? m.cost.output : null);

function tierOf(m) {
  if (hasPrice(m) && inPrice(m) === 0 && outPrice(m) === 0) return "free";
  const s = (m.id + " " + m.name).toLowerCase();
  if (/(nano|mini|flash|lite|small|light|haiku|1b|3b|8b|9b|12b)/.test(s)) return "light";
  if (/(max|opus|ultra|large|huge)/.test(s)) return "premium";
  if (/(pro|plus|sonnet|medium|standard)/.test(s)) return "standard";
  return "other";
}

function fmtRate(v) {
  if (v === null || v === undefined) return "—";
  if (v === 0) return "0";
  if (v >= 1) return v.toFixed(2);
  if (v >= 0.01) return v.toFixed(3).replace(/\\.?0+$/, "");
  return v.toFixed(4).replace(/\\.?0+$/, "");
}
function fmtCtx(v) {
  if (!v) return "—";
  if (v >= 1000000) { const m = v / 1000000; return (Number.isInteger(m) ? m : m.toFixed(1)) + "M"; }
  if (v >= 1000) return Math.round(v / 1000) + "k";
  return String(v);
}

function filtered() {
  return MODELS.filter((m) => {
    if (state.type !== "all" && (m.reasoning ? "yes" : "no") !== state.type) return false;
    const p = inPrice(m);
    if (p === null) return false;
    if (p < state.minPrice || p > state.maxPrice) return false;
    if (state.providers.size > 0 && !state.providers.has(m.provider)) return false;
    return true;
  });
}

// ── canvas helpers ────────────────────────────────────────────────────
function setupCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 600, h = cv.clientHeight || 260;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}
function niceTicks(max) {
  if (max <= 0) return [0, 1];
  const rough = max / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  const step = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  const s = step * mag;
  const ticks = [];
  for (let v = 0; v <= max + 1e-9; v += s) ticks.push(v);
  return ticks;
}
function drawBars(cv, labels, series, opts) {
  // series: [{label, color, values[]}] — grouped bars per label index
  opts = opts || {};
  const { ctx, w, h } = setupCanvas(cv);
  const padL = 46, padB = 26, padT = 14, padR = 8;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  let maxV = 0;
  series.forEach((s) => s.values.forEach((v) => { if (v > maxV) maxV = v; }));
  const ticks = niceTicks(maxV);
  ctx.strokeStyle = "#2a323d"; ctx.fillStyle = "#8a94a0"; ctx.font = "10px system-ui";
  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  ticks.forEach((t) => {
    const y = padT + plotH - (t / maxV) * plotH;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    ctx.fillText(t.toLocaleString(), padL - 5, y);
  });
  const groupW = plotW / labels.length;
  const barW = Math.min(26, (groupW * 0.72) / series.length);
  labels.forEach((lb, i) => {
    series.forEach((s, si) => {
      const v = s.values[i] || 0;
      const x = padL + i * groupW + (groupW - barW * series.length) / 2 + si * barW;
      const bh = (v / maxV) * plotH;
      ctx.fillStyle = s.color;
      ctx.fillRect(x, padT + plotH - bh, barW - 2, bh);
      if (v > 0) { ctx.fillStyle = "#c9d2db"; ctx.textAlign = "center"; ctx.fillText(String(v), x + (barW - 2) / 2, padT + plotH - bh - 8); }
    });
    ctx.fillStyle = "#c3ccd6"; ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.fillText(shortLabel(lb), padL + i * groupW + groupW / 2, padT + plotH + 6);
  });
  if (opts.legend) {
    ctx.textAlign = "left"; ctx.textBaseline = "top"; let lx = padL;
    series.forEach((s) => {
      ctx.fillStyle = s.color; ctx.fillRect(lx, 3, 8, 8);
      ctx.fillStyle = "#c3ccd6"; ctx.fillText(s.label, lx + 12, 2);
      lx += 12 + ctx.measureText(s.label).width + 16;
    });
  }
}
function shortLabel(s) {
  s = String(s);
  return s.length > 12 ? s.slice(0, 10) + "…" : s;
}

// ── scatter ────────────────────────────────────────────────────────────
function drawScatter(cv) {
  const { ctx, w, h } = setupCanvas(cv);
  const items = filtered().filter(hasPrice);
  const padL = 52, padB = 30, padT = 12, padR = 14;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const L = Math.log10(0.001);
  const xs = items.map((m) => Math.max(inPrice(m), 0.0001));
  const ys = items.map((m) => Math.max(outPrice(m), 0.0001));
  const lx = (v) => padL + (Math.log10(v) - L) / (Math.log10(Math.max.apply(null, xs)) - L) * plotW;
  const ly = (v) => padT + plotH - (Math.log10(v) - L) / (Math.log10(Math.max.apply(null, ys)) - L) * plotH;
  ctx.strokeStyle = "#2a323d"; ctx.fillStyle = "#8a94a0"; ctx.font = "10px system-ui";
  for (let e = -3; e <= 2; e++) {
    const v = Math.pow(10, e);
    const x = lx(v); if (x > padL && x < w - padR) {
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
      ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.fillText("$" + v, x, padT + plotH + 4);
    }
    const y = ly(v); if (y > padT && y < padT + plotH) {
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
      ctx.textAlign = "right"; ctx.textBaseline = "middle"; ctx.fillText("$" + v, padL - 5, y);
    }
  }
  const colorOf = (prov) => PALETTE[Object.keys(providerColor).indexOf(prov) % PALETTE.length];
  const pts = items.map((m) => ({
    m, x: lx(inPrice(m)), y: ly(outPrice(m)), r: Math.min(9, 4 + Math.log10((m.contextWindow || 1000) / 1000)),
  }));
  pts.forEach((p) => {
    ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fillStyle = colorOf(p.m.provider) + "cc"; ctx.fill();
    ctx.strokeStyle = "#0f1419"; ctx.lineWidth = 1; ctx.stroke();
  });
  cv._pts = pts; cv._colorOf = colorOf;
}
function scatterTooltip(cv, ev) {
  const pts = cv._pts; if (!pts) return;
  const rect = cv.getBoundingClientRect();
  const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
  let best = null, bd = 400;
  pts.forEach((p) => { const d = (p.x - mx) ** 2 + (p.y - my) ** 2; if (d < bd) { bd = d; best = p; } });
  const tip = $("tip");
  if (best) {
    tip.style.display = "block";
    tip.style.left = (ev.clientX - rect.left + 12) + "px";
    tip.style.top = (ev.clientY - rect.top - 8) + "px";
    tip.innerHTML = "<b>" + best.m.name + "</b><br>" + best.m.provider + " · " + best.m.id +
      "<br>in $" + fmtRate(inPrice(best.m)) + "/M · out $" + fmtRate(outPrice(best.m)) + "/M · ctx " + fmtCtx(best.m.contextWindow);
  } else tip.style.display = "none";
}

// ── tables ─────────────────────────────────────────────────────────────
function renderTable() {
  const rows = filtered();
  const sorted = [...rows].sort((a, b) => {
    let r = 0;
    if (state.sortKey === "in") r = (inPrice(a) ?? 1e9) - (inPrice(b) ?? 1e9);
    else if (state.sortKey === "out") r = (outPrice(a) ?? 1e9) - (outPrice(b) ?? 1e9);
    else if (state.sortKey === "ctx") r = (a.contextWindow || 0) - (b.contextWindow || 0);
    else { const av = a[state.sortKey] || "", bv = b[state.sortKey] || ""; r = String(av).localeCompare(String(bv)); }
    return state.sortAsc ? r : -r;
  });
  const head = [["provider", "Provider"], ["id", "Model"], ["reasoning", "Type"], ["in", "In $/M"], ["out", "Out $/M"], ["cacheRead", "Cache $/M"], ["ctx", "Context"], ["maxTokens", "Max out"]];
  let html = "<tr>" + head.map(([k, l]) => '<th class="num" data-k="' + k + '">' + l + (state.sortKey === k ? (state.sortAsc ? " ▲" : " ▼") : "") + "</th>").join("") + "</tr>";
  sorted.forEach((m) => {
    html += "<tr><td>" + m.provider + "</td><td>" + m.id + "</td><td>" +
      (m.reasoning ? '<span class="pill yes">reasoning</span>' : '<span class="pill no">chat</span>') + '</td><td class="num">$' +
      fmtRate(inPrice(m)) + '</td><td class="num">$' + fmtRate(outPrice(m)) + '</td><td class="num">$' +
      fmtRate(m.cost && m.cost.cacheRead) + '</td><td class="num">' + fmtCtx(m.contextWindow) + '</td><td class="num">' +
      fmtCtx(m.maxTokens) + "</td></tr>";
  });
  $("t-main").innerHTML = html;
}

// ── comparison ─────────────────────────────────────────────────────────
function renderCmpList() {
  const q = state.cmpSearch.toLowerCase();
  const items = MODELS.filter((m) => !q || (m.id + " " + m.name + " " + m.provider).toLowerCase().includes(q));
  const sel = new Set(state.selected);
  let html = "";
  if (items.length === 0) html = '<div class="empty">No matching models</div>';
  items.forEach((m) => {
    const key = m.provider + "/" + m.id;
    html += '<div class="cmp-item"><label><input type="checkbox" data-key="' + key + '"' + (sel.has(key) ? " checked" : "") + '>' +
      '<span>' + m.id + ' <span style="color:#7c8792">[' + m.provider + ']</span></span>' +
      '<span class="p">$' + fmtRate(inPrice(m)) + "/M</span></label></div>";
  });
  $("cmp-list").innerHTML = html;
}
function renderCmp() {
  renderCmpList();
  const sel = state.selected.map((k) => MODELS.find((m) => m.provider + "/" + m.id === k)).filter(Boolean);
  $("cmp-chips").innerHTML = sel.map((m) => '<span class="chip-sel">' + m.id + ' <span class="x" data-key="' + m.provider + "/" + m.id + '">✕</span></span>').join("");
  if (sel.length === 0) { $("cmp-table").innerHTML = '<div class="empty">Pick two or more models from the list to compare.</div>'; return; }
  const labels = ["input", "output", "cache read"];
  const series = sel.map((m, i) => ({
    label: m.id, color: PALETTE[i % PALETTE.length],
    values: [inPrice(m) || 0, outPrice(m) || 0, (m.cost && m.cost.cacheRead) || 0],
  }));
  drawBars($("c-cmp"), labels, series, { legend: true });
  let h = "<tr><th>Metric</th>" + sel.map((m) => "<th>" + m.id + "</th>").join("") + "</tr>";
  const rows = [
    ["Provider", (m) => m.provider],
    ["Type", (m) => m.reasoning ? "reasoning" : "chat"],
    ["Input $/M", (m) => "$" + fmtRate(inPrice(m))],
    ["Output $/M", (m) => "$" + fmtRate(outPrice(m))],
    ["Cache read $/M", (m) => "$" + fmtRate(m.cost && m.cost.cacheRead)],
    ["Context", (m) => fmtCtx(m.contextWindow)],
    ["Max output", (m) => fmtCtx(m.maxTokens)],
  ];
  rows.forEach(([name, fn]) => { h += "<tr><td>" + name + "</td>" + sel.map((m) => "<td>" + fn(m) + "</td>").join("") + "</tr>"; });
  $("cmp-table").innerHTML = h;
}

// ── main charts ────────────────────────────────────────────────────────
const providerColor = {};
function renderCharts() {
  const rows = filtered();

  // histogram by input price bracket
  const brackets = [0, 0.1, 0.5, 1, 2, 5, 10, 25, 50];
  const counts = brackets.map(() => 0);
  rows.forEach((m) => { const p = inPrice(m); if (p === null) return; let i = 0; while (i < brackets.length - 1 && p >= brackets[i + 1]) i++; counts[i]++; });
  drawBars($("c-hist"), brackets.slice(0, -1).map((b, i) => "$" + b + "–" + brackets[i + 1]), [{ label: "models", color: "#4cc2ff", values: counts }]);

  // count by type
  const nR = rows.filter((m) => m.reasoning).length;
  const nC = rows.length - nR;
  drawBars($("c-type"), ["reasoning", "chat"], [{ label: "", color: "#57d9a3", values: [nR, nC] }]);

  // count by category (derived tier)
  const tiers = ["free", "light", "standard", "premium", "other"];
  const tc = tiers.map((t) => rows.filter((m) => tierOf(m) === t).length);
  drawBars($("c-cat"), tiers, [{ label: "", color: "#b58cff", values: tc }]);

  // average price by provider
  const provs = [...new Set(rows.map((m) => m.provider))];
  const avgIn = provs.map((p) => { const v = rows.filter((m) => m.provider === p && inPrice(m) !== null).map(inPrice); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; });
  const avgOut = provs.map((p) => { const v = rows.filter((m) => m.provider === p && outPrice(m) !== null).map(outPrice); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; });
  drawBars($("c-prov"), provs.map(shortLabel), [
    { label: "in", color: "#4cc2ff", values: avgIn },
    { label: "out", color: "#f2a33c", values: avgOut },
  ], { legend: true });

  // reasoning vs non-reasoning avg
  const rR = rows.filter((m) => m.reasoning && inPrice(m) !== null).map(inPrice);
  const rC = rows.filter((m) => !m.reasoning && inPrice(m) !== null).map(inPrice);
  drawBars($("c-reason"), ["reasoning", "chat"], [
    { label: "avg in", color: "#57d9a3", values: [rR.length ? rR.reduce((a, b) => a + b, 0) / rR.length : 0, rC.length ? rC.reduce((a, b) => a + b, 0) / rC.length : 0] },
  ]);

  // provider color map for scatter
  Object.keys(providerColor).forEach((k) => delete providerColor[k]);
  provs.forEach((p, i) => { providerColor[p] = PALETTE[i % PALETTE.length]; });

  drawScatter($("c-scatter"));
  renderTable();
}

function refresh() {
  renderCharts();
  renderCmp();
  $("meta-count").textContent = filtered().length + " of " + MODELS.length + " models";
}

// ── events ─────────────────────────────────────────────────────────────
function initProviders() {
  const provs = [...new Set(MODELS.map((m) => m.provider))];
  $("f-providers").innerHTML = provs.map((p) => '<span class="chip on" data-p="' + p + '">' + p + "</span>").join("");
  $("f-providers").querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => {
    c.classList.toggle("on");
    if (c.classList.contains("on")) state.providers.add(c.dataset.p);
    else state.providers.delete(c.dataset.p);
    refresh();
  }));
}
$("f-type").addEventListener("change", (e) => { state.type = e.target.value; refresh(); });
$("f-min").addEventListener("input", (e) => { state.minPrice = parseFloat(e.target.value) || 0; refresh(); });
$("f-max").addEventListener("input", (e) => { state.maxPrice = e.target.value === "" ? Infinity : parseFloat(e.target.value) || 0; refresh(); });
$("f-reset").addEventListener("click", () => {
  state.providers.clear(); state.type = "all"; state.minPrice = 0; state.maxPrice = Infinity;
  $("f-type").value = "all"; $("f-min").value = "0"; $("f-max").value = "";
  document.querySelectorAll("#f-providers .chip").forEach((c) => c.classList.add("on"));
  refresh();
});
$("t-main").addEventListener("click", (e) => {
  const th = e.target.closest("th"); if (!th) return;
  const k = th.dataset.k;
  if (state.sortKey === k) state.sortAsc = !state.sortAsc; else { state.sortKey = k; state.sortAsc = true; }
  renderTable();
});
$("cmp-search").addEventListener("input", (e) => { state.cmpSearch = e.target.value; renderCmpList(); });
$("cmp-list").addEventListener("change", (e) => {
  if (!e.target.matches("input[type=checkbox]")) return;
  const k = e.target.dataset.key;
  if (e.target.checked) state.selected.push(k); else state.selected = state.selected.filter((x) => x !== k);
  renderCmp();
});
$("cmp-chips").addEventListener("click", (e) => {
  const x = e.target.closest(".x"); if (!x) return;
  state.selected = state.selected.filter((k) => k !== x.dataset.key);
  renderCmp();
});
const scatter = $("c-scatter");
scatter.addEventListener("mousemove", (e) => scatterTooltip(scatter, e));
scatter.addEventListener("mouseleave", () => { const t = $("tip"); if (t) t.style.display = "none"; });

const tip = document.createElement("div");
tip.id = "tip";
tip.style.cssText = "position:absolute;display:none;background:#1a222b;border:1px solid #2c3540;border-radius:8px;padding:8px 10px;font-size:12px;pointer-events:none;z-index:10;max-width:320px";
scatter.parentElement.style.position = "relative";
scatter.parentElement.appendChild(tip);

$("meta-date").textContent = new Date().toLocaleString();
initProviders();
refresh();
</script>
</body>
</html>`;
}
