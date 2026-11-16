/** Admin page stylesheet. Despatch Bay Status Board: cool neutral bay, andon lamps carry state. */
export const ADMIN_CSS = String.raw`
:root {
  --bay: #f4f5f7;          /* page ground: painted bay floor, cool neutral */
  --panel: #ffffff;
  --panel-2: #eef0f3;      /* toolbars, table heads */
  --rule: #d9dde3;
  --rule-strong: #b9c0c9;
  --ink: #14171a;
  --ink-2: #47525e;        /* secondary text, 7.4:1 on white */
  --ink-3: #5d6874;        /* tertiary, 5.6:1 on white */
  --go: #1e9e4a;           /* andon green: running */
  --go-ink: #146c33;
  --go-wash: #e6f4ea;
  --hold: #f2a900;         /* andon amber: paused / waiting */
  --hold-ink: #7a5500;
  --hold-wash: #fdf3d6;
  --stop: #d62d20;         /* andon red: a person is needed. Reserved. */
  --stop-ink: #a51f15;
  --stop-wash: #fbe7e5;
  --off: #c3c9d0;          /* unlit lamp */
  --focus: #1f4fd1;
  --radius: 6px;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  color-scheme: light;
  accent-color: var(--ink);
}

* { box-sizing: border-box; }
[hidden] { display: none !important; }
html { background: var(--bay); }
body {
  margin: 0;
  font: 15px/1.5 var(--sans);
  color: var(--ink);
  background: var(--bay);
  -webkit-font-smoothing: antialiased;
}
::selection { background: #cfdbfb; color: var(--ink); }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: 3px; }
* { scrollbar-color: var(--rule-strong) transparent; scrollbar-width: thin; }
a { color: var(--focus); text-underline-offset: 3px; }

.mono, code { font-family: var(--mono); font-size: 0.92em; }
.num { font-variant-numeric: tabular-nums; text-align: right; }
time { white-space: nowrap; }
.muted { color: var(--ink-2); }
.small { font-size: 13px; }

/* ── Header ─────────────────────────────────────────────── */
.top {
  display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
  padding: 14px 28px; background: var(--panel); border-bottom: 1px solid var(--rule);
}
.top h1 { font-size: 17px; margin: 0; font-weight: 650; letter-spacing: -0.01em; }
.top .who { margin-left: auto; color: var(--ink-2); font-size: 13px; }
.target {
  display: flex; gap: 6px; align-items: center; font-size: 13px; color: var(--ink-2);
}
.field {
  display: inline-flex; align-items: baseline; gap: 6px; padding: 2px 8px;
  border: 1px solid var(--rule-strong); border-radius: 4px; background: var(--panel);
}
.field b { font-family: var(--mono); color: var(--ink); font-weight: 600; }

/* ── Lamp strip: the signature ──────────────────────────── */
.bay {
  display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0;
  background: var(--panel); border-bottom: 1px solid var(--rule);
}
.lamp {
  display: grid; grid-template-columns: auto 1fr; grid-auto-rows: min-content; gap: 2px 14px;
  align-items: center; align-content: center;
  padding: 18px 28px; border-right: 1px solid var(--rule); min-height: 92px;
}
.lamp:last-child { border-right: 0; }
.lamp svg { grid-row: span 2; width: 34px; height: 34px; }
.lamp .lens { fill: var(--off); transition: fill 200ms cubic-bezier(.2,.7,.2,1); }
.lamp .rim { fill: none; stroke: #00000026; stroke-width: 2; }
.lamp .glint { fill: #ffffff; opacity: 0.55; }
.lamp[data-state="go"] .lens { fill: var(--go); }
.lamp[data-state="hold"] .lens { fill: var(--hold); }
.lamp[data-state="stop"] .lens { fill: var(--stop); }
.lamp[data-state="go"] svg, .lamp[data-state="hold"] svg, .lamp[data-state="stop"] svg {
  filter: drop-shadow(0 2px 4px rgba(0,0,0,.18));
}
.lamp .name { font-weight: 650; font-size: 14px; }
.lamp .state { font-size: 13px; color: var(--ink-2); }
.lamp[data-state="stop"] .state { color: var(--stop-ink); font-weight: 600; }
.lamp[data-state="hold"] .state { color: var(--hold-ink); }
.lamp[data-state="go"] .state { color: var(--go-ink); }
.lamp.switch { background: var(--panel); }
.lamp.switch .act { grid-column: 2; justify-self: start; margin-top: 6px; display: grid; gap: 4px; justify-items: start; }
.lamp.switch .act .meta { font-size: 12px; color: var(--ink-3); }

/* ── Tabs ───────────────────────────────────────────────── */
nav.tabs {
  display: flex; gap: 2px; padding: 0 20px; background: var(--panel);
  border-bottom: 1px solid var(--rule); overflow-x: auto;
}
nav.tabs button {
  appearance: none; border: 0; background: none; font: inherit; color: var(--ink-2);
  padding: 12px 14px 11px; border-bottom: 3px solid transparent; cursor: pointer;
  display: inline-flex; gap: 8px; align-items: center; white-space: nowrap;
}
nav.tabs button:hover { color: var(--ink); }
nav.tabs button[aria-selected="true"] { color: var(--ink); border-bottom-color: var(--ink); font-weight: 600; }
.count {
  font: 600 12px/1 var(--sans); padding: 3px 7px; border-radius: 999px;
  background: var(--panel-2); color: var(--ink-2); font-variant-numeric: tabular-nums;
}
.count.stop { background: var(--stop); color: #fff; }
.count.hold { background: var(--hold-wash); color: var(--hold-ink); }

/* ── Layout ─────────────────────────────────────────────── */
main { padding: 24px 28px 64px; max-width: 1400px; }
section.panel {
  background: var(--panel); border: 1px solid var(--rule); border-radius: var(--radius);
  margin-bottom: 20px;
}
section.panel > header {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding: 14px 18px; border-bottom: 1px solid var(--rule);
}
section.panel > header h2 { font-size: 15px; margin: 0; font-weight: 650; }
section.panel > header .spacer { flex: 1; }
section.panel > .body { padding: 16px 18px; }
section.panel > .body > p:first-child { margin-top: 0; }
.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 20px; }
.cols > section.panel { margin-bottom: 0; }
h3 { font-size: 14px; margin: 22px 0 8px; }
p { max-width: 75ch; }

/* ── Buttons ────────────────────────────────────────────── */
button.btn {
  appearance: none; font: 600 14px/1 var(--sans); padding: 9px 14px; border-radius: 5px;
  border: 1px solid var(--rule-strong); background: var(--panel); color: var(--ink); cursor: pointer;
  display: inline-flex; align-items: center; gap: 8px; min-height: 36px;
  transition: background 150ms ease-out, border-color 150ms ease-out;
}
button.btn:hover { background: var(--panel-2); border-color: var(--ink-3); }
button.btn:active { background: #e3e6ea; }
button.btn.primary { background: var(--ink); border-color: var(--ink); color: #fff; }
button.btn.primary:hover { background: #2a3036; }
button.btn.write { background: var(--go-ink); border-color: var(--go-ink); color: #fff; }
button.btn.write:hover { background: #0f5728; }
button.btn.pause { background: var(--hold-wash); border-color: var(--hold); color: var(--hold-ink); }
button.btn.small { padding: 6px 10px; min-height: 30px; font-size: 13px; }
button.btn[disabled] { opacity: 0.45; cursor: not-allowed; }
button.btn[aria-busy="true"] { cursor: progress; }
button.btn[aria-busy="true"]::after {
  content: ""; width: 12px; height: 12px; border-radius: 50%;
  border: 2px solid currentColor; border-right-color: transparent; animation: spin 700ms linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.why { font-size: 13px; color: var(--ink-2); }

/* ── Tables ─────────────────────────────────────────────── */
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--rule); vertical-align: top; }
th { background: var(--panel-2); font-weight: 600; font-size: 13px; color: var(--ink-2); white-space: nowrap; }
tbody tr:hover td { background: #f8f9fb; }
tr[data-row="stop"] td { background: var(--stop-wash); }
tr[data-row="hold"] td { background: #fffaf0; }
td.msg { max-width: 60ch; color: var(--ink-2); }
td.actions-cell { white-space: nowrap; text-align: right; }

/* Status chips: a small lamp + word, never colour alone */
.chip {
  display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; white-space: nowrap;
}
.chip::before { content: ""; width: 9px; height: 9px; border-radius: 50%; background: var(--off); box-shadow: inset 0 0 0 1px #0000001f; }
.chip.go { color: var(--go-ink); } .chip.go::before { background: var(--go); }
.chip.hold { color: var(--hold-ink); } .chip.hold::before { background: var(--hold); }
.chip.stop { color: var(--stop-ink); } .chip.stop::before { background: var(--stop); }
.chip.off { color: var(--ink-2); }

/* ── Notices, empty, skeleton ───────────────────────────── */
.notice {
  display: flex; gap: 10px; align-items: flex-start; padding: 12px 14px; border-radius: 5px;
  border: 1px solid var(--rule); background: var(--panel-2); margin: 0 0 16px; font-size: 14px;
}
.notice.stop { background: var(--stop-wash); border-color: #f0b8b3; color: var(--stop-ink); }
.notice.hold { background: var(--hold-wash); border-color: #f2d48a; color: var(--hold-ink); }
.notice.go { background: var(--go-wash); border-color: #b5dcc1; color: var(--go-ink); }
.empty { padding: 22px 18px; color: var(--ink-2); }
.empty strong { color: var(--ink); display: block; margin-bottom: 4px; }
.skeleton td { color: transparent; }
.skeleton td::after {
  content: ""; display: block; height: 12px; border-radius: 3px; background: linear-gradient(90deg, #eceef1, #f6f7f9, #eceef1);
  background-size: 200% 100%; animation: shimmer 1.2s ease-in-out infinite;
}
@keyframes shimmer { from { background-position: 100% 0; } to { background-position: -100% 0; } }

/* ── Forms ──────────────────────────────────────────────── */
label.f { display: grid; gap: 4px; font-size: 13px; color: var(--ink-2); font-weight: 600; }
input[type="text"], input[type="number"], input[type="password"], input[type="datetime-local"], select {
  font: 14px/1.3 var(--sans); color: var(--ink); padding: 8px 10px; min-height: 36px;
  border: 1px solid var(--rule-strong); border-radius: 5px; background: #fff; width: 100%;
}
input:hover, select:hover { border-color: var(--ink-3); }
input[aria-invalid="true"] { border-color: var(--stop); }
.grid-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px 16px; }
.inline-form { display: flex; gap: 8px; align-items: end; flex-wrap: wrap; }
.inline-form label.f { min-width: 160px; }
.check { display: inline-flex; gap: 8px; align-items: center; font-size: 14px; }

/* ── Confirmation dialog (write actions only) ───────────── */
dialog {
  border: 1px solid var(--rule-strong); border-radius: 8px; padding: 0; width: min(560px, calc(100vw - 32px));
  box-shadow: 0 18px 50px rgba(20,23,26,.22), 0 2px 6px rgba(20,23,26,.12); color: var(--ink);
}
dialog::backdrop { background: rgba(20,23,26,.38); }
dialog header { padding: 16px 20px 0; }
dialog h2 { margin: 0; font-size: 17px; }
dialog .content { padding: 10px 20px 4px; font-size: 14px; }
dialog .content ul { padding-left: 20px; margin: 8px 0; }
dialog footer { display: flex; justify-content: flex-end; gap: 8px; padding: 14px 20px 18px; }

/* ── Sign-in ────────────────────────────────────────────── */
.signin { max-width: 520px; margin: 64px auto; }

/* ── Toast ──────────────────────────────────────────────── */
#toast {
  position: fixed; left: 50%; bottom: 24px; transform: translate(-50%, 16px); opacity: 0;
  background: var(--ink); color: #fff; padding: 10px 16px; border-radius: 6px; font-size: 14px;
  box-shadow: 0 8px 24px rgba(20,23,26,.28); transition: opacity 180ms ease-out, transform 180ms ease-out;
  max-width: calc(100vw - 32px); pointer-events: none;
}
#toast.show { opacity: 1; transform: translate(-50%, 0); }
#toast.bad { background: var(--stop-ink); }

@media (max-width: 900px) {
  .bay { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .lamp:nth-child(2) { border-right: 0; }
  .lamp:nth-child(-n+2) { border-bottom: 1px solid var(--rule); }
  main, .top { padding-left: 16px; padding-right: 16px; }
  .lamp { padding: 14px 16px; }
}
@media (max-width: 520px) {
  .lamp { padding: 12px 12px; min-height: 0; gap: 2px 10px; }
  .lamp svg { width: 24px; height: 24px; }
  .lamp .name { font-size: 13px; }
  .lamp .state { font-size: 12px; }
  .top { padding-top: 10px; padding-bottom: 10px; gap: 8px 12px; }
  .top .who { margin-left: 0; width: 100%; }
  nav.tabs { padding: 0 8px; }
  nav.tabs button { padding: 11px 10px 10px; }
  main { padding-top: 16px; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
`;
