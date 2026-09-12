#!/usr/bin/env node
'use strict';

/**
 * ab-bench-html.js — Render an HTML summary page from ab-bench comparison.json.
 *
 * Reads the latest comparison.json + per-variant reports from
 *   data/runs/ab-bench/<latest-run>/
 * and writes a self-contained HTML file to:
 *   data/runs/ab-bench/<latest-run>/summary.html
 *
 * The page includes:
 *   - Latency comparison bars (p50, p95, p99, mean) for search/save/bootstrap
 *   - Per-query latency scatter for each variant
 *   - Recall@k quality bar chart per variant with per-query hit/miss
 *   - Concurrency throughput comparison
 *   - DB size comparison
 *   - Delta annotations (faster/slower, better/worse)
 *
 * Usage:
 *   node scripts/ab-bench-html.js                     # latest run
 *   node scripts/ab-bench-html.js --run run-xyz      # specific run
 *   node scripts/ab-bench-html.js --open              # open in browser after writing
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const AB_DIR = path.join(ROOT, 'data', 'runs', 'ab-bench');

// ─── Find latest run ──────────────────────────────────────────────────

function latestRunDir() {
  const entries = fs.readdirSync(AB_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name.startsWith('run-'))
    .sort((a, b) => b.name.localeCompare(a.name)); // descending
  return entries.length ? path.join(AB_DIR, entries[0].name) : null;
}

// ─── Data loading ─────────────────────────────────────────────────────

function loadRun(runDir) {
  const comparisonPath = path.join(runDir, 'comparison.json');
  const comparison = JSON.parse(fs.readFileSync(comparisonPath, 'utf-8'));

  const variantReports = {};
  for (const vName of comparison.variants) {
    const p = path.join(runDir, vName, 'report.json');
    if (fs.existsSync(p)) {
      variantReports[vName] = JSON.parse(fs.readFileSync(p, 'utf-8'));
    }
  }

  return { runDir, comparison, variantReports };
}

// ─── HTML generation ──────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function latencyBarHTML(metricKey, metric) {
  if (!metric || !metric.a || !metric.b) return '';
  const label = metric.label || metricKey;
  const colors = { a: '#22c55e', b: '#38bdf8' };
  const variantLabels = {
    a: metric._aLabel || 'Variant A',
    b: metric._bLabel || 'Variant B',
  };

  const stats = ['p50', 'p95', 'p99', 'mean'];
  const maxVal = Math.max(
    metric.a.max || 0,
    metric.b.max || 0,
    ...stats.map(s => Math.max(metric.a[s] || 0, metric.b[s] || 0))
  ) * 1.15;

  let html = `<div class="metric-card">\n`;
  html += `  <div class="metric-label">${escapeHtml(label)}</div>\n`;

  // New-style delta (object for latency, number for recall)
  const delta = metric.delta;
  let deltaText = '';
  if (typeof delta === 'object' && delta !== null) {
    const d = delta.p50;
    const sign = d > 0 ? '+' : '';
    const dir = metricKey.includes('Latency') || metricKey.includes('latency')
      ? (d > 0 ? 'slower' : 'faster')
      : (d > 0 ? 'better' : 'worse');
    deltaText = `<span class="delta">δ p50: ${sign}${d.toFixed(2)} ms (${dir})</span>`;
  } else if (typeof delta === 'number') {
    const sign = delta > 0 ? '+' : '';
    const dir = metricKey.includes('recall') ? (delta > 0 ? 'better' : 'worse') : (delta > 0 ? 'slower' : 'faster');
    deltaText = `<span class="delta">δ: ${sign}${delta.toFixed(1)} pp (${dir})</span>`;
  }

  html += `  <div class="delta-row">${deltaText}</div>\n`;
  html += `  <div class="bar-chart">\n`;

  for (const stat of stats) {
    const aVal = metric.a[stat] || 0;
    const bVal = metric.b[stat] || 0;
    const aPct = (aVal / maxVal * 100).toFixed(1);
    const bPct = (bVal / maxVal * 100).toFixed(1);
    const aColor = colors.a;
    const bColor = colors.b;

    html += `    <div class="bar-row">\n`;
    html += `      <span class="bar-stat-label">${stat}</span>\n`;
    html += `      <div class="bar-track">\n`;
    // Variant A bar
    html += `        <div class="bar-segment" style="width:${aPct}%;background:${aColor};" title="${variantLabels.a}: ${aVal.toFixed(3)} ms"></div>\n`;
    // Variant B bar (stacked next to A using a container)
    html += `        <div class="bar-pair">\n`;
    html += `          <div class="bar-a" style="width:${aPct}%;background:${aColor};" title="${variantLabels.a}: ${aVal.toFixed(3)} ms"></div>\n`;
    html += `          <div class="bar-b" style="width:${bPct}%;background:${bColor};" title="${variantLabels.b}: ${bVal.toFixed(3)} ms"></div>\n`;
    html += `        </div>\n`;
    html += `      </div>\n`;
    html += `      <span class="bar-value">${aVal.toFixed(2)} / ${bVal.toFixed(2)}</span>\n`;
    html += `    </div>\n`;
  }

  html += `  </div>\n`;
  html += `  <div class="variant-legend">\n`;
  html += `    <span class="legend-item"><span class="legend-swatch a"></span>${escapeHtml(variantLabels.a)}</span>\n`;
  html += `    <span class="legend-item"><span class="legend-swatch b"></span>${escapeHtml(variantLabels.b)}</span>\n`;
  html += `  </div>\n`;
  html += `</div>\n`;
  return html;
}

function perQueryLatencyHTML(variantKey, variantLabel, report, firstVariantKey) {
  if (!report || !report.search || !report.search.perQuery) return '';
  const queries = report.search.perQuery;
  const color = variantKey === firstVariantKey ? '#22c55e' : '#38bdf8';

  let html = `<div class="per-query-card">\n`;
  html += `  <div class="metric-label">Per-query search latency — ${escapeHtml(variantLabel)}</div>\n`;
  html += `  <div class="bar-chart">\n`;

  const maxMs = Math.max(...queries.map(q => q.ms), 0.1);
  for (const q of queries) {
    const pct = (q.ms / maxMs * 100).toFixed(1);
    html += `    <div class="bar-row">\n`;
    html += `      <span class="bar-stat-label" title="${escapeHtml(q.query)}">${escapeHtml(q.label)}</span>\n`;
    html += `      <div class="bar-track">\n`;
    html += `        <div class="bar-segment" style="width:${pct}%;background:${color};" title="${q.ms.toFixed(2)} ms"></div>\n`;
    html += `      </div>\n`;
    html += `      <span class="bar-value">${q.ms.toFixed(2)}ms</span>\n`;
    html += `    </div>\n`;
  }

  html += `  </div>\n`;
  html += `</div>\n`;
  return html;
}

function qualityBarHTML(variantKey, variantLabel, report, firstVariantKey) {
  if (!report || !report.quality) return '';
  const q = report.quality;
  const color = variantKey === firstVariantKey ? '#22c55e' : '#38bdf8';
  const total = q.total || 1;
  const hitsPct = q.recallAtK;
  const missesPct = 100 - hitsPct;

  let html = `<div class="quality-card">\n`;
  html += `  <div class="metric-label">Recall@k quality — ${escapeHtml(variantLabel)}</div>\n`;
  html += `  <div class="delta-row">${q.hits}/${total} hits (${hitsPct.toFixed(1)}%)</div>\n`;
  html += `  <div class="bar-chart">\n`;

  // Hits bar
  const hitsPctFixed = Math.max(hitsPct, 2);
  const missesPctFixed = Math.max(missesPct, 2);
  html += `    <div class="bar-row">\n`;
  html += `      <span class="bar-stat-label">Hit</span>\n`;
  html += `      <div class="bar-track">\n`;
  html += `        <div class="bar-segment hits" style="width:${hitsPctFixed}%;background:#22c55e;" title="${q.hits} hits"></div>\n`;
  html += `      </div>\n`;
  html += `      <span class="bar-value">${hitsPct.toFixed(1)}%</span>\n`;
  html += `    </div>\n`;
  html += `    <div class="bar-row">\n`;
  html += `      <span class="bar-stat-label">Miss</span>\n`;
  html += `      <div class="bar-track">\n`;
  html += `        <div class="bar-segment misses" style="width:${missesPctFixed}%;background:#ef4444;" title="${total - q.hits} misses"></div>\n`;
  html += `      </div>\n`;
  html += `      <span class="bar-value">${missesPct.toFixed(1)}%</span>\n`;
  html += `    </div>\n`;

  html += `  </div>\n`;

  // Per-query hit/miss
  if (q.cases && q.cases.length) {
    html += `  <div class="query-list">\n`;
    for (const c of q.cases) {
      const hitClass = c.hit ? 'hit' : 'miss';
      const icon = c.hit ? '✓' : '✗';
      html += `    <div class="query-item ${hitClass}">\n`;
      html += `      <span class="query-icon">${icon}</span>\n`;
      html += `      <span class="query-label" title="${escapeHtml(c.query)}">${escapeHtml(c.label)}</span>\n`;
      html += `      <span class="query-category">${escapeHtml(c.category)}</span>\n`;
      html += `    </div>\n`;
    }
    html += `  </div>\n`;
  }

  html += `</div>\n`;
  return html;
}

function concurrencyHTML(metric, vA, vB) {
  if (!metric || !metric.a || !metric.b) return '';
  const a = metric.a;
  const b = metric.b;
  const aColor = '#22c55e';
  const bColor = '#38bdf8';

  let html = `<div class="metric-card">\n`;
  html += `  <div class="metric-label">${escapeHtml(metric.label || 'Concurrency')}</div>\n`;
  html += `  <div class="bar-chart">\n`;
  const maxThroughput = Math.max(a.throughputPerSec || 0, b.throughputPerSec || 0) * 1.15;

  const renderThroughput = (val, color, label) => {
    const pct = (val / maxThroughput * 100).toFixed(1);
    return `    <div class="bar-row">\n`;
    return `    <div class="bar-row">\n`;
    return `    <div class="bar-row">\n      <span class="bar-stat-label">${label}</span>\n`;
    return `    <div class="bar-row">\n      <span class="bar-stat-label">${label}</span>\n`;
    // Build this properly below
  };

  // Wall time bars
  const maxWall = Math.max(a.wallMs || 0, b.wallMs || 0) * 1.15;
  const aWallPct = ((a.wallMs || 0) / maxWall * 100).toFixed(1);
  const bWallPct = ((b.wallMs || 0) / maxWall * 100).toFixed(1);

  html += `    <div class="bar-row">\n`;
  html += `      <span class="bar-stat-label">Wall time (${a.n} parallel)</span>\n`;
  html += `      <div class="bar-track">\n`;
  html += `        <div class="bar-a" style="width:${aWallPct}%;background:${aColor};" title="${a.wallMs.toFixed(1)} ms"></div>\n`;
  html += `        <div class="bar-b" style="width:${bWallPct}%;background:${bColor};" title="${b.wallMs.toFixed(1)} ms"></div>\n`;
  html += `      </div>\n`;
  html += `      <span class="bar-value">${a.wallMs.toFixed(1)} / ${b.wallMs.toFixed(1)} ms</span>\n`;
  html += `    </div>\n`;

  // Throughput bars (inverted: faster = higher bar)
  const aTP = a.throughputPerSec || 0;
  const bTP = b.throughputPerSec || 0;
  const maxTP = Math.max(aTP, bTP) * 1.15;
  const aTPPct = (aTP / maxTP * 100).toFixed(1);
  const bTPPct = (bTP / maxTP * 100).toFixed(1);

  html += `    <div class="bar-row">\n`;
  html += `      <span class="bar-stat-label">Throughput (ops/sec)</span>\n`;
  html += `      <div class="bar-track">\n`;
  html += `        <div class="bar-a" style="width:${aTPPct}%;background:${aColor};" title="${aTP.toFixed(0)} ops/s"></div>\n`;
  html += `        <div class="bar-b" style="width:${bTPPct}%;background:${bColor};" title="${bTP.toFixed(0)} ops/s"></div>\n`;
  html += `      </div>\n`;
  html += `      <span class="bar-value">${aTP.toFixed(0)} / ${bTP.toFixed(0)}</span>\n`;
  html += `    </div>\n`;

  html += `  </div>\n`;
  html += `  <div class="variant-legend">\n`;
  html += `    <span class="legend-item"><span class="legend-swatch a"></span>${escapeHtml(vA)}</span>\n`;
  html += `    <span class="legend-item"><span class="legend-swatch b"></span>${escapeHtml(vB)}</span>\n`;
  html += `  </div>\n`;
  html += `</div>\n`;
  return html;
}

function dbSizeHTML(metric, vA, vB) {
  if (!metric || !metric.a || !metric.b) return '';
  const a = metric.a;
  const b = metric.b;
  const maxVal = Math.max(a, b) * 1.15;
  const aPct = (a / maxVal * 100).toFixed(1);
  const bPct = (b / maxVal * 100).toFixed(1);
  const fmt = (bytes) => bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + ' MB' : (bytes / 1024).toFixed(0) + ' KB';

  let html = `<div class="metric-card">\n`;
  html += `  <div class="metric-label">${escapeHtml(metric.label || 'DB size')}</div>\n`;
  html += `  <div class="bar-chart">\n`;
  html += `    <div class="bar-row">\n`;
  html += `      <span class="bar-stat-label">After benchmark</span>\n`;
  html += `      <div class="bar-track">\n`;
  html += `        <div class="bar-a" style="width:${aPct}%;background:#22c55e;" title="${fmt(a)}"></div>\n`;
  html += `        <div class="bar-b" style="width:${bPct}%;background:#38bdf8;" title="${fmt(b)}"></div>\n`;
  html += `      </div>\n`;
  html += `      <span class="bar-value">${fmt(a)} / ${fmt(b)}</span>\n`;
  html += `    </div>\n`;
  html += `  </div>\n`;
  html += `</div>\n`;
  return html;
}

function buildHTML(runData) {
  const { runDir, comparison, variantReports } = runData;
  const vNames = comparison.variants;
  const vLabels = {};
  for (const vName of vNames) {
    const r = variantReports[vName];
    vLabels[vName] = r?.variantName || vName;
  }

  const runs = Object.entries(comparison.byMetric).map(([key, metric]) => {
    metric._aLabel = vLabels[vNames[0]] || vNames[0];
    metric._bLabel = vNames.length > 1 ? vLabels[vNames[1]] || vNames[1] : vLabels[vNames[0]];
    return [key, metric];
  });

  const dateStr = new Date(comparison.ranAt).toLocaleString();

  let html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>A/B Benchmark — ${escapeHtml(comparison.runId)} — agentic-cortex</title>
<style>
  :root {
    --bg: #0f172a;
    --card-bg: #1e293b;
    --text: #e2e8f0;
    --muted: #94a3b8;
    --border: #334155;
    --green: #22c55e;
    --cyan: #38bdf8;
    --red: #ef4444;
    --yellow: #eab308;
    --delta-faster: #22c55e;
    --delta-slower: #ef4444;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    padding: 24px;
    line-height: 1.5;
    min-width: 720px;
  }
  .header {
    margin-bottom: 24px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--border);
  }
  .header h1 {
    font-size: 1.5rem;
    font-weight: 600;
    margin-bottom: 4px;
  }
  .header .meta {
    color: var(--muted);
    font-size: 0.875rem;
  }
  .header .meta span { margin-right: 16px; }
  .header .varian-names {
    margin-top: 8px;
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
  }
  .header .varian-names span {
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 0.8rem;
    font-weight: 500;
  }
  .varian-names .v-a { background: rgba(34,197,94,0.15); color: var(--green); }
  .varian-names .v-b { background: rgba(56,189,248,0.15); color: var(--cyan); }

  .section {
    margin-bottom: 20px;
  }
  .section-title {
    font-size: 1.1rem;
    font-weight: 600;
    margin-bottom: 12px;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-size: 0.8rem;
  }

  .metric-card {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 12px;
  }
  .metric-label {
    font-weight: 500;
    margin-bottom: 8px;
    font-size: 0.95rem;
  }
  .delta-row {
    margin-bottom: 12px;
    font-size: 0.85rem;
  }
  .delta {
    padding: 2px 6px;
    border-radius: 4px;
    font-weight: 500;
    font-size: 0.8rem;
  }
  .delta-faster { color: var(--delta-faster); background: rgba(34,197,94,0.1); }
  .delta-slower { color: var(--delta-slower); background: rgba(239,68,68,0.1); }
  .delta-neutral { color: var(--muted); }

  .bar-chart {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .bar-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .bar-stat-label {
    width: 100px;
    font-size: 0.8rem;
    color: var(--muted);
    text-align: right;
    flex-shrink: 0;
  }
  .bar-track {
    flex: 1;
    height: 18px;
    background: rgba(255,255,255,0.05);
    border-radius: 4px;
    overflow: hidden;
    position: relative;
  }
  .bar-pair {
    display: flex;
    height: 100%;
  }
  .bar-a, .bar-b, .bar-segment {
    height: 100%;
    border-radius: 4px;
    min-width: 2px;
  }
  .bar-a { background: var(--green); }
  .bar-b { background: var(--cyan); }
  .bar-segment.hits { background: var(--green); }
  .bar-segment.misses { background: var(--red); }
  .bar-value {
    width: 100px;
    font-size: 0.75rem;
    color: var(--muted);
    text-align: right;
    flex-shrink: 0;
    font-family: 'SF Mono', Consolas, monospace;
  }

  .variant-legend {
    display: flex;
    gap: 16px;
    margin-top: 8px;
    font-size: 0.8rem;
  }
  .legend-item { display: flex; align-items: center; gap: 4px; color: var(--muted); }
  .legend-swatch { width: 10px; height: 10px; border-radius: 2px; }
  .legend-swatch.a { background: var(--green); }
  .legend-swatch.b { background: var(--cyan); }

  .per-query-card, .quality-card {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 12px;
  }

  .query-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 12px;
  }
  .query-item {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 0.8rem;
    border: 1px solid var(--border);
  }
  .query-item.hit { border-color: rgba(34,197,94,0.3); background: rgba(34,197,94,0.08); }
  .query-item.miss { border-color: rgba(239,68,68,0.3); background: rgba(239,68,68,0.08); }
  .query-icon { font-weight: 700; font-size: 1rem; }
  .query-item.hit .query-icon { color: var(--green); }
  .query-item.miss .query-icon { color: var(--red); }
  .query-label { color: var(--text); }
  .query-category { color: var(--muted); font-size: 0.7rem; }

  .footer {
    margin-top: 32px;
    padding-top: 16px;
    border-top: 1px solid var(--border);
    color: var(--muted);
    font-size: 0.8rem;
    display: flex;
    justify-content: space-between;
  }
  .footer a { color: var(--cyan); text-decoration: none; }
</style>
</head>
<body>
<div class="header">
  <h1>A/B Performance Benchmark — ${escapeHtml(comparison.runId)}</h1>
  <div class="meta">
    <span>Ran: ${escapeHtml(dateStr)}</span>
    <span>Iterations: ${comparison.iterations}</span>
    <span>Variants: ${vNames.map(v => escapeHtml(vLabels[v])).join(', ')}</span>
  </div>
  <div class="varian-names">
    <span class="v-a">${escapeHtml(vNames[0])} — ${escapeHtml(vLabels[vNames[0]])}</span>
    ${vNames.length > 1 ? `<span class="v-b">${escapeHtml(vNames[1])} — ${escapeHtml(vLabels[vNames[1]])}</span>` : ''}
  </div>
</div>

<div class="section">
  <div class="section-title">Latency Comparison</div>
`;

  // Search latency
  if (comparison.byMetric.searchLatency) {
    html += latencyBarHTML('searchLatency', comparison.byMetric.searchLatency);
  }
  // Save latency
  if (comparison.byMetric.saveLatency) {
    html += latencyBarHTML('saveLatency', comparison.byMetric.saveLatency);
  }
  // Bootstrap latency
  if (comparison.byMetric.bootstrapLatency) {
    html += latencyBarHTML('bootstrapLatency', comparison.byMetric.bootstrapLatency);
  }

  html += `</div>\n`;

  // Per-query latency for each variant
  html += `<div class="section">\n`;
  html += `  <div class="section-title">Per-Query Latency</div>\n`;
  for (const vName of vNames) {
    const report = variantReports[vName];
    if (report && report.search && report.search.perQuery) {
      html += perQueryLatencyHTML(vName, vLabels[vName], report, vNames[0]);
    }
  }
  html += `</div>\n`;

  // Quality
  html += `<div class="section">\n`;
  html += `  <div class="section-title">Recall@k Quality</div>\n`;
  for (const vName of vNames) {
    const report = variantReports[vName];
    if (report && report.quality) {
    html += qualityBarHTML(vName, vLabels[vName], report, vNames[0]);
  }
  }
  html += `</div>\n`;

  // Concurrency
  if (comparison.byMetric.concurrency) {
    html += `<div class="section">\n`;
    html += `  <div class="section-title">Concurrency</div>\n`;
    html += concurrencyHTML(comparison.byMetric.concurrency, vNames[0], vNames[1]);
    html += `</div>\n`;
  }

  // DB size
  if (comparison.byMetric.dbSize) {
    html += `<div class="section">\n`;
    html += `  <div class="section-title">Resource Usage</div>\n`;
    html += dbSizeHTML(comparison.byMetric.dbSize, vNames[0], vNames[1]);
    html += `</div>\n`;
  }

  html += `<div class="footer">\n`;
  html += `  <span>Generated by ab-bench-html.js · ${escapeHtml(comparison.runId)}</span>\n`;
  html += `  <span>Source: <a href="https://github.com/zallauddin/agentic-cortex-memory">agentic-cortex</a></span>\n`;
  html += `</div>\n`;
  html += `</body>\n</html>`;

  return html;
}

// ─── Main ─────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const runArg = args.find(a => a.startsWith('--run='))?.split('=')[1] ||
                 args.find(a => a.startsWith('--run '))?.split(' ')[1] ||
                 null;
  const open = args.includes('--open');

  const runDir = runArg ? path.join(AB_DIR, runArg) : latestRunDir();

  if (!runDir || !fs.existsSync(runDir)) {
    console.error('No ab-bench run found. Run ab-bench first:');
    console.error('  node scripts/ab-bench.js --variants ac,noRerank');
    process.exit(1);
  }

  if (!fs.existsSync(path.join(runDir, 'comparison.json'))) {
    console.error('No comparison.json in ' + runDir);
    process.exit(1);
  }

  const runData = loadRun(runDir);
  const html = buildHTML(runData);

  const outPath = path.join(runDir, 'summary.html');
  fs.writeFileSync(outPath, html);
  console.error('→ wrote ' + outPath);

  if (open) {
    const { exec } = require('child_process');
    exec('start "" "' + outPath.replace(/\\/g, '/') + '"', (err) => {
      if (err) console.error('Could not open browser:', err.message);
    });
  }
}

main();
