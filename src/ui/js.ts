/**
 * Admin page script (served as /admin/app.js under script-src 'self').
 * Rules: every value is rendered with textContent (never innerHTML); every write goes through
 * a preview first and a confirmation that names the target client and warehouse.
 * Written without template literals so it can live inside String.raw.
 */
export const ADMIN_JS = String.raw`
(function () {
  "use strict";

  var TOKEN_KEY = "wm_admin_token";
  var S = { state: null, client: null, preview: null, products: null, tab: "overview", showResolved: false };

  // ── tiny DOM helpers ───────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === undefined || v === null || v === false) return;
        if (k === "text") el.textContent = String(v);
        else if (k === "class") el.className = v;
        else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v);
        else if (v === true) el.setAttribute(k, "");
        else el.setAttribute(k, String(v));
      });
    }
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  /** Appends any number of children (nodes, strings, arrays); null/false are skipped. */
  function add(el) {
    for (var i = 1; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined || c === false) continue;
      if (Array.isArray(c)) { c.forEach(function (x) { add(el, x); }); continue; }
      el.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  function mono(v) { return h("span", { class: "mono", text: v == null ? "—" : v }); }
  function chip(kind, label) { return h("span", { class: "chip " + kind, text: label }); }

  function toast(msg, bad) {
    var t = $("toast");
    t.textContent = msg;
    t.className = bad ? "show bad" : "show";
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.className = bad ? "bad" : ""; }, bad ? 6000 : 3200);
  }

  function parseTime(s) {
    if (!s) return null;
    var iso = /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(" ", "T") + "Z";
    var d = new Date(iso);
    return isNaN(d.getTime()) ? null : d;
  }
  function ago(s) {
    var d = parseTime(s);
    if (!d) return "—";
    var sec = Math.round((Date.now() - d.getTime()) / 1000);
    if (sec < 60) return "just now";
    var m = Math.round(sec / 60);
    if (m < 60) return m + " min ago";
    var hr = Math.round(m / 60);
    if (hr < 48) return hr + " h ago";
    return Math.round(hr / 24) + " days ago";
  }
  function when(s) {
    var d = parseTime(s);
    return h("time", { datetime: d ? d.toISOString() : "", title: d ? d.toLocaleString("en-GB") : "", text: ago(s) });
  }
  function minutesSince(s) { var d = parseTime(s); return d ? (Date.now() - d.getTime()) / 60000 : Infinity; }

  // ── API ────────────────────────────────────────────────────────
  function token() { try { return sessionStorage.getItem(TOKEN_KEY); } catch (e) { return null; } }
  function ApiError(status, message, data) { this.status = status; this.message = message; this.data = data; }

  function api(method, path, body) {
    var headers = { "X-Admin-UI": "1", "Accept": "application/json" };
    var t = token();
    if (t) headers["Authorization"] = "Bearer " + t;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return fetch(path, { method: method, headers: headers, credentials: "same-origin", body: body !== undefined ? JSON.stringify(body) : undefined })
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (data) {
          if (res.status === 401) { showSignin(); throw new ApiError(401, "You're not signed in", data); }
          if (!res.ok) throw new ApiError(res.status, (data && (data.message || data.error)) || ("Request failed (HTTP " + res.status + ")"), data);
          return data;
        });
      });
  }

  function busy(btn, on) {
    if (!btn) return;
    if (on) { btn.setAttribute("aria-busy", "true"); btn.disabled = true; }
    else { btn.removeAttribute("aria-busy"); btn.disabled = false; }
  }
  function run(btn, fn) {
    busy(btn, true);
    return Promise.resolve().then(fn).catch(function (e) {
      if (e && e.status !== 401) toast(e.message || String(e), true);
    }).then(function () { busy(btn, false); });
  }

  // ── Confirmation for anything that writes ──────────────────────
  function confirmWrite(title, lines, okLabel, okClass) {
    var d = $("confirm");
    $("confirm-title").textContent = title;
    var body = clear($("confirm-body"));
    lines.forEach(function (l) { add(body, typeof l === "string" ? h("p", { text: l }) : l); });
    var ok = $("confirm-ok");
    ok.textContent = okLabel;
    ok.className = "btn " + (okClass || "write");
    return new Promise(function (resolve) {
      d.addEventListener("close", function onClose() { d.removeEventListener("close", onClose); resolve(d.returnValue === "ok"); });
      d.returnValue = "";
      d.showModal();
      $("confirm-cancel").focus();
    });
  }
  function targetLine() {
    var st = S.state;
    return "Target: Mintsoft client " + st.allowedClientIds.join(", ") + " · warehouse " + (st.warehouseId == null ? "not set" : st.warehouseId);
  }

  // ── Sign-in ────────────────────────────────────────────────────
  function showSignin() {
    $("bay").hidden = true; $("tabs").hidden = true;
    ["overview", "orders", "products", "errors", "settings"].forEach(function (v) { $("view-" + v).hidden = true; });
    var v = clear($("view-signin"));
    v.hidden = false;
    var input = h("input", { type: "password", id: "tok", autocomplete: "off", "aria-describedby": "tok-help" });
    add(v, h("section", { class: "panel signin" },
      h("header", null, h("h2", { text: "Sign in to continue" })),
      h("div", { class: "body" },
        h("p", { text: "Open this page through Cloudflare Access and sign in with your work email. If you just signed in, reload the page." }),
        h("div", { class: "actions" }, h("button", { class: "btn primary", text: "Reload", onclick: function () { location.reload(); } })),
        h("h3", { text: "Owner fallback" }),
        h("form", { class: "inline-form", onsubmit: function (e) {
            e.preventDefault();
            try { sessionStorage.setItem(TOKEN_KEY, input.value.trim()); } catch (err) {}
            location.reload();
          } },
          h("label", { class: "f", for: "tok" }, "Admin token", input),
          h("button", { class: "btn", type: "submit", text: "Use token" })),
        h("p", { class: "small muted", id: "tok-help", text: "Kept for this browser tab only and cleared when it closes." }))));
  }

  // ── Load + header + lamps ──────────────────────────────────────
  function load() {
    return api("GET", "/admin/state").then(function (st) {
      S.state = st;
      if (!S.client && st.clients.length) S.client = st.clients[0].slug;
      $("view-signin").hidden = true;
      $("bay").hidden = false; $("tabs").hidden = false;
      renderHeader(); renderLamps(); renderCounts();
      show(S.tab);
    });
  }

  function renderHeader() {
    var st = S.state;
    var t = clear($("target"));
    add(t, h("span", { class: "field" }, "Client", h("b", { text: st.allowedClientIds.join(", ") || "none" })));
    add(t, h("span", { class: "field" }, "Warehouse", h("b", { text: st.warehouseId == null ? "not set" : st.warehouseId })));
    var who = clear($("who"));
    add(who, st.user ? "Signed in as " + st.user : "");
    if (token()) add(who, h("button", { class: "btn small", style: "margin-left:10px", text: "Forget token", onclick: function () {
      try { sessionStorage.removeItem(TOKEN_KEY); } catch (e) {} location.reload(); } }));
  }

  function setLamp(id, state, text) {
    var el = $("lamp-" + id);
    el.setAttribute("data-state", state);
    el.querySelector(".state").textContent = text;
  }

  function summary(r) {
    if (!r || !r.summary) return "";
    var s = r.summary;
    if (s.skipped) return "";
    var parts = [];
    if (s.imported) parts.push(s.imported + " imported");
    if (s.held) parts.push(s.held + " held");
    if (s.pushed) parts.push(s.pushed + " fulfilled in Wix");
    if (s.errors) parts.push(s.errors + " failed");
    return parts.length ? " · " + parts.join(", ") : " · nothing new";
  }

  function renderLamps() {
    var st = S.state, w = st.writes, runs = st.lastRuns || {};
    var imp = runs.importOrders, rec = runs.reconcile;

    if (!w.effective) setLamp("import", "hold", "Paused · no orders go to Mintsoft");
    else if (!imp) setLamp("import", "off", "Live · waiting for the first run");
    else if (imp.summary && imp.summary.ok === false) setLamp("import", "stop", "Last run failed: " + (imp.summary.error || "unknown error"));
    else if (minutesSince(imp.at) > 15) setLamp("import", "stop", "No run for " + ago(imp.at).replace(" ago", "") + " — check the Worker");
    else setLamp("import", "go", "Running · " + ago(imp.at) + summary(imp));

    if (!rec) setLamp("despatch", "off", "Waiting for the first check");
    else if (rec.summary && rec.summary.ok === false) setLamp("despatch", "stop", "Last check failed: " + (rec.summary.error || "unknown error"));
    else if (minutesSince(rec.at) > 15) setLamp("despatch", "stop", "No check for " + ago(rec.at).replace(" ago", "") + " — check the Worker");
    else setLamp("despatch", "go", "Checking · " + ago(rec.at) + summary(rec));

    var act = clear($("lamp-writes").querySelector(".act"));
    if (!w.master) {
      setLamp("writes", "off", "Locked off at deploy (MINTSOFT_WRITES_ENABLED)");
    } else if (w.effective) {
      setLamp("writes", "go", "Live · orders and products are created in Mintsoft");
      add(act, h("button", { class: "btn small pause", text: "Pause writes", onclick: function (e) { toggleWrites(false, e.currentTarget); } }));
    } else {
      setLamp("writes", "hold", "Paused · nothing is written to Mintsoft");
      add(act, h("button", { class: "btn small write", text: "Go live…", onclick: function (e) { toggleWrites(true, e.currentTarget); } }));
    }
    if (w.updatedBy) add(act, h("span", { class: "meta", text: (w.toggle ? "Switched on" : "Paused") + " by " + w.updatedBy + ", " + ago(w.updatedAt) }));

    var held = 0;
    st.clients.forEach(function (c) { held += (c.orderCounts && c.orderCounts.held) || 0; });
    var n = st.unresolvedErrors;
    if (n || held) {
      var bits = [];
      if (held) bits.push(held + " held order" + (held === 1 ? "" : "s"));
      if (n) bits.push(n + " unresolved error" + (n === 1 ? "" : "s"));
      setLamp("attention", "stop", bits.join(" · "));
    } else setLamp("attention", "go", "Nothing waiting");
  }

  function renderCounts() {
    var st = S.state, held = 0;
    st.clients.forEach(function (c) { held += (c.orderCounts && c.orderCounts.held) || 0; });
    var ch = $("count-held"), ce = $("count-errors");
    ch.hidden = !held; ch.textContent = held; ch.className = "count hold";
    ce.hidden = !st.unresolvedErrors; ce.textContent = st.unresolvedErrors; ce.className = "count stop";
  }

  function toggleWrites(on, btn) {
    var go = on ? confirmWrite("Switch Mintsoft writes on?", [
        "While writes are live, every 5 minutes the integration creates each paid, unfulfilled Wix order in Mintsoft, and the Import and Products buttons here can create orders and products.",
        targetLine(),
        "Writes to any other Mintsoft client are refused whatever this switch says."
      ], "Go live") : Promise.resolve(true);
    return go.then(function (ok) {
      if (!ok) return;
      return run(btn, function () {
        return api("PUT", "/admin/settings/writes", { enabled: on }).then(function () {
          toast(on ? "Writes are live" : "Writes paused");
          return load();
        });
      });
    });
  }

  // ── Tabs ───────────────────────────────────────────────────────
  var TABS = ["overview", "orders", "products", "errors", "settings"];
  function show(tab) {
    S.tab = tab;
    TABS.forEach(function (t) {
      var b = $("tab-" + t), v = $("view-" + t), on = t === tab;
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
      v.hidden = !on;
    });
    try { history.replaceState(null, "", "#" + tab); } catch (e) {}
    ({ overview: renderOverview, orders: renderOrders, products: renderProducts, errors: renderErrors, settings: renderSettings })[tab]();
  }
  $("tabs").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-tab]");
    if (b) show(b.getAttribute("data-tab"));
  });
  $("tabs").addEventListener("keydown", function (e) {
    var i = TABS.indexOf(S.tab);
    if (e.key === "ArrowRight") i = (i + 1) % TABS.length;
    else if (e.key === "ArrowLeft") i = (i - 1 + TABS.length) % TABS.length;
    else return;
    e.preventDefault(); show(TABS[i]); $("tab-" + TABS[i]).focus();
  });

  function panel(title, tools, body) {
    return h("section", { class: "panel" },
      h("header", null, h("h2", { text: title }), h("span", { class: "spacer" }), tools),
      h("div", { class: "body" }, body));
  }
  function table(cols, rows, empty) {
    if (!rows.length) return h("div", { class: "empty" }, h("strong", { text: empty[0] }), empty[1]);
    return h("div", { class: "table-wrap" }, h("table", null,
      h("thead", null, h("tr", null, cols.map(function (c) { return h("th", { class: c.num ? "num" : null, scope: "col", text: c.label }); }))),
      h("tbody", null, rows)));
  }
  function skeleton(n, cols) {
    var rows = [];
    for (var i = 0; i < n; i++) { var tds = []; for (var j = 0; j < cols; j++) tds.push(h("td", { text: "·" })); rows.push(h("tr", { class: "skeleton" }, tds)); }
    return h("div", { class: "table-wrap" }, h("table", null, h("tbody", null, rows)));
  }
  function clientPicker(onChange) {
    var st = S.state;
    if (st.clients.length <= 1) return null;
    return h("label", { class: "check" }, "Client",
      h("select", { onchange: function (e) { S.client = e.target.value; S.preview = null; S.products = null; onChange(); } },
        st.clients.map(function (c) { return h("option", { value: c.slug, selected: c.slug === S.client, text: c.name + " (" + c.slug + ")" }); })));
  }
  function currentClient() { return S.state.clients.filter(function (c) { return c.slug === S.client; })[0]; }
  function noClient(view) {
    add(clear(view), panel("No clients yet", null,
      h("div", { class: "empty" }, h("strong", { text: "Add a Wix store first." }), "Go to Settings → Add a client.")));
  }

  // ── Overview ───────────────────────────────────────────────────
  var STATUS = {
    imported: ["go", "Imported"], fulfilled: ["go", "Fulfilled in Wix"], despatched: ["go", "Part despatched"],
    held: ["stop", "Held"], fulfil_failed: ["stop", "Fulfilment failed"], skipped_non_physical: ["off", "Nothing to ship"]
  };
  function statusChip(s) { var m = STATUS[s] || ["off", s]; return chip(m[0], m[1]); }

  function renderOverview() {
    var v = clear($("view-overview")), st = S.state;
    if (!st.writes.master) add(v, h("div", { class: "notice" }, "Mintsoft writes are locked off at deploy level (MINTSOFT_WRITES_ENABLED is not \"true\"). The page can preview everything but can't write."));
    var cols = [{ label: "Client" }, { label: "Mintsoft client" }, { label: "Catalog" }, { label: "Imported", num: 1 }, { label: "Held", num: 1 }, { label: "Fulfilled", num: 1 }, { label: "Status" }];
    var rows = st.clients.map(function (c) {
      var k = c.orderCounts || {};
      return h("tr", { "data-row": k.held ? "hold" : null },
        h("td", null, h("strong", { text: c.name }), " ", h("span", { class: "muted small", text: c.slug })),
        h("td", null, mono(c.mintsoftClientId)),
        h("td", { text: c.catalogVersion || "—" }),
        h("td", { class: "num", text: (k.imported || 0) + (k.despatched || 0) }),
        h("td", { class: "num", text: k.held || 0 }),
        h("td", { class: "num", text: k.fulfilled || 0 }),
        h("td", null, c.active ? chip("go", "Active") : chip("stop", "Deactivated")));
    });
    add(v, panel("Clients", null, table(cols, rows, ["No clients yet.", " Add one in Settings."])));

    var resBox = h("div");
    var btn = h("button", { class: "btn", text: "Check despatches now" });
    btn.addEventListener("click", function () {
      confirmWrite("Check Mintsoft for despatches now?", [
        "Orders despatched in Mintsoft that aren't fulfilled in Wix yet will be marked fulfilled in Wix with their tracking. Wix may email those customers. Nothing is written to Mintsoft."
      ], "Check now").then(function (ok) {
        if (!ok) return;
        run(btn, function () {
          return api("POST", "/admin/reconcile").then(function (r) {
            var pushed = r.results.filter(function (x) { return x.outcome !== "error"; }).length;
            var failed = r.results.length - pushed;
            add(clear(resBox), h("div", { class: "notice " + (failed ? "stop" : "go") },
              r.despatchedSeen + " despatched order(s) seen in Mintsoft, " + r.ours + " of ours. " + pushed + " fulfilled in Wix" + (failed ? ", " + failed + " failed (see Errors)" : "") + "."));
            return load();
          });
        });
      });
    });
    add(v, h("div", { class: "cols" },
      panel("Despatch → Wix", btn, [
        h("p", { class: "muted", text: "Runs automatically every 5 minutes, and Mintsoft also notifies us about 10 minutes after each despatch. Use this to push tracking to Wix straight away." }),
        resBox]),
      panel("Recent activity", null, h("div", { id: "activity" }, skeleton(4, 3)))));
    api("GET", "/admin/audit?limit=8").then(function (r) {
      var el = $("activity"); if (!el) return;
      add(clear(el), table([{ label: "When" }, { label: "Who" }, { label: "What" }], r.entries.map(function (e) {
        return h("tr", null, h("td", null, when(e.createdAt)), h("td", { class: "small", text: e.actor }), h("td", { class: "small" }, h("strong", { text: e.action }), e.detail ? " " + e.detail : ""));
      }), ["No activity yet.", " Actions taken here are recorded with who did them."]));
    }).catch(function () {});
  }

  // ── Orders ─────────────────────────────────────────────────────
  var OUTCOME = {
    would_import: ["go", "Would import"], imported: ["go", "Imported"], already_in_mintsoft: ["go", "Already in Mintsoft"],
    held: ["stop", "Held"], skipped_non_physical: ["off", "Nothing to ship"], skipped: ["off", "Skipped"]
  };
  function outcomeChip(o) { var m = OUTCOME[o] || ["off", o]; return chip(m[0], m[1]); }

  function renderOrders() {
    var v = clear($("view-orders"));
    if (!S.state.clients.length) return noClient(v);
    var c = currentClient(), w = S.state.writes;
    var pick = clientPicker(renderOrders);

    var previewBtn = h("button", { class: "btn primary", text: S.preview ? "Preview again" : "Preview import" });
    var would = S.preview ? S.preview.outcomes.filter(function (o) { return o.outcome === "would_import"; }) : [];
    var importBtn = h("button", { class: "btn write", text: "Import now…", disabled: !(w.effective && would.length) });
    var why = !w.effective ? "Writes are paused, so Import is off." : !S.preview ? "Preview first, then import." : !would.length ? "Nothing in the preview would import." : "";
    var out = h("div");

    previewBtn.addEventListener("click", function () {
      run(previewBtn, function () {
        return api("POST", "/admin/clients/" + encodeURIComponent(S.client) + "/run-import?dryRun=true").then(function (r) { S.preview = r; renderOrders(); });
      });
    });
    importBtn.addEventListener("click", function () {
      confirmWrite("Create " + would.length + " order" + (would.length === 1 ? "" : "s") + " in Mintsoft?", [
        h("ul", null, would.map(function (o) {
          var p = o.payload;
          return h("li", null, h("span", { class: "mono", text: o.wixOrderNumber }), " · courier " + p.CourierServiceId + " · " + p.OrderItems.map(function (i) { return i.SKU + " × " + i.Quantity; }).join(", "));
        })),
        targetLine(),
        "Orders with an unknown SKU are sent once so Mintsoft shows its own error; they are not created. Any order placed since the preview is included too."
      ], "Create in Mintsoft").then(function (ok) {
        if (!ok) return;
        run(importBtn, function () {
          return api("POST", "/admin/clients/" + encodeURIComponent(S.client) + "/run-import?dryRun=false").then(function (r) {
            S.preview = null;
            add(clear(out), h("div", { class: "notice go" }, "Import finished: " + r.outcomes.length + " order(s) processed."), outcomesTable(r, false));
            toast("Import finished");
            return load();
          });
        });
      });
    });

    var body = [];
    if (S.preview) {
      body.push(h("p", { class: "muted small", text: "Preview: nothing was written. " + S.preview.ordersSeen + " order(s) found in Wix, " + S.preview.alreadyHandled + " already handled." }));
      body.push(outcomesTable(S.preview, true));
    } else {
      body.push(h("div", { class: "empty" }, h("strong", { text: "See exactly what would go to Mintsoft." }),
        "Preview reads paid, unfulfilled Wix orders and checks each against Mintsoft without writing anything."));
    }
    body.push(out);
    add(v, panel("Import from Wix" + (c ? " · " + c.name : ""), h("div", { class: "actions" }, pick, previewBtn, importBtn, why ? h("span", { class: "why", text: why }) : null), body));

    var heldBox = h("div", null, skeleton(3, 5));
    var recentBox = h("div", null, skeleton(5, 5));
    add(v, panel("Held orders", h("span", { class: "why", text: "Retried automatically every hour for 7 days." }), heldBox));
    add(v, panel("Recent orders", null, recentBox));

    api("GET", "/admin/clients/" + encodeURIComponent(S.client) + "/orders?status=held&limit=100").then(function (r) { renderHeld(heldBox, r.orders); }).catch(function (e) { add(clear(heldBox), h("div", { class: "notice stop", text: e.message })); });
    api("GET", "/admin/clients/" + encodeURIComponent(S.client) + "/orders?limit=50").then(function (r) {
      add(clear(recentBox), table([{ label: "Order" }, { label: "Status" }, { label: "Mintsoft order" }, { label: "Tracking" }, { label: "Updated" }], r.orders.map(function (o) {
        return h("tr", null, h("td", null, mono(o.wixOrderNumber)), h("td", null, statusChip(o.status)), h("td", null, mono(o.mintsoftOrderId)), h("td", null, mono(o.trackingNumber)), h("td", null, when(o.updatedAt)));
      }), ["No orders yet.", " Orders appear here once the import has seen them."]));
    }).catch(function (e) { add(clear(recentBox), h("div", { class: "notice stop", text: e.message })); });
  }

  function outcomesTable(r, isPreview) {
    var cols = [{ label: "Order" }, { label: isPreview ? "Would happen" : "Result" }, { label: "Courier" }, { label: "Items" }, { label: "Value", num: 1 }, { label: "Details" }];
    return table(cols, r.outcomes.map(function (o) {
      var p = o.payload || {};
      return h("tr", { "data-row": o.outcome === "held" ? "stop" : null },
        h("td", null, mono(o.wixOrderNumber)),
        h("td", null, outcomeChip(o.outcome)),
        h("td", null, p.CourierServiceId != null ? mono(p.CourierServiceId) : "—"),
        h("td", { class: "small" }, p.OrderItems ? p.OrderItems.map(function (i) { return i.SKU + " × " + i.Quantity; }).join(", ") : "—"),
        h("td", { class: "num", text: p.OrderValue != null ? "£" + Number(p.OrderValue).toFixed(2) : "—" }),
        h("td", { class: "msg small", text: o.message || o.warning || (o.mintsoftOrderId ? "Mintsoft order " + o.mintsoftOrderId : "") }));
    }), ["No new orders.", " Every paid, unfulfilled Wix order has already been handled."]);
  }

  function renderHeld(box, orders) {
    var w = S.state.writes;
    add(clear(box), table([{ label: "Order" }, { label: "Why it's held" }, { label: "Tries", num: 1 }, { label: "Last tried" }, { label: "" }], orders.map(function (o) {
      var resultCell = h("div", { class: "small" });
      var check = h("button", { class: "btn small", text: "Check again" });
      check.addEventListener("click", function () {
        run(check, function () {
          return api("POST", "/admin/clients/" + encodeURIComponent(S.client) + "/orders/" + encodeURIComponent(o.wixOrderNumber) + "/retry?dryRun=true").then(function (r) {
            var x = r.outcome;
            add(clear(resultCell), outcomeChip(x.outcome), x.message ? " " + x.message : "");
          });
        });
      });
      var retry = h("button", { class: "btn small write", text: "Retry now…", disabled: !w.effective });
      retry.addEventListener("click", function () {
        confirmWrite("Retry order " + o.wixOrderNumber + " now?", ["If every SKU now exists, the order is created in Mintsoft.", targetLine()], "Retry now").then(function (ok) {
          if (!ok) return;
          run(retry, function () {
            return api("POST", "/admin/clients/" + encodeURIComponent(S.client) + "/orders/" + encodeURIComponent(o.wixOrderNumber) + "/retry?dryRun=false").then(function (r) {
              toast("Order " + o.wixOrderNumber + ": " + ((OUTCOME[r.outcome.outcome] || [0, r.outcome.outcome])[1]));
              return load();
            });
          });
        });
      });
      var actions = [check, retry];
      if (/not found in Mintsoft/.test(o.lastError || "")) {
        var resend = h("button", { class: "btn small", text: "Re-send to Mintsoft…", disabled: !w.effective, title: "Sends the order again so Mintsoft shows its missing-SKU error. It is rejected; nothing is created." });
        resend.addEventListener("click", function () {
          confirmWrite("Re-send order " + o.wixOrderNumber + " to Mintsoft?", ["Mintsoft should reject it again and show its missing-SKU connect error to the warehouse team. Nothing is created while the SKU is missing.", targetLine()], "Re-send").then(function (ok) {
            if (!ok) return;
            run(resend, function () {
              return api("POST", "/admin/clients/" + encodeURIComponent(S.client) + "/orders/" + encodeURIComponent(o.wixOrderNumber) + "/retry?dryRun=false&notify=true").then(function () { toast("Sent to Mintsoft"); return load(); });
            });
          });
        });
        actions.push(resend);
      }
      return h("tr", { "data-row": "stop" },
        h("td", null, mono(o.wixOrderNumber)),
        h("td", { class: "msg small" }, (o.lastError || "—"), resultCell),
        h("td", { class: "num", text: o.attempts }),
        h("td", null, when(o.updatedAt)),
        h("td", { class: "actions-cell" }, h("div", { class: "actions" }, actions)));
    }), ["No held orders.", " Orders that can't be imported (unknown SKU, missing address, unmapped courier) show up here with the reason."]));
  }

  // ── Products ───────────────────────────────────────────────────
  function productPages(dryRun, maxCreates, onPage) {
    var acc = { wouldCreate: [], created: [], skippedExisting: [], missingSku: [], duplicateSkuInWix: [], skippedNonPhysical: 0, errors: [], pages: 0 };
    function step(cursor) {
      var q = "?dryRun=" + (dryRun ? "true" : "false") + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "") + (maxCreates ? "&maxCreates=" + maxCreates : "");
      return api("POST", "/admin/clients/" + encodeURIComponent(S.client) + "/import-products" + q).then(function (r) {
        acc.pages++;
        ["wouldCreate", "created", "skippedExisting", "missingSku", "duplicateSkuInWix", "errors"].forEach(function (k) { acc[k] = acc[k].concat(r[k] || []); });
        acc.skippedNonPhysical += r.skippedNonPhysical || 0;
        acc.dryRun = r.dryRun;
        if (onPage) onPage(acc);
        if (r.done || r.stoppedBy === "api_error" || (maxCreates === 1 && acc.created.length >= 1) || acc.pages > 200) return acc;
        if (r.stoppedBy === "max_creates" && maxCreates === 1) return acc;
        return step(r.nextCursor);
      });
    }
    return step(null);
  }

  function renderProducts() {
    var v = clear($("view-products"));
    if (!S.state.clients.length) return noClient(v);
    var w = S.state.writes, P = S.products, c = currentClient();
    var progress = h("span", { class: "why" });
    var previewBtn = h("button", { class: "btn primary", text: P ? "Preview again" : "Preview product import" });
    var toCreate = P ? P.wouldCreate.length : 0;
    var oneBtn = h("button", { class: "btn write", text: "Create first product…", disabled: !(w.effective && toCreate) });
    var allBtn = h("button", { class: "btn write", text: "Create all…", disabled: !(w.effective && toCreate) });

    previewBtn.addEventListener("click", function () {
      run(previewBtn, function () {
        return productPages(true, 0, function (acc) { progress.textContent = "Reading Wix… page " + acc.pages; }).then(function (acc) { S.products = acc; renderProducts(); });
      });
    });
    function create(btn, max) {
      confirmWrite(max === 1 ? "Create one product in Mintsoft?" : "Create " + toCreate + " product(s) in Mintsoft?", [
        max === 1 ? "Creates the first missing SKU and checks Mintsoft can find it again, before you create the rest." : "Creates every SKU from the preview that isn't in Mintsoft yet. Existing SKUs are never changed. No stock is sent.",
        targetLine()
      ], max === 1 ? "Create one" : "Create all").then(function (ok) {
        if (!ok) return;
        run(btn, function () {
          return productPages(false, max, function (acc) { progress.textContent = "Creating… " + acc.created.length + " created"; }).then(function (acc) {
            S.products = null;
            var bad = acc.errors.length;
            toast(acc.created.length + " product(s) created" + (bad ? ", " + bad + " failed" : ""), !!bad);
            add(clear(v), h("div", { class: "notice " + (bad ? "stop" : "go") }, acc.created.length + " created in Mintsoft" + (bad ? "; " + bad + " failed — see the table." : ".")));
            add(v, productTable(acc, false));
            add(v, h("div", { class: "actions" }, h("button", { class: "btn", text: "Back to preview", onclick: function () { renderProducts(); } })));
            return load();
          });
        }).catch(function (e) { toast(e.message, true); });
      });
    }
    oneBtn.addEventListener("click", function () { create(oneBtn, 1); });
    allBtn.addEventListener("click", function () { create(allBtn, 0); });

    var why = !w.effective ? "Writes are paused, so creating is off." : !P ? "Preview first." : !toCreate ? "Every SKU is already in Mintsoft." : "";
    var body = P ? [
      h("p", { class: "muted small", text: "Preview: nothing was written. " + toCreate + " to create · " + P.skippedExisting.length + " already in Mintsoft · " + P.missingSku.length + " without a SKU · " + P.skippedNonPhysical + " digital skipped." }),
      productTable(P, true)
    ] : h("div", { class: "empty" }, h("strong", { text: "Bring this store's products into Mintsoft." }),
      "Preview lists every Wix variant and whether it would be created. SKUs already in Mintsoft are never changed, and stock is never sent.");
    add(v, panel("Products from Wix" + (c ? " · " + c.name : ""), h("div", { class: "actions" }, clientPicker(renderProducts), previewBtn, oneBtn, allBtn, why ? h("span", { class: "why", text: why }) : null, progress), body));
  }

  function productTable(P, isPreview) {
    var rows = [];
    (isPreview ? P.wouldCreate : P.created).forEach(function (x) {
      var p = x.payload || {}, zero = (x.flags || []).indexOf("zero_weight") >= 0;
      rows.push(h("tr", { "data-row": zero ? "hold" : null },
        h("td", null, mono(x.sku)),
        h("td", { text: p.Name || "—" }),
        h("td", { class: "num" }, zero ? chip("hold", "0 kg") : (p.Weight != null ? p.Weight + " kg" : "—")),
        h("td", { class: "num", text: p.Price != null ? "£" + Number(p.Price).toFixed(2) : "—" }),
        h("td", null, isPreview ? chip("go", "Would create") : chip("go", "Created · #" + x.mintsoftProductId))));
    });
    P.skippedExisting.forEach(function (x) {
      rows.push(h("tr", null, h("td", null, mono(x.sku)), h("td", { text: "—" }), h("td", { class: "num", text: "—" }), h("td", { class: "num", text: "—" }), h("td", null, chip("off", "Already in Mintsoft"))));
    });
    P.missingSku.forEach(function (name) {
      rows.push(h("tr", { "data-row": "stop" }, h("td", null, mono(null)), h("td", { text: name }), h("td", { class: "num", text: "—" }), h("td", { class: "num", text: "—" }), h("td", null, chip("stop", "No SKU in Wix"))));
    });
    P.errors.forEach(function (e) {
      rows.push(h("tr", { "data-row": "stop" }, h("td", null, mono(e.sku)), h("td", { class: "msg small", text: e.message }), h("td"), h("td"), h("td", null, chip("stop", "Failed"))));
    });
    return table([{ label: "SKU" }, { label: "Name" }, { label: "Weight", num: 1 }, { label: "Price", num: 1 }, { label: "Status" }], rows,
      ["Nothing to show.", " This store has no physical products with SKUs."]);
  }

  // ── Errors ─────────────────────────────────────────────────────
  var CODE = {
    unknown_sku: "SKU not in Mintsoft", missing_sku: "No SKU in Wix", unmapped_courier: "Courier not mapped", invalid_address: "Incomplete address",
    invalid_line: "Bad quantity", unknown_item_type: "Unrecognised item type", mintsoft_rejected: "Rejected by Mintsoft", mintsoft_api_error: "Mintsoft unavailable",
    wix_api_error: "Wix unavailable", order_not_found: "Despatch not matched", mintsoft_cancelled: "Cancelled in Mintsoft", despatch_mismatch: "Despatch doesn't match Wix",
    despatch_payload_invalid: "Unreadable despatch", order_cancelled: "Cancelled in Wix", mintsoft_client_mismatch: "WRONG MINTSOFT CLIENT", mintsoft_verify_failed: "Not verified",
    mintsoft_accepted_unknown_sku: "Accepted with unknown SKU", config_error: "Configuration", internal_error: "Internal error",
    mintsoft_writes_disabled: "Writes off", mintsoft_client_not_allowed: "Client not allowlisted"
  };
  function renderErrors() {
    var v = clear($("view-errors"));
    var box = h("div", null, skeleton(5, 5));
    var toggle = h("label", { class: "check" }, h("input", { type: "checkbox", checked: S.showResolved, onchange: function (e) { S.showResolved = e.target.checked; renderErrors(); } }), "Show resolved");
    add(v, panel("Errors", toggle, box));
    api("GET", "/admin/errors?limit=200" + (S.showResolved ? "" : "&unresolved=1")).then(function (r) {
      add(clear(box), table([{ label: "When" }, { label: "Order / SKU" }, { label: "Problem" }, { label: "Details" }, { label: "" }], r.errors.map(function (e) {
        var btn = e.resolved ? chip("off", "Resolved") : h("button", { class: "btn small", text: "Resolve" });
        if (!e.resolved) btn.addEventListener("click", function () {
          run(btn, function () { return api("POST", "/admin/errors/" + e.id + "/resolve").then(function () { toast("Marked resolved"); return load(); }); });
        });
        return h("tr", { "data-row": e.resolved ? null : "stop" },
          h("td", null, when(e.createdAt)),
          h("td", null, mono(e.ref)),
          h("td", null, h("strong", { text: CODE[e.code] || e.code })),
          h("td", { class: "msg small", text: e.message }),
          h("td", { class: "actions-cell" }, btn));
      }), ["Nothing needs attention.", " Held orders, failed fulfilments and Mintsoft cancellations appear here until someone resolves them."]));
    }).catch(function (e) { add(clear(box), h("div", { class: "notice stop", text: e.message })); });
  }

  // ── Settings ───────────────────────────────────────────────────
  function editor(rowsData, fields, onSave, addLabel) {
    var tbody = h("tbody");
    function addRow(d) {
      var tr = h("tr");
      fields.forEach(function (f) {
        add(tr, h("td", null, h("input", { type: f.type || "text", value: d[f.key] == null ? "" : d[f.key], "aria-label": f.label, "data-key": f.key, inputmode: f.type === "number" ? "numeric" : null })));
      });
      add(tbody, tr);
    }
    rowsData.forEach(addRow);
    if (!rowsData.length) addRow({});
    var save = h("button", { class: "btn primary", text: "Save" });
    save.addEventListener("click", function () {
      var out = [], bad = false;
      Array.prototype.forEach.call(tbody.rows, function (tr) {
        var o = {}, empty = true;
        Array.prototype.forEach.call(tr.querySelectorAll("input"), function (i) {
          var k = i.getAttribute("data-key"), val = i.value.trim();
          i.removeAttribute("aria-invalid");
          if (val) empty = false;
          o[k] = i.type === "number" ? (val ? Number(val) : null) : val;
        });
        if (empty) return;
        fields.forEach(function (f) {
          var i = tr.querySelector("[data-key='" + f.key + "']");
          if (f.required && (o[f.key] === null || o[f.key] === "")) { i.setAttribute("aria-invalid", "true"); bad = true; }
        });
        out.push(o);
      });
      if (bad) { toast("Fill in the highlighted fields", true); return; }
      if (!out.length) { toast("Nothing to save", true); return; }
      run(save, function () { return onSave(out).then(function () { toast("Saved"); }); });
    });
    return h("div", null,
      h("div", { class: "table-wrap" }, h("table", null,
        h("thead", null, h("tr", null, fields.map(function (f) { return h("th", { scope: "col", text: f.label }); }))), tbody)),
      h("div", { class: "actions", style: "margin-top:12px" }, h("button", { class: "btn", text: addLabel, onclick: function () { addRow({}); } }), save));
  }

  function renderSettings() {
    var v = clear($("view-settings"));
    var courierBox = h("div", null, skeleton(2, 3)), carrierBox = h("div", null, skeleton(2, 2)), auditBox = h("div", null, skeleton(5, 3));
    if (S.state.clients.length) {
      add(v, panel("Courier map" + (currentClient() ? " · " + currentClient().name : ""), clientPicker(renderSettings), [
        h("p", { class: "muted small", text: "Which Mintsoft courier service each Wix shipping option uses. Names are matched ignoring case and spaces; anything unmapped uses the client's default courier." }),
        courierBox]));
      api("GET", "/admin/clients/" + encodeURIComponent(S.client) + "/courier-map").then(function (r) {
        add(clear(courierBox),
          h("p", { class: "small", text: "Default courier service: " + (r.defaultCourierServiceId == null ? "none (unmapped orders are held)" : r.defaultCourierServiceId) }),
          editor(r.mappings.map(function (m) { return { t: m.wixShippingTitle, id: m.mintsoftCourierServiceId, n: m.carrierDisplayName }; }),
            [{ key: "t", label: "Wix shipping option", required: true }, { key: "id", label: "Mintsoft courier service ID", type: "number", required: true }, { key: "n", label: "Carrier name for customers" }],
            function (rows) {
              return api("PUT", "/admin/clients/" + encodeURIComponent(S.client) + "/courier-map", { mappings: rows.map(function (x) { return { wix_shipping_title: x.t, mintsoft_courier_service_id: x.id, carrier_display_name: x.n || null }; }) });
            }, "Add shipping option"));
      }).catch(function (e) { add(clear(courierBox), h("div", { class: "notice stop", text: e.message })); });
    }

    add(v, panel("Carrier names", null, [
      h("p", { class: "muted small", text: "The carrier name customers see in Wix, by the Mintsoft courier service an order was actually despatched with." }),
      carrierBox]));
    api("GET", "/admin/carriers").then(function (r) {
      add(clear(carrierBox), editor(r.carriers.map(function (c) { return { id: c.mintsoftCourierServiceId, n: c.displayName }; }),
        [{ key: "id", label: "Mintsoft courier service ID", type: "number", required: true }, { key: "n", label: "Name shown in Wix", required: true }],
        function (rows) { return api("PUT", "/admin/carriers", { carriers: rows.map(function (x) { return { mintsoft_courier_service_id: x.id, display_name: x.n }; }) }); },
        "Add courier service"));
    }).catch(function (e) { add(clear(carrierBox), h("div", { class: "notice stop", text: e.message })); });

    add(v, onboardingPanel());

    add(v, panel("Audit log", null, auditBox));
    api("GET", "/admin/audit?limit=100").then(function (r) {
      add(clear(auditBox), table([{ label: "When" }, { label: "Who" }, { label: "Action" }, { label: "Details" }], r.entries.map(function (e) {
        return h("tr", null, h("td", null, when(e.createdAt)), h("td", { class: "small", text: e.actor }), h("td", null, h("strong", { text: e.action })), h("td", { class: "msg small", text: e.detail || "" }));
      }), ["No activity yet.", " Every change made here is recorded with who made it."]));
    }).catch(function (e) { add(clear(auditBox), h("div", { class: "notice stop", text: e.message })); });
  }

  function onboardingPanel() {
    function f(key, label, type, hint) {
      return h("label", { class: "f" }, label, h("input", { type: type || "text", name: key, autocomplete: "off", required: hint !== "optional" }), hint && hint !== "optional" ? h("span", { class: "small muted", text: hint }) : null);
    }
    var form = h("form", { class: "grid-form" },
      f("name", "Client name"), f("slug", "Short name (used in URLs)", "text", "lowercase letters, digits, hyphens"),
      f("mintsoft_client_id", "Mintsoft client ID", "number"), f("mintsoft_client_name", "Mintsoft client name", "text", "exactly as in Mintsoft"),
      f("wix_site_id", "Wix site ID"), f("wix_api_key", "Wix API key", "password"),
      f("default_courier_service_id", "Default courier service ID", "number", "optional"), f("default_carrier_name", "Default carrier name", "text", "optional"),
      f("order_number_prefix", "Order number prefix", "text", "optional"), f("import_orders_since", "Import orders updated since", "datetime-local", "optional"));
    var submit = h("button", { class: "btn primary", type: "submit", text: "Add client" });
    add(form, h("div", { class: "actions" }, submit));
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var fd = new FormData(form), body = {};
      fd.forEach(function (val, key) {
        val = String(val).trim();
        if (!val) return;
        if (key === "mintsoft_client_id" || key === "default_courier_service_id") body[key] = Number(val);
        else if (key === "import_orders_since") body[key] = new Date(val).toISOString();
        else body[key] = val;
      });
      run(submit, function () {
        return api("POST", "/admin/clients", body).then(function (r) {
          toast("Added " + r.client.name + " → Mintsoft client " + r.mintsoft_client.id + " (" + r.mintsoft_client.name + ")");
          form.reset(); S.client = r.client.slug;
          return load();
        });
      });
    });
    return h("details", { class: "panel", style: "background:var(--panel);border:1px solid var(--rule);border-radius:var(--radius);margin-bottom:20px" },
      h("summary", { style: "padding:14px 18px;cursor:pointer;font-weight:650", text: "Add a client" }),
      h("div", { class: "body", style: "padding:0 18px 18px" },
        h("p", { class: "muted small", text: "Checks the Mintsoft client ID and name match and that the Wix key works before saving. Nothing is written to Mintsoft or Wix. The Mintsoft client must already be on the deploy allowlist." }),
        form));
  }

  // ── Boot ───────────────────────────────────────────────────────
  var initial = (location.hash || "").slice(1);
  if (TABS.indexOf(initial) >= 0) S.tab = initial;
  load().catch(function (e) { if (e && e.status !== 401) toast(e.message || String(e), true); });
  setInterval(function () { if (!document.hidden && S.state) api("GET", "/admin/state").then(function (st) { S.state = st; renderHeader(); renderLamps(); renderCounts(); }).catch(function () {}); }, 60000);
})();
`;
