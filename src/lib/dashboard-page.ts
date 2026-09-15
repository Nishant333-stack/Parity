/**
 * The public dashboard's HTML shell. Fetches its own data client-side from
 * /api/snapshot (same Lambda Function URL, same origin — no CORS) on a
 * timer, genuinely live, no dependency on a Claude session or manual push.
 *
 * Deliberately product-voiced, not infrastructure-voiced: no AWS service
 * names, no framework namedrops, in the copy a viewer actually reads. What
 * runs underneath is documented in the ADRs and walkthroughs — a dashboard
 * is not the place to relitigate the tech stack.
 *
 * Public, no auth (a deliberate choice — see docs/adr/0006): everything
 * this page shows is Stripe test-mode data. No secrets, no real money.
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Parity Live</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@600;700;800&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #F2F3EE;
    --surface: #FFFFFF;
    --surface-2: #F7F8F4;
    --ink: #14181C;
    --ink-muted: #5B6169;
    --ink-faint: #8A9089;
    --border: #DEE2D9;
    --accent: #0E7A78;
    --accent-ink: #075856;
    --accent-soft: #E3F2F0;
    --good: #1C8A5A;
    --good-soft: #E5F4EC;
    --warning: #A5700D;
    --warning-soft: #FAF0DC;
    --critical: #B93A2E;
    --critical-soft: #FBE9E6;
    --shadow: 0 1px 2px rgba(20, 24, 28, 0.04), 0 8px 24px -12px rgba(20, 24, 28, 0.12);
    --radius: 10px;
    color-scheme: light;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #0E1116; --surface: #161B22; --surface-2: #1B212A;
      --ink: #E8EBEF; --ink-muted: #8B94A3; --ink-faint: #5C6572; --border: #262D38;
      --accent: #35C4BE; --accent-ink: #8FE6E1; --accent-soft: #123634;
      --good: #34C481; --good-soft: #12301F;
      --warning: #E3A93C; --warning-soft: #332811;
      --critical: #F0594B; --critical-soft: #331714;
      --shadow: 0 1px 2px rgba(0,0,0,0.3), 0 8px 28px -12px rgba(0,0,0,0.55);
      color-scheme: dark;
    }
  }
  :root[data-theme="dark"] {
    --bg: #0E1116; --surface: #161B22; --surface-2: #1B212A;
    --ink: #E8EBEF; --ink-muted: #8B94A3; --ink-faint: #5C6572; --border: #262D38;
    --accent: #35C4BE; --accent-ink: #8FE6E1; --accent-soft: #123634;
    --good: #34C481; --good-soft: #12301F;
    --warning: #E3A93C; --warning-soft: #332811;
    --critical: #F0594B; --critical-soft: #331714;
    --shadow: 0 1px 2px rgba(0,0,0,0.3), 0 8px 28px -12px rgba(0,0,0,0.55);
    color-scheme: dark;
  }

  * { box-sizing: border-box; }
  html { text-size-adjust: 100%; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font-family: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
    padding-inline: 20px; padding-block: 28px 60px;
  }
  .wrap { max-width: 1180px; margin-inline: auto; display: flex; flex-direction: column; gap: 18px; }
  .mono { font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace; font-variant-numeric: tabular-nums; }
  button { font: inherit; }

  /* ---------- masthead ---------- */
  .masthead { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; padding-block: 4px 6px; border-bottom: 2px solid var(--ink); }
  .wordmark-group { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
  .wordmark {
    font-family: "Big Shoulders Display", sans-serif; font-weight: 800;
    font-size: clamp(34px, 6vw, 48px); letter-spacing: 0.01em; line-height: 1; margin: 0;
    text-transform: uppercase; color: var(--accent-ink);
  }
  .tagline { color: var(--ink-muted); font-size: 13px; letter-spacing: 0.04em; text-transform: uppercase; font-weight: 500; display: inline-flex; align-items: center; gap: 7px; }
  .tagline::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); flex: none; }
  .status-cluster { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  .status-pill { display: inline-flex; align-items: center; gap: 8px; padding: 7px 13px 7px 10px; border-radius: 999px; font-size: 13px; font-weight: 600; }
  .status-pill .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 22%, transparent); }
  .status-pill.good { background: var(--good-soft); color: var(--good); }
  .status-pill.warning { background: var(--warning-soft); color: var(--warning); }
  .status-pill.critical { background: var(--critical-soft); color: var(--critical); }
  .status-pill.live .dot { animation: pulse 2.2s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
  @media (prefers-reduced-motion: reduce) { .status-pill.live .dot { animation: none; } }

  /* ---------- toolbar ---------- */
  .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
  .control-group { display: inline-flex; align-items: center; gap: 3px; background: var(--surface); border: 1px solid var(--border); border-radius: 999px; padding: 3px; box-shadow: var(--shadow); }
  .control-group button {
    border: none; background: transparent; color: var(--ink-muted); cursor: pointer;
    padding: 6px 12px; border-radius: 999px; font-size: 12.5px; font-weight: 600;
    transition: background-color 0.15s ease, color 0.15s ease;
  }
  .control-group button:hover { color: var(--ink); }
  .control-group button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .control-group button.active { background: var(--accent); color: white; }
  .icon-btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 32px; height: 32px; border-radius: 999px; border: 1px solid var(--border);
    background: var(--surface); color: var(--ink-muted); cursor: pointer; box-shadow: var(--shadow);
  }
  .icon-btn:hover { color: var(--ink); }
  .icon-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .icon-btn.spinning svg { animation: spin 0.7s linear; }
  @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  .toolbar-right { display: flex; align-items: center; gap: 10px; }
  .updated { font-size: 12.5px; color: var(--ink-faint); }
  .updated strong { color: var(--ink-muted); font-weight: 600; }

  /* ---------- alerts ---------- */
  .alerts { display: none; flex-direction: column; gap: 8px; }
  .alerts.show { display: flex; }
  .alert {
    display: flex; align-items: flex-start; gap: 10px; padding: 11px 14px; border-radius: var(--radius);
    border: 1px solid transparent; font-size: 13.5px; line-height: 1.5; cursor: pointer; text-align: left; width: 100%;
    font-family: inherit; background: none;
  }
  .alert.critical { background: var(--critical-soft); color: var(--critical); border-color: color-mix(in srgb, var(--critical) 30%, transparent); }
  .alert.warning { background: var(--warning-soft); color: var(--warning); border-color: color-mix(in srgb, var(--warning) 30%, transparent); }
  .alert:hover { filter: brightness(0.97); }
  .alert:focus-visible { outline: 2px solid currentColor; outline-offset: 1px; }
  .alert-icon { flex: none; margin-top: 1px; }
  .tile.highlight { outline: 2px solid var(--accent); outline-offset: 2px; }

  /* ---------- hero ---------- */
  .hero {
    background: var(--surface); border: 1px solid var(--border); border-top: 3px solid var(--accent);
    border-radius: var(--radius); box-shadow: var(--shadow); padding: 26px 28px;
    display: flex; align-items: center; justify-content: space-between; gap: 24px; flex-wrap: wrap;
    position: relative; overflow: hidden;
  }
  .hero::before {
    content: ""; position: absolute; inset: 0;
    background-image: repeating-linear-gradient(to bottom, transparent, transparent 27px, color-mix(in srgb, var(--border) 65%, transparent) 28px);
    -webkit-mask-image: linear-gradient(to right, black, transparent 70%); mask-image: linear-gradient(to right, black, transparent 70%);
    opacity: 0.6; pointer-events: none;
  }
  .hero-label { font-size: 12.5px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-muted); margin: 0 0 6px; position: relative; }
  .hero-figure-row { display: flex; align-items: flex-end; gap: 16px; position: relative; }
  .hero-figure { font-family: "Big Shoulders Display", sans-serif; font-weight: 700; font-size: clamp(40px, 7vw, 64px); line-height: 1; margin: 0; font-variant-numeric: tabular-nums; }
  .hero-figure.good { color: var(--good); }
  .hero-figure.critical { color: var(--critical); }
  .hero-spark { padding-bottom: 10px; }
  .hero-spark-caption { font-size: 10.5px; color: var(--ink-faint); margin: 2px 0 0; position: relative; }
  .hero-sub { color: var(--ink-muted); font-size: 13.5px; max-width: 46ch; margin-top: 8px; position: relative; text-wrap: balance; }
  .hero-side { text-align: right; position: relative; }
  .hero-side .k { display: block; font-size: 12px; color: var(--ink-faint); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 3px; }
  .hero-side .v { display: block; font-size: 20px; font-weight: 600; }
  .hero-side-row { display: flex; gap: 28px; }

  /* ---------- tile grid ---------- */
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 14px; }
  .tile {
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow);
    padding: 16px 18px 18px; display: flex; flex-direction: column; gap: 10px;
    animation: rise 0.5s ease both; transition: outline-color 0.2s ease;
  }
  .tile:nth-child(1) { animation-delay: 0.02s; } .tile:nth-child(2) { animation-delay: 0.06s; }
  .tile:nth-child(3) { animation-delay: 0.10s; } .tile:nth-child(4) { animation-delay: 0.14s; }
  .tile:nth-child(5) { animation-delay: 0.18s; } .tile:nth-child(6) { animation-delay: 0.22s; }
  @keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
  @media (prefers-reduced-motion: reduce) { .tile { animation: none; } }
  .tile-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .tile-title { font-size: 13px; font-weight: 600; letter-spacing: 0.02em; margin: 0; }
  .chip { font-size: 11px; font-weight: 600; letter-spacing: 0.03em; text-transform: uppercase; padding: 3px 8px; border-radius: 999px; }
  .chip.good { background: var(--good-soft); color: var(--good); }
  .chip.warning { background: var(--warning-soft); color: var(--warning); }
  .chip.critical { background: var(--critical-soft); color: var(--critical); }
  .chip.neutral { background: var(--surface-2); color: var(--ink-muted); }
  .tile-main { display: flex; align-items: baseline; gap: 8px; }
  .tile-main .num { font-family: "Big Shoulders Display", sans-serif; font-weight: 700; font-size: 34px; line-height: 1; }
  .tile-main .unit { font-size: 12.5px; color: var(--ink-muted); }
  .tile-rows { display: flex; flex-direction: column; gap: 5px; margin-top: 2px; }
  .tile-row { display: flex; align-items: center; justify-content: space-between; font-size: 12.5px; gap: 10px; }
  .tile-row .k { color: var(--ink-muted); }
  .tile-row .v { font-weight: 600; }
  .tile-row .v.mono { font-size: 12.5px; }
  .tile-foot { font-size: 11.5px; color: var(--ink-faint); margin-top: auto; padding-top: 4px; }

  /* ---------- detail panels ---------- */
  .panels { display: grid; grid-template-columns: 1fr 1.3fr; gap: 14px; align-items: start; }
  @media (max-width: 760px) { .panels { grid-template-columns: 1fr; } }
  .panel { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); padding: 18px 20px 20px; }
  .panel-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
  .panel-title { font-size: 12.5px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-muted); margin: 0; }
  .filter-group { display: inline-flex; gap: 3px; background: var(--surface-2); border-radius: 999px; padding: 3px; }
  .filter-group button {
    border: none; background: transparent; color: var(--ink-muted); cursor: pointer;
    padding: 4px 10px; border-radius: 999px; font-size: 11px; font-weight: 600;
  }
  .filter-group button.active { background: var(--accent); color: white; }
  .filter-group button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

  .balance-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-block: 11px; border-top: 1px solid var(--border); }
  .balance-row:first-of-type { border-top: none; }
  .balance-account { display: flex; flex-direction: column; gap: 2px; }
  .balance-account .ns { color: var(--ink-faint); }
  .balance-account .name { color: var(--ink); font-weight: 500; }
  .balance-amount { font-size: 15px; font-weight: 600; }
  .balance-amount.neg { color: var(--ink-muted); }

  .txns-scroll { max-height: 340px; overflow-y: auto; }
  table.txns { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  table.txns th { text-align: left; font-weight: 600; color: var(--ink-faint); text-transform: uppercase; font-size: 10.5px; letter-spacing: 0.05em; padding-bottom: 8px; border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--surface); }
  table.txns th.num, table.txns td.num { text-align: right; }
  table.txns td { padding-block: 9px; border-top: 1px solid var(--border); vertical-align: baseline; }
  table.txns tr:first-child td { border-top: none; }
  .evt-chip { display: inline-block; padding: 2px 7px; border-radius: 5px; background: var(--surface-2); border: 1px solid var(--border); font-size: 11px; }
  .txn-time { color: var(--ink-faint); }
  .empty-note { color: var(--ink-faint); font-size: 12.5px; padding-block: 10px; }

  .foot { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; color: var(--ink-faint); font-size: 11.5px; padding-top: 6px; }
</style>
</head>
<body>

<div class="wrap">

  <header class="masthead">
    <div class="wordmark-group">
      <h1 class="wordmark">Parity</h1>
      <span class="tagline">Live ledger operations</span>
    </div>
    <div class="status-cluster">
      <span class="updated" id="updated">syncing&hellip;</span>
      <span class="status-pill live good" id="status-pill">
        <span class="dot"></span>
        <span id="status-text">Loading</span>
      </span>
    </div>
  </header>

  <div class="toolbar">
    <div class="control-group" id="range-group" role="group" aria-label="Activity window">
      <button type="button" data-window="15">15m</button>
      <button type="button" data-window="60">1h</button>
      <button type="button" data-window="360">6h</button>
      <button type="button" data-window="1440">24h</button>
    </div>
    <div class="toolbar-right">
      <button type="button" class="icon-btn" id="pause-btn" title="Pause auto-refresh" aria-pressed="false">
        <svg id="pause-icon" width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="3" y="2" width="3" height="10" rx="1" fill="currentColor"/><rect x="8" y="2" width="3" height="10" rx="1" fill="currentColor"/></svg>
        <svg id="play-icon" width="14" height="14" viewBox="0 0 14 14" fill="none" style="display:none"><path d="M4 2.5v9l8-4.5-8-4.5z" fill="currentColor"/></svg>
      </button>
      <button type="button" class="icon-btn" id="refresh-btn" title="Refresh now">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M12.5 7A5.5 5.5 0 1 1 10.6 2.9M12.5 2.5v3h-3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <button type="button" class="icon-btn" id="theme-btn" title="Toggle theme">
        <svg id="theme-icon-light" width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="3" fill="currentColor"/><path d="M7 0.5v2M7 11.5v2M13.5 7h-2M2.5 7h-2M11.5 2.5l-1.4 1.4M3.9 10.1l-1.4 1.4M11.5 11.5l-1.4-1.4M3.9 3.9L2.5 2.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
        <svg id="theme-icon-dark" width="14" height="14" viewBox="0 0 14 14" fill="none" style="display:none"><path d="M12 8.5A5.5 5.5 0 0 1 5.5 2 5.5 5.5 0 1 0 12 8.5z" fill="currentColor"/></svg>
      </button>
    </div>
  </div>

  <div class="alerts" id="alerts"></div>

  <section class="hero">
    <div>
      <p class="hero-label">Ledger integrity &mdash; sum across every account</p>
      <div class="hero-figure-row">
        <p class="hero-figure good mono" id="hero-drift">&mdash;</p>
        <div class="hero-spark">
          <svg id="hero-sparkline" width="120" height="32" viewBox="0 0 120 32"></svg>
          <p class="hero-spark-caption">trend this session</p>
        </div>
      </div>
      <p class="hero-sub">Every entry is written in offsetting pairs and enforced balanced at the moment it's recorded. This number is not a hope &mdash; it's a live query. It must always read exactly $0.00.</p>
    </div>
    <div class="hero-side">
      <div class="hero-side-row">
        <div>
          <span class="k">Transactions</span>
          <span class="v mono" id="hero-txns">&mdash;</span>
        </div>
        <div>
          <span class="k">Events processed</span>
          <span class="v mono" id="hero-events">&mdash;</span>
        </div>
      </div>
    </div>
  </section>

  <section class="grid" id="tile-grid" aria-label="System overview"></section>

  <section class="panels">
    <div class="panel">
      <p class="panel-title">Account balances</p>
      <div id="balances"><div class="empty-note">Loading&hellip;</div></div>
    </div>
    <div class="panel">
      <div class="panel-head">
        <p class="panel-title">Recent transactions</p>
        <div class="filter-group" id="txn-filter" role="group" aria-label="Filter transactions">
          <button type="button" data-filter="all" class="active">All</button>
          <button type="button" data-filter="charge.succeeded">Payments</button>
          <button type="button" data-filter="charge.refunded">Refunds</button>
          <button type="button" data-filter="charge.dispute.created">Disputes</button>
        </div>
      </div>
      <div id="txns-wrap"><div class="empty-note">Loading&hellip;</div></div>
    </div>
  </section>

  <footer class="foot">
    <span>Updated automatically &middot; read-only, nothing on this page can change your data.</span>
    <span id="window-note" class="mono"></span>
  </footer>

</div>

<script>
(function () {
  "use strict";

  var state = {
    windowMinutes: 15,
    paused: false,
    pollTimer: null,
    driftHistory: [],
    lastData: null,
    txnFilter: "all"
  };
  var POLL_MS = 20000;
  var lastUpdatedAt = null;
  var consecutiveFailures = 0;

  function money(cents, opts) {
    opts = opts || {};
    var sign = cents < 0 ? "-" : (opts.forceSign ? "+" : "");
    var abs = Math.abs(cents) / 100;
    var s = abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return sign + "$" + s;
  }

  function humanBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / (1024 * 1024)).toFixed(1) + " MB";
  }

  function relTime(iso) {
    var t = new Date(iso.replace(" ", "T") + (iso.indexOf("Z") === -1 && iso.indexOf("+") === -1 ? "Z" : ""));
    var diff = Math.max(0, (Date.now() - t.getTime()) / 1000);
    if (diff < 5) return "just now";
    if (diff < 60) return Math.floor(diff) + "s ago";
    if (diff < 3600) return Math.floor(diff / 60) + "m ago";
    if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
    return Math.floor(diff / 86400) + "d ago";
  }

  function windowLabel(min) {
    if (min < 60) return min + " minutes";
    if (min < 1440) return (min / 60) + (min === 60 ? " hour" : " hours");
    return (min / 1440) + " day" + (min > 1440 ? "s" : "");
  }

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  function chip(level, text) {
    return '<span class="chip ' + level + '">' + text + "</span>";
  }

  /* ---------- theme ---------- */
  function applyTheme(mode) {
    if (mode === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", mode);
    document.getElementById("theme-icon-light").style.display = mode === "dark" ? "none" : "block";
    document.getElementById("theme-icon-dark").style.display = mode === "dark" ? "block" : "none";
    try { localStorage.setItem("parity-theme", mode); } catch (e) {}
  }
  function initTheme() {
    var saved = "system";
    try { saved = localStorage.getItem("parity-theme") || "system"; } catch (e) {}
    applyTheme(saved);
    document.getElementById("theme-btn").addEventListener("click", function () {
      var current = document.documentElement.getAttribute("data-theme") || "system";
      var next = current === "system" ? "light" : current === "light" ? "dark" : "system";
      applyTheme(next);
    });
  }

  /* ---------- sparkline ---------- */
  function renderSparkline(values) {
    var svg = document.getElementById("hero-sparkline");
    var w = 120, h = 32, pad = 3;
    if (values.length < 2) { svg.innerHTML = ""; return; }
    var min = Math.min.apply(null, values), max = Math.max.apply(null, values);
    var range = max - min || 1;
    var step = (w - pad * 2) / (values.length - 1);
    var pts = values.map(function (v, i) {
      var x = pad + i * step;
      var y = pad + (h - pad * 2) * (1 - (v - min) / range);
      return x.toFixed(1) + "," + y.toFixed(1);
    });
    var last = pts[pts.length - 1].split(",");
    var color = values[values.length - 1] === 0 ? "var(--good)" : "var(--critical)";
    svg.innerHTML =
      '<polyline points="' + pts.join(" ") + '" fill="none" stroke="' + color + '" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<circle cx="' + last[0] + '" cy="' + last[1] + '" r="2.2" fill="' + color + '"/>';
  }

  /* ---------- health + alerts ---------- */
  function computeHealth(d) {
    var issues = [];
    if (d.ledger.globalDriftCents !== 0) {
      issues.push({ level: "critical", text: "Ledger is out of balance by " + money(d.ledger.globalDriftCents, { forceSign: true }) + " — account totals don't cancel to zero. This should never happen; investigate immediately.", target: null });
    }
    if (d.dlq.visible > 0) {
      issues.push({ level: "critical", text: d.dlq.visible + " event" + (d.dlq.visible === 1 ? "" : "s") + " couldn't be processed after repeated attempts and " + (d.dlq.visible === 1 ? "is" : "are") + " parked, not lost.", target: "tile-queue" });
    }
    if (d.projector.failed > 0) {
      issues.push({ level: "warning", text: d.projector.failed + " processing failure" + (d.projector.failed === 1 ? "" : "s") + " in the last " + windowLabel(d.windowMinutes) + ".", target: "tile-processing" });
    }
    if (d.ingress.errors > 0) {
      issues.push({ level: "warning", text: d.ingress.errors + " intake error" + (d.ingress.errors === 1 ? "" : "s") + " in the last " + windowLabel(d.windowMinutes) + ".", target: "tile-ingress" });
    }
    if (d.cluster.status !== "available") {
      issues.push({ level: "warning", text: "Ledger database status is \\u201c" + d.cluster.status + "\\u201d, not fully available.", target: "tile-ledger" });
    }
    if (!d.cluster.httpEndpointEnabled) {
      issues.push({ level: "critical", text: "The ledger database is unreachable.", target: "tile-ledger" });
    }
    var level = "good";
    if (issues.some(function (i) { return i.level === "critical"; })) level = "critical";
    else if (issues.length) level = "warning";
    return { level: level, issues: issues };
  }

  function renderAlerts(health) {
    var box = document.getElementById("alerts");
    box.innerHTML = "";
    if (!health.issues.length) { box.classList.remove("show"); return; }
    box.classList.add("show");
    health.issues.forEach(function (issue) {
      var a = el("button", "alert " + issue.level);
      a.type = "button";
      a.innerHTML = '<span class="alert-icon">' + (issue.level === "critical" ? "&#9888;" : "&#9679;") + "</span><span>" + issue.text + "</span>";
      if (issue.target) {
        a.addEventListener("click", function () {
          var t = document.getElementById(issue.target);
          if (!t) return;
          t.scrollIntoView({ behavior: "smooth", block: "center" });
          t.classList.add("highlight");
          setTimeout(function () { t.classList.remove("highlight"); }, 1800);
        });
      } else {
        a.style.cursor = "default";
      }
      box.appendChild(a);
    });
  }

  function renderStatusPill(health) {
    var pill = document.getElementById("status-pill");
    var text = document.getElementById("status-text");
    pill.className = "status-pill live " + health.level;
    text.textContent = health.level === "good" ? "All systems nominal" : health.level === "warning" ? "Needs attention" : "Action required";
  }

  /* ---------- tiles ---------- */
  function tile(id, title, chipHtml, mainNum, unit, rows, foot) {
    var t = el("div", "tile");
    t.id = id;
    var head = el("div", "tile-head");
    head.innerHTML = '<p class="tile-title">' + title + "</p>" + chipHtml;
    t.appendChild(head);
    if (mainNum !== null) {
      var main = el("div", "tile-main mono");
      main.innerHTML = '<span class="num">' + mainNum + "</span>" + (unit ? '<span class="unit">' + unit + "</span>" : "");
      t.appendChild(main);
    }
    if (rows && rows.length) {
      var rowsBox = el("div", "tile-rows");
      rows.forEach(function (r) {
        var row = el("div", "tile-row");
        row.innerHTML = '<span class="k">' + r[0] + '</span><span class="v mono">' + r[1] + "</span>";
        rowsBox.appendChild(row);
      });
      t.appendChild(rowsBox);
    }
    if (foot) t.appendChild(el("div", "tile-foot", foot));
    return t;
  }

  function renderTiles(d) {
    var grid = document.getElementById("tile-grid");
    grid.innerHTML = "";
    var win = windowLabel(d.windowMinutes);

    grid.appendChild(tile(
      "tile-ingress", "Ingress", chip(d.ingress.errors > 0 ? "warning" : "good", d.ingress.errors > 0 ? d.ingress.errors + " err" : "ok"),
      String(d.ingress.received), "received / " + win,
      [["duplicates blocked", String(d.ingress.duplicate)], ["invalid signatures", String(d.ingress.rejectedSignature)], ["live-mode blocked", String(d.ingress.rejectedLivemode)]]
    ));

    var dlqLevel = d.dlq.visible > 0 ? "critical" : "good";
    grid.appendChild(tile(
      "tile-queue", "Event queue", chip(dlqLevel, d.dlq.visible > 0 ? d.dlq.visible + " stuck" : "clear"),
      String(d.queue.visible + d.queue.inFlight), "in progress",
      [["waiting", String(d.queue.visible)], ["processing", String(d.queue.inFlight)], ["couldn't process", String(d.dlq.visible)]]
    ));

    grid.appendChild(tile(
      "tile-processing", "Processing", chip(d.projector.failed > 0 ? "critical" : "good", d.projector.failed > 0 ? d.projector.failed + " failed" : "ok"),
      String(d.projector.projected), "posted / " + win,
      [["already recorded", String(d.projector.alreadyProcessed)], ["no ledger impact", String(d.projector.noEntries)], ["failed", String(d.projector.failed)]]
    ));

    grid.appendChild(tile(
      "tile-dedupe", "Duplicate protection", chip("neutral", "~ approx"),
      String(d.dedupe.approxItemCount), "events tracked",
      [["tracking table size", humanBytes(d.dedupe.approxSizeBytes)]],
      "Count updates periodically, not instantly"
    ));

    var clusterLevel = !d.cluster.httpEndpointEnabled ? "critical" : d.cluster.status === "available" ? "good" : "warning";
    grid.appendChild(tile(
      "tile-ledger", "Ledger database", chip(clusterLevel, d.cluster.status),
      null, null,
      [["balanced", d.ledger.globalDriftCents === 0 ? "yes" : "no"], ["transactions recorded", d.ledger.totalTransactions.toLocaleString("en-US")]]
    ));

    grid.appendChild(tile(
      "tile-archive", "Event archive", chip("neutral", "complete"),
      String(d.archive.objectCount), "batches stored",
      [["total size", humanBytes(d.archive.totalBytes)]],
      "The full ledger can be rebuilt from this at any time"
    ));
  }

  function renderBalances(d) {
    var box = document.getElementById("balances");
    box.innerHTML = "";
    if (!d.ledger.balances.length) { box.appendChild(el("div", "empty-note", "No activity yet.")); return; }
    d.ledger.balances.forEach(function (b) {
      var parts = b.account.split(":");
      var row = el("div", "balance-row");
      var acct = el("div", "balance-account mono");
      acct.innerHTML = '<span><span class="ns">' + parts[0] + ':</span><span class="name">' + (parts[1] || "") + "</span></span>";
      var amt = el("div", "balance-amount mono" + (b.cents < 0 ? " neg" : ""), money(b.cents, { forceSign: true }));
      row.appendChild(acct); row.appendChild(amt);
      box.appendChild(row);
    });
  }

  function renderTxns(d) {
    var box = document.getElementById("txns-wrap");
    box.innerHTML = "";
    var rows = d.ledger.recentTransactions;
    if (state.txnFilter !== "all") rows = rows.filter(function (t) { return t.eventType === state.txnFilter; });
    if (!rows.length) { box.appendChild(el("div", "empty-note", state.txnFilter === "all" ? "No activity yet." : "Nothing matches this filter yet.")); return; }
    var scroller = el("div", "txns-scroll");
    var table = el("table", "txns");
    var thead = el("thead", "", "<tr><th>Event</th><th>When</th><th class=\\"num\\">Amount</th></tr>");
    var tbody = el("tbody");
    rows.forEach(function (t) {
      var tr = el("tr");
      tr.innerHTML =
        '<td><span class="evt-chip mono">' + t.eventType + '</span></td>' +
        '<td class="txn-time mono" title="' + t.createdAt + '">' + relTime(t.createdAt) + '</td>' +
        '<td class="num mono">' + money(t.magnitudeCents) + "</td>";
      tbody.appendChild(tr);
    });
    table.appendChild(thead); table.appendChild(tbody);
    scroller.appendChild(table);
    box.appendChild(scroller);
  }

  function initTxnFilter() {
    var group = document.getElementById("txn-filter");
    group.addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-filter]");
      if (!btn) return;
      state.txnFilter = btn.getAttribute("data-filter");
      Array.prototype.forEach.call(group.querySelectorAll("button"), function (b) { b.classList.toggle("active", b === btn); });
      if (state.lastData) renderTxns(state.lastData);
    });
  }

  /* ---------- render + poll ---------- */
  function render(d) {
    state.lastData = d;
    lastUpdatedAt = d.updatedAt;

    state.driftHistory.push(d.ledger.globalDriftCents);
    if (state.driftHistory.length > 40) state.driftHistory.shift();
    renderSparkline(state.driftHistory);

    var health = computeHealth(d);
    renderStatusPill(health);
    renderAlerts(health);

    var driftEl = document.getElementById("hero-drift");
    driftEl.textContent = money(d.ledger.globalDriftCents, { forceSign: true });
    driftEl.className = "hero-figure mono " + (d.ledger.globalDriftCents === 0 ? "good" : "critical");

    document.getElementById("hero-txns").textContent = d.ledger.totalTransactions.toLocaleString("en-US");
    document.getElementById("hero-events").textContent = d.ledger.totalProcessedEvents.toLocaleString("en-US");

    renderTiles(d);
    renderBalances(d);
    renderTxns(d);

    document.getElementById("window-note").textContent = "showing last " + windowLabel(d.windowMinutes);
    tickUpdated();
  }

  function tickUpdated() {
    var elU = document.getElementById("updated");
    if (!lastUpdatedAt) { elU.textContent = "syncing\\u2026"; return; }
    elU.innerHTML = "updated <strong>" + relTime(lastUpdatedAt) + "</strong>";
  }
  setInterval(tickUpdated, 1000);

  function fetchSnapshot(opts) {
    opts = opts || {};
    var btn = document.getElementById("refresh-btn");
    if (opts.manual) btn.classList.add("spinning");
    var url = "/api/snapshot?window=" + state.windowMinutes + "&limit=50";
    fetch(url, { cache: "no-store" })
      .then(function (res) { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
      .then(function (data) {
        consecutiveFailures = 0;
        render(data);
      })
      .catch(function () {
        consecutiveFailures++;
        if (consecutiveFailures >= 2) {
          var pill = document.getElementById("status-pill");
          var text = document.getElementById("status-text");
          pill.className = "status-pill live warning";
          text.textContent = "Connection trouble";
        }
      })
      .finally(function () {
        if (opts.manual) setTimeout(function () { btn.classList.remove("spinning"); }, 400);
      });
  }

  function schedulePoll() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    if (state.paused) return;
    state.pollTimer = setInterval(fetchSnapshot, POLL_MS);
  }

  function initControls() {
    var rangeGroup = document.getElementById("range-group");
    Array.prototype.forEach.call(rangeGroup.querySelectorAll("button"), function (b) {
      if (Number(b.getAttribute("data-window")) === state.windowMinutes) b.classList.add("active");
      b.addEventListener("click", function () {
        state.windowMinutes = Number(b.getAttribute("data-window"));
        Array.prototype.forEach.call(rangeGroup.querySelectorAll("button"), function (x) { x.classList.toggle("active", x === b); });
        fetchSnapshot();
      });
    });

    document.getElementById("refresh-btn").addEventListener("click", function () { fetchSnapshot({ manual: true }); });

    var pauseBtn = document.getElementById("pause-btn");
    pauseBtn.addEventListener("click", function () {
      state.paused = !state.paused;
      pauseBtn.setAttribute("aria-pressed", String(state.paused));
      pauseBtn.title = state.paused ? "Resume auto-refresh" : "Pause auto-refresh";
      document.getElementById("pause-icon").style.display = state.paused ? "none" : "block";
      document.getElementById("play-icon").style.display = state.paused ? "block" : "none";
      schedulePoll();
    });
  }

  initTheme();
  initControls();
  initTxnFilter();
  fetchSnapshot();
  schedulePoll();
})();
</script>
</body>
</html>
`;
