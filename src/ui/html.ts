/** Admin page shell. All data is filled in by app.js via textContent (never innerHTML). */
const lamp = (id: string, name: string) => String.raw`
    <div class="lamp" id="lamp-${id}" data-state="off" role="status" aria-live="polite">
      <svg viewBox="0 0 34 34" aria-hidden="true"><circle class="lens" cx="17" cy="17" r="14"/><circle class="rim" cx="17" cy="17" r="14"/><ellipse class="glint" cx="12.5" cy="11.5" rx="4.5" ry="3"/></svg>
      <div class="name">${name}</div>
      <div class="state">Loading…</div>
    </div>`;

export const ADMIN_HTML = String.raw`<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Wix → Mintsoft · Integration control</title>
<link rel="stylesheet" href="/admin/app.css">
<script src="/admin/app.js" defer></script>
</head>
<body>
<!--
THESIS: The integration as a despatch bay's andon: every flow is a lamp, green running, amber paused, red needs a person. Refuses the stat-card dashboard.
OWN-WORLD: cool painted-bay neutral ground (#f4f5f7), white panels on 1px rules, ink #14171a; andon green #1e9e4a / amber #f2a900 / red #d62d20, red reserved for "needs a person"; system sans, mono only for order numbers, SKUs, IDs; lamp discs with rim and glint.
STORY: Glance at the lamps to know whether writes are live and anything needs attention; preview before any write; act on held orders and errors in place.
FIRST VIEWPORT: header with name, target client and warehouse fields; full-width lamp strip (Order import, Despatch to Wix, Mintsoft writes with its switch, Needs attention); tabs; Overview below.
FORM: Despatch Bay Status Board, pick card (assigned was list #5), seed 57672840.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
-->
<header class="top">
  <h1>Wix → Mintsoft</h1>
  <div class="target" id="target" aria-label="Write target"></div>
  <div class="who" id="who"></div>
</header>

<div class="bay" id="bay" hidden>
${lamp("import", "Order import")}
${lamp("despatch", "Despatch → Wix")}
    <div class="lamp switch" id="lamp-writes" data-state="off" role="status" aria-live="polite">
      <svg viewBox="0 0 34 34" aria-hidden="true"><circle class="lens" cx="17" cy="17" r="14"/><circle class="rim" cx="17" cy="17" r="14"/><ellipse class="glint" cx="12.5" cy="11.5" rx="4.5" ry="3"/></svg>
      <div class="name">Mintsoft writes</div>
      <div class="state">Loading…</div>
      <div class="act"></div>
    </div>
${lamp("attention", "Needs attention")}
</div>

<nav class="tabs" id="tabs" role="tablist" aria-label="Sections" hidden>
  <button role="tab" id="tab-overview" aria-controls="view-overview" aria-selected="true" data-tab="overview">Overview</button>
  <button role="tab" id="tab-orders" aria-controls="view-orders" aria-selected="false" data-tab="orders">Orders <span class="count" id="count-held" hidden></span></button>
  <button role="tab" id="tab-products" aria-controls="view-products" aria-selected="false" data-tab="products">Products</button>
  <button role="tab" id="tab-errors" aria-controls="view-errors" aria-selected="false" data-tab="errors">Errors <span class="count" id="count-errors" hidden></span></button>
  <button role="tab" id="tab-settings" aria-controls="view-settings" aria-selected="false" data-tab="settings">Settings</button>
</nav>

<main id="main">
  <div id="view-signin" hidden></div>
  <div role="tabpanel" id="view-overview" aria-labelledby="tab-overview" hidden></div>
  <div role="tabpanel" id="view-orders" aria-labelledby="tab-orders" hidden></div>
  <div role="tabpanel" id="view-products" aria-labelledby="tab-products" hidden></div>
  <div role="tabpanel" id="view-errors" aria-labelledby="tab-errors" hidden></div>
  <div role="tabpanel" id="view-settings" aria-labelledby="tab-settings" hidden></div>
</main>

<dialog id="confirm" aria-labelledby="confirm-title">
  <form method="dialog">
    <header><h2 id="confirm-title"></h2></header>
    <div class="content" id="confirm-body"></div>
    <footer>
      <button class="btn" value="cancel" id="confirm-cancel">Cancel</button>
      <button class="btn write" value="ok" id="confirm-ok"></button>
    </footer>
  </form>
</dialog>
<div id="toast" role="status" aria-live="polite"></div>
</body>
</html>
`;
