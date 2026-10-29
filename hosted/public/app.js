// Arb Finder — hosted UI. Vanilla JS, no build step.
// Everything that comes from uploads or bookmakers is untrusted text, so it is only
// ever written with textContent, never innerHTML.

const SPORTS = {
  10: "Soccer", 11: "Basketball", 12: "Tennis", 13: "Baseball", 14: "American Football",
  15: "Ice Hockey", 16: "Dota 2", 17: "Counter-Strike", 18: "League of Legends", 19: "Darts",
  20: "MMA", 21: "Boxing", 22: "Handball", 23: "Volleyball", 24: "Snooker", 25: "Table Tennis",
  26: "Rugby", 27: "Cricket", 29: "Futsal", 61: "Valorant",
};

const $ = (s) => document.querySelector(s);
const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v == null ? d : v;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
  del(k) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  },
};

let pw = store.get("arb_pw", "");
let data = null;
let filter = store.get("arb_filter", "all");
let tab = store.get("arb_tab", "arbs");
let pollTimer = null;
let settingsDirty = false;

// ------------------------------------------------------------------ api

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${pw}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    showLogin("Wrong password.");
    throw new Error("unauthorized");
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}

// ------------------------------------------------------------------ helpers

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function ago(ms) {
  if (ms == null) return "never";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

function ageShort(sec) {
  if (sec == null) return "";
  if (sec < 60) return `${sec}s`;
  const m = Math.round(sec / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

function startsIn(sec, now) {
  if (!sec) return "";
  const diff = sec * 1000 - now;
  const when = new Date(sec * 1000);
  const hm = when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const day = when.toDateString() === new Date(now).toDateString() ? "today" : when.toLocaleDateString([], { weekday: "short", day: "numeric" });
  if (diff <= 0) return `started ${hm}`;
  const m = Math.round(diff / 60000);
  const rel = m < 90 ? `in ${m} min` : `in ${Math.round(m / 60)} h`;
  return `${day} ${hm} · ${rel}`;
}

const money = (x) => (Math.round(x * 100) / 100).toFixed(2);
const pct = (x) => `${x > 0 ? "+" : ""}${x.toFixed(2)}%`;
const total = () => Math.max(1, Number($("#total").value) || 100);

// ------------------------------------------------------------------ render

function render() {
  if (!data) return;
  const now = data.now;

  // header
  $("#demo-tag").hidden = !data.demo;
  const awake = $("#awake");
  const left = data.window.until - now;
  if (left > 0) {
    const m = Math.round(left / 60000);
    awake.textContent = `Live · ${m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`} left`;
    awake.className = "pill live";
  } else {
    awake.textContent = "Idle · sleeps soon";
    awake.className = "pill";
  }
  $("#last-scan").textContent = data.scan ? `Last scan ${ago(now - data.scan.finishedAt)}` : "No scan yet";
  $("#progress").hidden = !data.running;
  $("#progress-text").textContent = data.progress || "Scanning…";
  $("#scan-btn").disabled = data.running;
  $("#scan-btn").textContent = data.running ? "Scanning…" : "Scan";

  renderArbs(now);
  renderBoosted(now);
  renderSources(now);
  renderSettings(now);
}

function legRow(l, t) {
  const row = el("div", "leg");
  const left = el("div", "sel");
  left.append(el("span", null, l.selection));
  const book = el("span", `book${l.boosted ? " boosted" : ""}`, l.book + (l.ageSec != null ? ` · ${ageShort(l.ageSec)} old` : "") + (l.limit ? ` · max ${Math.round(l.limit)}` : ""));
  left.append(book);
  const price = el("div", "price", l.price.toFixed(2));
  if (l.oldPrice) {
    const wrap = el("div");
    wrap.append(price, el("span", "old", Number(l.oldPrice).toFixed(2)));
    row.append(left, wrap);
  } else row.append(left, price);
  const stake = el("div", "stake", money(t * l.share));
  stake.append(el("small", null, `→ ${money(t * l.share * l.price)}`));
  row.append(stake);
  return row;
}

function arbCard(a, now, { showNegative = false } = {}) {
  const t = total();
  const node = $("#arb-card").content.firstElementChild.cloneNode(true);
  const p = a.profitPct;
  const strong = p >= 1.5;
  node.classList.toggle("strong", strong && p > 0);
  node.classList.toggle("boost", a.boosted);
  node.classList.toggle("neg", p <= 0);
  const prof = node.querySelector(".profit");
  prof.textContent = a.complete ? pct(p) : "—";
  prof.classList.toggle("thin", p > 0 && p < 0.5);
  prof.classList.toggle("neg", p <= 0 || !a.complete);
  const ev = node.querySelector(".event");
  if (a.boosted) ev.append(el("span", "badge b", "BOOST"));
  if (a.source === "local") ev.append(el("span", "badge l", "SCRAPER"));
  if (a.boostedStale) ev.append(el("span", "badge s", "STALE"));
  if (a.sameBook) ev.append(el("span", "badge s", "ONE BOOK"));
  ev.append(document.createTextNode(a.event));
  const meta = [a.market, a.sport, a.tournament, startsIn(a.startTime, now)].filter(Boolean).join(" · ");
  node.querySelector(".meta").textContent = meta;
  const legs = node.querySelector(".legs");
  if (!a.complete || !a.legs.length) {
    legs.append(el("div", "leg dim", "Not every outcome has a price from your bookmakers."));
  } else {
    for (const l of a.legs) legs.append(legRow(l, t));
  }
  const foot = node.querySelector(".arb-foot");
  if (a.sameBook) foot.append(el("div", "note warn small", "All legs are at the same book. Boosts on both sides are usually only valid inside a multi, or will be voided — read the promo terms before betting."));
  if (a.complete && a.legs.length) {
    const ret = t / a.legs.reduce((s, l) => s + 1 / l.price, 0);
    foot.append(el("span", null, `Return ${money(ret)} on ${money(t)}`));
    if (a.maxTotal) foot.append(el("span", null, `Max total ≈ ${Math.floor(a.maxTotal)}`));
    if (p > 0 || showNegative) {
      const btn = el("button", "btn copy", "Copy slip");
      btn.addEventListener("click", () => copySlip(a, t, btn));
      foot.append(btn);
    }
  }
  return node;
}

async function copySlip(a, t, btn) {
  const lines = [
    `${a.event} — ${a.market} (${pct(a.profitPct)})`,
    ...a.legs.map((l) => `${l.selection}: ${l.price.toFixed(2)} @ ${l.book} — stake ${money(t * l.share)}`),
    `Re-check every price before betting. Place the boosted / riskier leg first.`,
  ].join("\n");
  try {
    await navigator.clipboard.writeText(lines);
    btn.textContent = "Copied";
  } catch {
    btn.textContent = "Copy failed";
  }
  setTimeout(() => (btn.textContent = "Copy slip"), 1500);
}

function renderArbs(now) {
  document.querySelectorAll("#arb-filter .chip").forEach((c) => c.classList.toggle("on", c.dataset.f === filter));
  const list = $("#arb-list");
  list.replaceChildren();
  let arbs = data.arbs;
  if (filter === "boosted") arbs = arbs.filter((a) => a.boosted);
  else if (filter === "oddspapi") arbs = arbs.filter((a) => a.source === "oddspapi");
  else if (filter === "local") arbs = arbs.filter((a) => a.source === "local");
  $("#badge-arbs").textContent = data.arbs.length ? String(data.arbs.length) : "";
  if (data.scan?.crash) list.append(el("div", "note warn", `Last scan crashed: ${data.scan.crash}. Check Sources.`));
  if (!arbs.length) {
    const msg = !data.scan
      ? "No scan yet — tap Scan. The first scan after the server wakes can take a minute."
      : filter === "boosted"
        ? "No boosted arbs right now. See the Boosted tab for how each boost compared."
        : "No arbitrage in the last scan. That's normal — real arbs are rare and short-lived.";
    list.append(el("div", "empty", msg));
    return;
  }
  for (const a of arbs) list.append(arbCard(a, now));
}

function renderBoosted(now) {
  const head = $("#boost-head");
  const b = data.boosted;
  if (!b) {
    head.className = "note";
    head.textContent = data.collector?.enabled
      ? "No boosted odds yet — the server collects them at the start of the next scan (takes a few minutes)."
      : "No boosted odds uploaded yet. On Stake, tap ⚡ → Cloud setup, then Scan ALL categories.";
  } else {
    head.className = b.fresh ? "note" : "note warn";
    head.textContent = `${b.count} boosted selections ${b.source === "server" ? "collected by the server" : "uploaded from your phone"} ${ago(now - b.uploadedAt)}.` + (b.fresh ? "" : " Too old — boosted alerts are paused until fresh data arrives.") +
      " Check each boost's terms: Stake marks these as multi-bet boosts, so some may only apply inside a multi, and most have a low max stake.";
  }
  const c = data.collector;
  $("#collector-box").hidden = !c?.available;
  if (c?.available) {
    const L = c.last;
    $("#collector-text").textContent = c.running
      ? "Collecting now…"
      : !c.enabled
        ? "Paused in Settings."
        : L
          ? `Last run ${ago(now - L.at)}: ${L.status === "ok" ? `${L.count} boosts` : L.status.replace(/_/g, " ")}` +
            (c.nextDueAt > now ? ` · next ${Math.round((c.nextDueAt - now) / 60000)} min` : " · runs with the next scan")
          : "Runs at the start of the next scan.";
    $("#collect-btn").disabled = c.running || data.running;
  }
  const list = $("#boost-list");
  list.replaceChildren();
  if (!data.boostedChecks.length) list.append(el("div", "empty", b ? "Nothing compared yet — run a scan." : "—"));
  for (const c of data.boostedChecks) list.append(arbCard(c, now, { showNegative: true }));

  const un = $("#boost-unmatched");
  un.replaceChildren();
  if (!data.unmatchedBoosted.length) un.append(el("div", "empty", "Every uploaded boost was compared."));
  for (const u of data.unmatchedBoosted.slice(0, 150)) {
    const card = el("div", "boost");
    const l1 = el("div", "line1");
    const name = el("div");
    name.append(el("div", null, u.label), el("div", "dim small", [u.match, u.category].filter(Boolean).join(" · ")));
    const odds = el("div", "odds");
    if (u.oldOdds) odds.append(el("s", null, Number(u.oldOdds).toFixed(2)));
    odds.append(el("b", null, Number(u.newOdds).toFixed(2)));
    l1.append(name, odds);
    card.append(l1, el("div", "why", u.reason));
    un.append(card);
  }
}

function renderSources(now) {
  const box = $("#health");
  box.replaceChildren();
  const order = { error: 0, warn: 1, off: 2, ok: 3 };
  const checks = [...data.health].sort((a, b) => order[a.level] - order[b.level]);
  const bad = checks.filter((c) => c.level === "error").length;
  const badge = $("#badge-health");
  badge.textContent = bad ? String(bad) : "";
  badge.className = bad ? "warn" : "";
  const names = { oddspapi: "OddsPapi", stake: "Stake boosted", collector: "Stake collector", local: "Local scrapers", server: "Server" };
  for (const c of checks) {
    const h = el("div", "health");
    h.append(el("span", `dot ${c.level}`));
    const t = el("div");
    t.append(el("div", "src", names[c.source] ?? c.source), el("div", "t", c.title));
    h.append(t);
    if (c.detail) h.append(el("div", "d", c.detail));
    box.append(h);
  }
  if (data.doctor) $("#doctor-out").textContent = `${data.doctor.text}\n\n— ${ago(now - data.doctor.at)}`;

  const st = $("#scan-stats");
  st.replaceChildren();
  const s = data.scan;
  const items = s
    ? [
        [s.stats.fixtures, "fixtures"],
        [s.stats.fixturesWithOdds, "with odds"],
        [s.stats.markets, "markets checked"],
        [Object.keys(s.stats.books).length, "books priced"],
        [Math.round((s.finishedAt - s.startedAt) / 1000) + "s", "scan time"],
        [s.errors.length, "errors"],
      ]
    : [["—", "no scan yet"]];
  for (const [v, k] of items) {
    const d = el("div", "stat");
    d.append(el("b", null, String(v)), el("span", null, k));
    st.append(d);
  }
  if (s?.usedFallback) st.append(el("div", "dim small", "Used slower per-fixture odds (main-odds endpoint not allowed for this key)."));
  $("#logs").textContent = data.logs.map((l) => `${new Date(l.at).toLocaleTimeString()} ${l.level === "info" ? "" : l.level.toUpperCase() + " "}${l.text}`).join("\n");
}

function renderSettings(now) {
  const left = data.window.until - now;
  $("#win-text").textContent = left > 0
    ? `Awake for another ${Math.round(left / 60000)} min, rescanning every ${data.settings.scanIntervalMin} min.${data.selfPing ? "" : " (Self-ping URL unknown — it may sleep sooner.)"}`
    : "Closed. The server sleeps about 15 minutes after the last visit. Tap Scan to wake it.";
  $("#alerts-state").textContent = data.alertsEnabled ? "on (ntfy)" : "off — set NTFY_TOPIC on the server";
  if (settingsDirty) return;
  const f = $("#settings");
  const s = data.settings;
  f.bookmakers.value = s.bookmakers.join(", ");
  for (const k of ["minProfit", "lookaheadHours", "minLeadMinutes", "maxFixturesPerSport", "scanIntervalMin", "windowHours"]) f[k].value = s[k];
  f.skipIntegerLines.checked = s.skipIntegerLines;
  f.alertBoostedOnly.checked = s.alertBoostedOnly;
  f.stakeCollector.checked = s.stakeCollector;
  f.stakeCategories.value = s.stakeCategories.join(", ");
  f.collectEveryMin.value = s.collectEveryMin;
  const box = $("#sports");
  box.replaceChildren();
  for (const [id, name] of Object.entries(SPORTS)) {
    const l = el("label");
    const cb = el("input");
    cb.type = "checkbox";
    cb.value = id;
    cb.checked = s.sports.includes(Number(id));
    cb.addEventListener("change", () => (settingsDirty = true));
    l.append(cb, document.createTextNode(name));
    box.append(l);
  }
}

// ------------------------------------------------------------------ actions

async function refresh() {
  try {
    data = await api("/api/state");
    render();
  } catch (e) {
    if (e.message !== "unauthorized") $("#last-scan").textContent = `Can't reach server (${e.message}) — it may be waking up…`;
  }
  schedule();
}

function schedule() {
  clearTimeout(pollTimer);
  const fast = data && (data.running || data.window.until > data.now);
  pollTimer = setTimeout(refresh, document.hidden ? 60_000 : fast ? (data.running ? 2000 : 15_000) : 30_000);
}

function showTab(name) {
  tab = name;
  store.set("arb_tab", name);
  for (const s of document.querySelectorAll(".tab")) s.hidden = s.id !== `tab-${name}`;
  for (const b of document.querySelectorAll(".tabs button")) b.classList.toggle("on", b.dataset.tab === name);
  window.scrollTo(0, 0);
}

function showLogin(msg) {
  $("#app").hidden = true;
  $("#login").hidden = false;
  $("#login-err").hidden = !msg;
  $("#login-err").textContent = msg ?? "";
  clearTimeout(pollTimer);
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  pw = $("#login-pw").value;
  try {
    data = await api("/api/state");
    store.set("arb_pw", pw);
    $("#login").hidden = true;
    $("#app").hidden = false;
    render();
    schedule();
  } catch (err) {
    if (err.message !== "unauthorized") showLogin(err.message);
  }
});

$("#scan-btn").addEventListener("click", async () => {
  $("#scan-btn").disabled = true;
  try {
    await api("/api/scan", { method: "POST" });
  } catch {
    /* surfaced by refresh */
  }
  setTimeout(refresh, 400);
});

$("#arb-filter").addEventListener("click", (e) => {
  const c = e.target.closest(".chip");
  if (!c) return;
  filter = c.dataset.f;
  store.set("arb_filter", filter);
  render();
});

$("#total").value = store.get("arb_total", "100");
$("#total").addEventListener("input", () => {
  store.set("arb_total", $("#total").value);
  render();
});

for (const b of document.querySelectorAll(".tabs button")) b.addEventListener("click", () => showTab(b.dataset.tab));

$("#doctor-btn").addEventListener("click", async () => {
  const btn = $("#doctor-btn");
  btn.disabled = true;
  btn.textContent = "Thinking…";
  try {
    const r = await api("/api/doctor", { method: "POST" });
    $("#doctor-out").textContent = r.doctor?.text ?? "No reply.";
    await refresh();
  } catch (e) {
    $("#doctor-out").textContent = `Failed: ${e.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Diagnose";
  }
});

$("#settings").addEventListener("input", () => (settingsDirty = true));
$("#settings").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    bookmakers: f.bookmakers.value,
    sports: [...document.querySelectorAll("#sports input:checked")].map((c) => c.value).join(","),
    skipIntegerLines: f.skipIntegerLines.checked,
    alertBoostedOnly: f.alertBoostedOnly.checked,
    stakeCollector: f.stakeCollector.checked,
    stakeCategories: f.stakeCategories.value,
    collectEveryMin: f.collectEveryMin.value,
  };
  for (const k of ["minProfit", "lookaheadHours", "minLeadMinutes", "maxFixturesPerSport", "scanIntervalMin", "windowHours"]) body[k] = f[k].value;
  try {
    const r = await api("/api/settings", { method: "POST", body });
    settingsDirty = false;
    $("#settings-msg").textContent = r.rejected.length ? `Saved. Ignored invalid: ${r.rejected.join(", ")}` : "Saved. Next scan uses these.";
    await refresh();
  } catch (err) {
    $("#settings-msg").textContent = `Not saved: ${err.message}`;
  }
});

$("#collect-btn").addEventListener("click", async () => {
  $("#collect-btn").disabled = true;
  try {
    await api("/api/collect", { method: "POST" });
  } catch (e) {
    $("#collector-text").textContent = e.message;
  }
  setTimeout(refresh, 400);
});

$("#win-extend").addEventListener("click", async () => {
  await api("/api/window", { method: "POST", body: { action: "extend", hours: 2 } }).catch(() => {});
  refresh();
});
$("#win-stop").addEventListener("click", async () => {
  await api("/api/window", { method: "POST", body: { action: "stop" } }).catch(() => {});
  refresh();
});
$("#logout").addEventListener("click", () => {
  store.del("arb_pw");
  pw = "";
  showLogin();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && pw) refresh();
});

// ------------------------------------------------------------------ boot

showTab(tab);
if (!pw) showLogin();
else {
  $("#app").hidden = false;
  refresh();
}
