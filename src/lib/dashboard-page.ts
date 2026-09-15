/**
 * The public dashboard's HTML shell. Same visual design as the earlier
 * Claude Artifact prototype, with one real difference: this page fetches
 * its own data client-side from /api/snapshot (same Lambda Function URL,
 * same origin — no CORS needed) on a timer, rather than depending on a
 * Claude session to push data into it. It's genuinely always live.
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
    --gold: #8F6510;
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
      --bg: #0E1116;
      --surface: #161B22;
      --surface-2: #1B212A;
      --ink: #E8EBEF;
      --ink-muted: #8B94A3;
      --ink-faint: #5C6572;
      --border: #262D38;
      --accent: #35C4BE;
      --accent-ink: #8FE6E1;
      --accent-soft: #123634;
      --gold: #D9A43F;
      --good: #34C481;
      --good-soft: #12301F;
      --warning: #E3A93C;
      --warning-soft: #332811;
      --critical: #F0594B;
      --critical-soft: #331714;
      --shadow: 0 1px 2px rgba(0, 0, 0, 0.3), 0 8px 28px -12px rgba(0, 0, 0, 0.55);
      color-scheme: dark;
    }
  }
  :root[data-theme="dark"] {
    --bg: #0E1116;
    --surface: #161B22;
    --surface-2: #1B212A;
    --ink: #E8EBEF;
    --ink-muted: #8B94A3;
    --ink-faint: #5C6572;
    --border: #262D38;
    --accent: #35C4BE;
    --accent-ink: #8FE6E1;
    --accent-soft: #123634;
    --gold: #D9A43F;
    --good: #34C481;
    --good-soft: #12301F;
    --warning: #E3A93C;
    --warning-soft: #332811;
    --critical: #F0594B;
    --critical-soft: #331714;
    --shadow: 0 1px 2px rgba(0, 0, 0, 0.3), 0 8px 28px -12px rgba(0, 0, 0, 0.55);
    color-scheme: dark;
  }

  * { box-sizing: border-box; }
  html { text-size-adjust: 100%; }

  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font-family: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
    padding-inline: 20px;
    padding-block: 28px 60px;
  }

  .wrap { max-width: 1180px; margin-inline: auto; display: flex; flex-direction: column; gap: 22px; }

  .mono { font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace; font-variant-numeric: tabular-nums; }

  a { color: var(--accent-ink); }

  .masthead {
    display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap;
    padding-block: 4px 6px;
    border-bottom: 2px solid var(--ink);
  }
  .wordmark-group { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
  .wordmark {
    font-family: "Big Shoulders Display", sans-serif;
    font-weight: 800;
    font-size: clamp(34px, 6vw, 48px);
    letter-spacing: 0.01em;
    line-height: 1;
    margin: 0;
    text-transform: uppercase;
    color: var(--accent-ink);
  }
  .tagline {
    color: var(--ink-muted);
    font-size: 13px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-weight: 500;
    display: inline-flex;
    align-items: center;
    gap: 7px;
  }
  .tagline::before {
    content: "";
    width: 6px; height: 6px; border-radius: 50%;
    background: var(--accent);
    flex: none;
  }
  .status-cluster { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  .status-pill {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 7px 13px 7px 10px;
    border-radius: 999px;
    font-size: 13px; font-weight: 600;
    border: 1px solid transparent;
  }
  .status-pill .dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: currentColor;
    box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 22%, transparent);
  }
  .status-pill.good { background: var(--good-soft); color: var(--good); }
  .status-pill.warning { background: var(--warning-soft); color: var(--warning); }
  .status-pill.critical { background: var(--critical-soft); color: var(--critical); }
  .status-pill.live .dot { animation: pulse 2.2s ease-in-out infinite; }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }
  @media (prefers-reduced-motion: reduce) {
    .status-pill.live .dot { animation: none; }
  }
  .updated { font-size: 12.5px; color: var(--ink-faint); }
  .updated strong { color: var(--ink-muted); font-weight: 600; }

  .alerts { display: none; flex-direction: column; gap: 8px; }
  .alerts.show { display: flex; }
  .alert {
    display: flex; align-items: flex-start; gap: 10px;
    padding: 11px 14px;
    border-radius: var(--radius);
    border: 1px solid transparent;
    font-size: 13.5px; line-height: 1.5;
  }
  .alert.critical { background: var(--critical-soft); color: var(--critical); border-color: color-mix(in srgb, var(--critical) 30%, transparent); }
  .alert.warning { background: var(--warning-soft); color: var(--warning); border-color: color-mix(in srgb, var(--warning) 30%, transparent); }
  .alert-icon { flex: none; margin-top: 1px; }

  .hero {
    background: var(--surface);
    border: 1px solid var(--border);
    border-top: 3px solid var(--accent);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    padding: 26px 28px;
    display: flex; align-items: center; justify-content: space-between; gap: 24px; flex-wrap: wrap;
    position: relative; overflow: hidden;
  }
  .hero::before {
    content: ""; position: absolute; inset: 0;
    background-image: repeating-linear-gradient(
      to bottom, transparent, transparent 27px, color-mix(in srgb, var(--border) 65%, transparent) 28px
    );
    -webkit-mask-image: linear-gradient(to right, black, transparent 70%);
            mask-image: linear-gradient(to right, black, transparent 70%);
    opacity: 0.6;
    pointer-events: none;
  }
  .hero-label {
    font-size: 12.5px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-muted);
    margin: 0 0 6px;
    position: relative;
  }
  .hero-figure {
    font-family: "Big Shoulders Display", sans-serif;
    font-weight: 700;
    font-size: clamp(40px, 7vw, 64px);
    line-height: 1;
    margin: 0;
    position: relative;
    font-variant-numeric: tabular-nums;
  }
  .hero-figure.good { color: var(--good); }
  .hero-figure.critical { color: var(--critical); }
  .hero-sub { color: var(--ink-muted); font-size: 13.5px; max-width: 46ch; margin-top: 8px; position: relative; text-wrap: balance; }
  .hero-side { text-align: right; position: relative; }
  .hero-side .k { display: block; font-size: 12px; color: var(--ink-faint); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 3px; }
  .hero-side .v { display: block; font-size: 20px; font-weight: 600; }
  .hero-side-row { display: flex; gap: 28px; }

  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 14px; }
  .tile {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    padding: 16px 18px 18px;
    display: flex; flex-direction: column; gap: 10px;
    animation: rise 0.5s ease both;
  }
  .tile:nth-child(1) { animation-delay: 0.02s; }
  .tile:nth-child(2) { animation-delay: 0.06s; }
  .tile:nth-child(3) { animation-delay: 0.10s; }
  .tile:nth-child(4) { animation-delay: 0.14s; }
  .tile:nth-child(5) { animation-delay: 0.18s; }
  .tile:nth-child(6) { animation-delay: 0.22s; }
  @keyframes rise {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @media (prefers-reduced-motion: reduce) {
    .tile { animation: none; }
  }
  .tile-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .tile-title { font-size: 13px; font-weight: 600; letter-spacing: 0.02em; margin: 0; }
  .chip {
    font-size: 11px; font-weight: 600; letter-spacing: 0.03em; text-transform: uppercase;
    padding: 3px 8px; border-radius: 999px;
  }
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

  .panels { display: grid; grid-template-columns: 1fr 1.3fr; gap: 14px; align-items: start; }
  @media (max-width: 760px) { .panels { grid-template-columns: 1fr; } }

  .panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    padding: 18px 20px 20px;
  }
  .panel-title {
    font-size: 12.5px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-muted);
    margin: 0 0 14px;
  }

  .balance-row {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding-block: 11px;
    border-top: 1px solid var(--border);
  }
  .balance-row:first-of-type { border-top: none; }
  .balance-account { display: flex; flex-direction: column; gap: 2px; }
  .balance-account .ns { color: var(--ink-faint); }
  .balance-account .name { color: var(--ink); font-weight: 500; }
  .balance-amount { font-size: 15px; font-weight: 600; }
  .balance-amount.neg { color: var(--ink-muted); }

  table.txns { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  table.txns th {
    text-align: left; font-weight: 600; color: var(--ink-faint);
    text-transform: uppercase; font-size: 10.5px; letter-spacing: 0.05em;
    padding-bottom: 8px; border-bottom: 1px solid var(--border);
  }
  table.txns th.num, table.txns td.num { text-align: right; }
  table.txns td { padding-block: 9px; border-top: 1px solid var(--border); vertical-align: baseline; }
  table.txns tr:first-child td { border-top: none; }
  .evt-chip {
    display: inline-block; padding: 2px 7px; border-radius: 5px;
    background: var(--surface-2); border: 1px solid var(--border);
    font-size: 11px;
  }
  .txn-time { color: var(--ink-faint); }
  .empty-note { color: var(--ink-faint); font-size: 12.5px; padding-block: 10px; }

  .foot {
    display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap;
    color: var(--ink-faint); font-size: 11.5px; padding-top: 6px;
  }
  .foot a { color: var(--ink-muted); }
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

  <div class="alerts" id="alerts"></div>

  <section class="hero">
    <div>
      <p class="hero-label">Ledger integrity &mdash; sum across every account</p>
      <p class="hero-figure good mono" id="hero-drift">&mdash;</p>
      <p class="hero-sub">Every entry is written in offsetting pairs and enforced balanced by a database constraint at commit. This number is not a hope &mdash; it is a query. It must always read exactly $0.00.</p>
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

  <section class="grid" id="tile-grid" aria-label="Pipeline stages"></section>

  <section class="panels">
    <div class="panel">
      <p class="panel-title">Account balances</p>
      <div id="balances"><div class="empty-note">Loading&hellip;</div></div>
    </div>
    <div class="panel">
      <p class="panel-title">Recent transactions</p>
      <div id="txns-wrap"><div class="empty-note">Loading&hellip;</div></div>
    </div>
  </section>

  <footer class="foot">
    <span>Live from <span class="mono">/api/snapshot</span> &middot; polls every 20s &middot; read-only, no AWS credentials in this page.</span>
    <span id="window-note" class="mono"></span>
  </footer>

</div>

<script>
(function () {
  "use strict";

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

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  function chip(level, text) {
    return '<span class="chip ' + level + '">' + text + "</span>";
  }

  function computeHealth(d) {
    var issues = [];
    if (d.ledger.globalDriftCents !== 0) {
      issues.push({ level: "critical", text: "Ledger drift is " + money(d.ledger.globalDriftCents, { forceSign: true }) + " — account sums do not cancel to zero. This should be structurally impossible; investigate immediately." });
    }
    if (d.dlq.visible > 0) {
      issues.push({ level: "critical", text: d.dlq.visible + " message" + (d.dlq.visible === 1 ? "" : "s") + " stuck in the dead-letter queue — a payment event failed projection three times and is parked, not lost, but not landed either." });
    }
    if (d.projector.failed > 0) {
      issues.push({ level: "warning", text: d.projector.failed + " projector failure" + (d.projector.failed === 1 ? "" : "s") + " in the last " + d.windowMinutes + " minutes." });
    }
    if (d.ingress.errors > 0) {
      issues.push({ level: "warning", text: d.ingress.errors + " ingress error" + (d.ingress.errors === 1 ? "" : "s") + " in the last " + d.windowMinutes + " minutes (claim or enqueue failures)." });
    }
    if (d.cluster.status !== "available") {
      issues.push({ level: "warning", text: "Ledger cluster status is \\u201c" + d.cluster.status + "\\u201d, not available." });
    }
    if (!d.cluster.httpEndpointEnabled) {
      issues.push({ level: "critical", text: "Data API (HTTP endpoint) is not enabled on the ledger cluster." });
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
      var a = el("div", "alert " + issue.level);
      a.innerHTML = '<span class="alert-icon">' + (issue.level === "critical" ? "&#9888;" : "&#9679;") + "</span><span>" + issue.text + "</span>";
      box.appendChild(a);
    });
  }

  function renderStatusPill(health) {
    var pill = document.getElementById("status-pill");
    var text = document.getElementById("status-text");
    pill.className = "status-pill live " + health.level;
    text.textContent = health.level === "good" ? "All systems nominal" : health.level === "warning" ? "Needs attention" : "Action required";
  }

  function tile(title, chipHtml, mainNum, unit, rows, foot) {
    var t = el("div", "tile");
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

    grid.appendChild(tile(
      "Ingress", chip(d.ingress.errors > 0 ? "warning" : "good", d.ingress.errors > 0 ? d.ingress.errors + " err" : "ok"),
      String(d.ingress.received), "received / " + d.windowMinutes + "m",
      [["duplicate (deduped)", String(d.ingress.duplicate)], ["forged signature", String(d.ingress.rejectedSignature)], ["livemode refused", String(d.ingress.rejectedLivemode)]]
    ));

    var dlqLevel = d.dlq.visible > 0 ? "critical" : "good";
    grid.appendChild(tile(
      "Event queue", chip(dlqLevel, d.dlq.visible > 0 ? d.dlq.visible + " in DLQ" : "clear"),
      String(d.queue.visible + d.queue.inFlight), "messages",
      [["visible", String(d.queue.visible)], ["in flight", String(d.queue.inFlight)], ["dead-letter", String(d.dlq.visible)]]
    ));

    grid.appendChild(tile(
      "Projector", chip(d.projector.failed > 0 ? "critical" : "good", d.projector.failed > 0 ? d.projector.failed + " failed" : "ok"),
      String(d.projector.projected), "projected / " + d.windowMinutes + "m",
      [["already processed", String(d.projector.alreadyProcessed)], ["booked nothing", String(d.projector.noEntries)], ["failed", String(d.projector.failed)]]
    ));

    grid.appendChild(tile(
      "Dedupe table", chip("neutral", "~ approx"),
      String(d.dedupe.approxItemCount), "claimed ids",
      [["table size", humanBytes(d.dedupe.approxSizeBytes)]],
      "DynamoDB refreshes this count a few times a day"
    ));

    var clusterLevel = !d.cluster.httpEndpointEnabled ? "critical" : d.cluster.status === "available" ? "good" : "warning";
    grid.appendChild(tile(
      "Ledger cluster", chip(clusterLevel, d.cluster.status),
      null, null,
      [["Data API", d.cluster.httpEndpointEnabled ? "enabled" : "disabled"], ["engine", "Aurora PostgreSQL"], ["reached via", "RDS Data API, no VPC"]]
    ));

    grid.appendChild(tile(
      "Event archive", chip("neutral", "S3"),
      String(d.archive.objectCount), "objects",
      [["total size", humanBytes(d.archive.totalBytes)]],
      "rebuild-from-archive replays these"
    ));
  }

  function renderBalances(d) {
    var box = document.getElementById("balances");
    box.innerHTML = "";
    if (!d.ledger.balances.length) {
      box.appendChild(el("div", "empty-note", "No entries yet."));
      return;
    }
    d.ledger.balances.forEach(function (b) {
      var parts = b.account.split(":");
      var row = el("div", "balance-row");
      var acct = el("div", "balance-account mono");
      acct.innerHTML = '<span><span class="ns">' + parts[0] + ':</span><span class="name">' + (parts[1] || "") + "</span></span>";
      var amt = el("div", "balance-amount mono" + (b.cents < 0 ? " neg" : ""), money(b.cents, { forceSign: true }));
      row.appendChild(acct);
      row.appendChild(amt);
      box.appendChild(row);
    });
  }

  function renderTxns(d) {
    var box = document.getElementById("txns-wrap");
    box.innerHTML = "";
    if (!d.ledger.recentTransactions.length) {
      box.appendChild(el("div", "empty-note", "No transactions yet."));
      return;
    }
    var wrap = el("div");
    wrap.style.overflowX = "auto";
    var table = el("table", "txns");
    var thead = el("thead", "", "<tr><th>Event</th><th>When</th><th class=\\"num\\">Amount</th></tr>");
    var tbody = el("tbody");
    d.ledger.recentTransactions.forEach(function (t) {
      var tr = el("tr");
      tr.innerHTML =
        '<td><span class="evt-chip mono">' + t.eventType + '</span></td>' +
        '<td class="txn-time mono" title="' + t.createdAt + '">' + relTime(t.createdAt) + '</td>' +
        '<td class="num mono">' + money(t.magnitudeCents) + "</td>";
      tbody.appendChild(tr);
    });
    table.appendChild(thead);
    table.appendChild(tbody);
    wrap.appendChild(table);
    box.appendChild(wrap);
  }

  function render(d) {
    lastUpdatedAt = d.updatedAt;
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

    document.getElementById("window-note").textContent = d.region + " \\u00b7 " + d.windowMinutes + "m activity window";
    tickUpdated();
  }

  function tickUpdated() {
    var elU = document.getElementById("updated");
    if (!lastUpdatedAt) { elU.textContent = "syncing\\u2026"; return; }
    elU.innerHTML = "updated <strong>" + relTime(lastUpdatedAt) + "</strong>";
  }
  setInterval(tickUpdated, 1000);

  function fetchSnapshot() {
    fetch("/api/snapshot", { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
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
          text.textContent = "Can't reach /api/snapshot";
        }
      });
  }

  fetchSnapshot();
  setInterval(fetchSnapshot, POLL_MS);
})();
</script>
</body>
</html>
`;
