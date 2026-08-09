/* Arb console UI. Vanilla — no build step, no dependencies. */

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
};

const state = {
  view: "providers",
  matchScope: "fresh", // fresh | old | all
  arbScope: "fresh",
  providers: [],
  runs: [],
  outputDir: "",
  matches: null,
  arbs: null,
  loading: false,
};

// ---------------------------------------------------------------- api

async function api(path, options) {
  const res = await fetch(path, {
    ...options,
    headers: options?.body ? { "content-type": "application/json" } : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `${path} failed (${res.status})`);
  return data;
}

function banner(message) {
  $("#banner").replaceChildren(
    message
      ? el("div", { class: "err-banner" },
          el("span", {}, message),
          el("button", {
            class: "btn sm",
            onclick: () => navigator.clipboard.writeText(message),
          }, "copy"),
          el("button", { class: "btn sm", onclick: () => banner(null) }, "dismiss"))
      : "",
  );
}

async function refresh() {
  try {
    const data = await api("/api/state");
    state.providers = data.providers;
    state.runs = data.runs;
    state.outputDir = data.outputDir;
    $("#outdir-label").textContent = `out: ${data.outputDir.replace(/^.*\//, "")}/`;
    $("#c-books").textContent = data.providers.filter((p) => p.enabled).length || "";
    render();
  } catch (err) {
    banner(err.message);
  }
}

// ---------------------------------------------------------------- views

function render() {
  const view = $("#view");
  const map = { providers: viewProviders, matches: viewMatches, arbs: viewArbs, add: viewAdd };
  view.replaceChildren(map[state.view]());
  for (const b of document.querySelectorAll("#nav button")) {
    b.classList.toggle("on", b.dataset.view === state.view);
  }
}

/* ---- books ---- */

function viewProviders() {
  const anyRunning = state.providers.some((p) => p.running);
  return el("div", {},
    el("div", { class: "head" }, el("h1", {}, "Books")),
    el("p", { class: "sub" },
      "Mirror domains rotate constantly. When a book returns nothing, update its URL here — no code edit needed."),
    el("div", { class: "toolbar" },
      el("button", {
        class: "btn primary",
        onclick: () => startScrape([]),
        disabled: anyRunning ? "" : null,
      }, anyRunning ? "scraping…" : "Scrape all enabled"),
      el("button", { class: "btn", onclick: refresh }, "Refresh"),
    ),
    el("div", { class: "grid" }, state.providers.map(providerCard)),
  );
}

function providerCard(p) {
  const urlInputs = Object.entries(p.urls).map(([key, value]) =>
    el("div", { class: "field" },
      el("label", {}, key),
      el("input", {
        value,
        "data-key": key,
        spellcheck: "false",
        oninput: (e) => e.target.classList.add("dirty"),
      }),
    ),
  );

  const card = el("div", { class: `card${p.enabled ? "" : " off"}` },
    el("div", { class: "card-top" },
      el("div", {},
        el("h3", {}, p.label),
        el("span", { class: "id" }, `${p.id} · ${p.dir}/${p.runner}`),
      ),
      el("span", { class: `dot ${p.running ? "running" : p.ready ? "idle" : "blocked"}` }),
    ),
    ...urlInputs,
    p.note ? el("div", { class: "note" }, p.note) : null,
    p.missing?.length ? el("div", { class: "warn" }, `missing: ${p.missing.join(", ")}`) : null,
    !p.protocol
      ? el("div", { class: "warn" },
          p.ready
            ? "legacy runner: no league picker until an agent adds console_api.py"
            : "no scraper yet — Scrape will have the agent write one")
      : null,
    p.agent ? agentStatus(p.agent) : null,
    el("div", { class: "card-actions" },
      el("button", {
        class: "btn primary sm",
        disabled: p.running || p.agent?.status === "running" ? "" : null,
        onclick: () => openPicker(p),
      }, p.running ? "running…" : "Scrape"),
      el("button", {
        class: "btn sm",
        disabled: p.agent?.status === "running" ? "" : null,
        title: "Diagnose and fix this book with Claude Sonnet",
        onclick: async () => {
          try {
            await api("/api/doctor", { method: "POST", body: JSON.stringify({ id: p.id }) });
            openDrawer(true);
            refresh();
          } catch (err) {
            banner(err.message);
          }
        },
      }, "Doctor"),
      p.running
        ? el("button", { class: "btn danger sm", onclick: () => cancel(p.id) }, "Stop")
        : null,
      el("button", {
        class: "btn sm",
        onclick: async (e) => {
          const urls = {};
          for (const input of card.querySelectorAll("input[data-key]")) {
            urls[input.dataset.key] = input.value.trim();
          }
          try {
            await api("/api/provider", { method: "POST", body: JSON.stringify({ id: p.id, urls }) });
            for (const i of card.querySelectorAll("input")) i.classList.remove("dirty");
            e.target.textContent = "saved";
            setTimeout(() => (e.target.textContent = "Save URLs"), 1200);
            banner(null);
          } catch (err) {
            banner(err.message);
          }
        },
      }, "Save URLs"),
      el("button", {
        class: "btn sm",
        onclick: async () => {
          try {
            await api("/api/provider", {
              method: "POST",
              body: JSON.stringify({ id: p.id, enabled: !p.enabled }),
            });
            refresh();
          } catch (err) {
            banner(err.message);
          }
        },
      }, p.enabled ? "Disable" : "Enable"),
      lastRunLabel(p.id),
    ),
  );
  return card;
}

function agentStatus(agent) {
  if (agent.status === "running") {
    return el("div", { class: "agent-box running" },
      el("span", { class: "dot running" }),
      `${agent.kind === "doctor" ? "Doctor" : "Implementer"} working… (${agent.model})`);
  }
  const needsHuman = agent.needsHuman;
  return el("div", { class: `agent-box ${needsHuman ? "needs" : agent.status}` },
    el("div", { class: "agent-head" },
      el("span", { class: `dot ${agent.status}` }),
      `${agent.kind === "doctor" ? "Doctor" : "Implementer"} ${needsHuman ? "needs you" : agent.status}`,
      el("button", {
        class: "btn sm",
        onclick: () => navigator.clipboard.writeText(agent.summary),
      }, "copy")),
    el("pre", { class: "agent-summary" }, agent.summary || "(no summary)"));
}

function lastRunLabel(providerId) {
  const run = state.runs.find((r) => r.providerId === providerId);
  if (!run) return el("span", { class: "status-line" }, "never run");
  const when = run.endedAt ?? run.startedAt;
  const secs = run.endedAt ? Math.round((run.endedAt - run.startedAt) / 1000) : null;
  const label = run.status === "empty" ? "no data — check URL" : run.status;
  return el("span", { class: "status-line" },
    el("span", { class: `dot ${run.status}` }),
    `${label}${run.saved ? ` · ${run.saved} saved` : ""}${secs !== null ? ` · ${secs}s` : ""} · ${timeAgo(when)}`,
  );
}

/* ---- matches ---- */

async function loadMatches() {
  state.loading = true;
  render();
  try {
    state.matches = await api("/api/matches");
    $("#c-matches").textContent = state.matches.matches.length || "";
  } catch (err) {
    banner(err.message);
  }
  state.loading = false;
  render();
}

function viewMatches() {
  if (!state.matches && !state.loading) loadMatches();
  const data = state.matches;
  const books = [...new Set(state.providers.map((p) => p.id))];
  const all = data?.matches ?? [];
  const counts = {
    fresh: all.filter((m) => m.fresh).length,
    old: all.filter((m) => !m.fresh).length,
    all: all.length,
  };
  const rows = applyScope(all, state.matchScope);

  return el("div", {},
    el("div", { class: "head" }, el("h1", {}, "Matches")),
    el("p", { class: "sub" },
      "Every scraped odds file, grouped by match. A match needs two or more books before it can produce an arb."),
    el("div", { class: "toolbar" },
      data ? scopeTabs(state.matchScope, counts, (s) => { state.matchScope = s; render(); }) : null,
      el("button", { class: "btn", onclick: loadMatches }, "Rescan"),
      data ? el("span", { class: "status-line" }, data.dir.replace(/^.*\//, "")) : null,
    ),
    !data
      ? el("div", { class: "empty" }, "Scanning…")
      : all.length === 0
        ? el("div", { class: "empty" }, "No odds files yet. Scrape a book first.")
        : rows.length === 0 && state.matchScope === "fresh"
          ? staleNotice("matches", counts.old, () => { state.matchScope = "old"; render(); })
          : el("table", {},
              el("thead", {}, el("tr", {},
                el("th", {}, "match"),
                el("th", {}, "books"),
                el("th", { class: "num" }, "count"),
                el("th", { class: "num" }, "scraped"),
              )),
              el("tbody", {}, rows.map((m) =>
                el("tr", { class: m.fresh ? "" : "stale" },
                  el("td", {}, m.match, m.fresh ? null : el("span", { class: "tag-old" }, "old")),
                  el("td", {}, books.map((b) =>
                    el("span", { class: `pill ${m.books[b] ? "has" : ""}` }, b))),
                  el("td", { class: "num" }, m.bookCount),
                  el("td", { class: "num" }, ageLabel(m)),
                ))),
            ),
  );
}

/* ---- arbs ---- */

async function loadArbs() {
  state.loading = true;
  render();
  try {
    state.arbs = await api("/api/arbs");
    $("#c-arbs").textContent = state.arbs.arbs.length || "";
  } catch (err) {
    banner(err.message);
  }
  state.loading = false;
  render();
}

function viewArbs() {
  if (!state.arbs && !state.loading) loadArbs();
  const data = state.arbs;
  const all = data?.arbs ?? [];
  const counts = {
    fresh: all.filter((a) => a.fresh).length,
    old: all.filter((a) => !a.fresh).length,
    all: all.length,
  };
  const rows = applyScope(all, state.arbScope);

  return el("div", {},
    el("div", { class: "head" }, el("h1", {}, "Arbitrage")),
    el("p", { class: "sub" },
      "Two-way over/under pairs where the combined implied probability is under 100%. An arb is only as fresh as the odds behind it."),
    el("div", { class: "toolbar" },
      data ? scopeTabs(state.arbScope, counts, (s) => { state.arbScope = s; render(); }) : null,
      el("button", { class: "btn primary", onclick: loadArbs }, "Run finder"),
      data ? el("span", { class: "status-line" },
        `${data.scanned} files · ${data.groups.length} paired matches`) : null,
    ),
    state.arbScope !== "fresh" && rows.length
      ? el("div", { class: "err-banner" },
          el("span", {}, "These come from odds that are no longer current — re-scrape before staking anything on them."))
      : null,
    !data
      ? el("div", { class: "empty" }, "Running arb_finder…")
      : all.length === 0
        ? el("div", { class: "empty" }, "No arbs in the current data.")
        : rows.length === 0 && state.arbScope === "fresh"
          ? staleNotice("arbs", counts.old, () => { state.arbScope = "old"; render(); })
          : el("table", {},
            el("thead", {}, el("tr", {},
              el("th", { class: "num" }, "profit"),
              el("th", {}, "match"),
              el("th", {}, "market"),
              el("th", { class: "num" }, "line"),
              el("th", {}, "over"),
              el("th", {}, "under"),
              el("th", { class: "num" }, "stake o/u"),
              el("th", { class: "num" }, "odds from"),
            )),
            el("tbody", {}, rows.slice(0, 300).map((a) =>
              el("tr", { class: a.fresh ? "" : "stale" },
                el("td", { class: `num ${a.profit_pct >= 1.5 ? "profit-strong" : a.profit_pct >= 0.5 ? "profit-mid" : "profit-thin"}` },
                  `${a.profit_pct > 0 ? "+" : ""}${a.profit_pct.toFixed(2)}%`),
                el("td", {}, a.match, a.fresh ? null : el("span", { class: "tag-old" }, "old")),
                el("td", {}, a.market),
                el("td", { class: "num" }, a.line),
                el("td", {}, `${a.over_odds} `, el("span", { class: "pill has" }, a.over_book)),
                el("td", {}, `${a.under_odds} `, el("span", { class: "pill has" }, a.under_book)),
                el("td", { class: "num" }, `${a.stake_over_pct}/${a.stake_under_pct}`),
                el("td", { class: "num" }, ageLabel(a)),
              ))),
          ),
  );
}

/* ---- add book ---- */

function viewAdd() {
  const idIn = el("input", { placeholder: "pinnacle", spellcheck: "false" });
  const labelIn = el("input", { placeholder: "Pinnacle", spellcheck: "false" });
  const urlIn = el("input", { placeholder: "https://www.pinnacle.com/en/soccer", spellcheck: "false" });
  const out = el("div", {});

  return el("div", {},
    el("div", { class: "head" }, el("h1", {}, "Add a book")),
    el("p", { class: "sub" },
      "Scaffolds <id>-scraper/agent_run.py and registers it. You implement the fetch; the console handles running it, streaming progress, and feeding the finder."),
    el("div", { class: "card", style: "max-width:640px" },
      el("div", { class: "form-row" },
        el("div", { class: "field" }, el("label", {}, "ID (becomes _odds_<id>.json)"), idIn),
        el("div", { class: "field" }, el("label", {}, "LABEL"), labelIn),
      ),
      el("div", { class: "field" }, el("label", {}, "BASE URL"), urlIn),
      el("div", { class: "card-actions" },
        el("button", {
          class: "btn primary",
          onclick: async () => {
            try {
              const r = await api("/api/provider/new", {
                method: "POST",
                body: JSON.stringify({
                  id: idIn.value.trim().toLowerCase(),
                  label: labelIn.value.trim(),
                  url: urlIn.value.trim(),
                }),
              });
              out.replaceChildren(el("div", { class: "note" },
                `Created ${r.runner}${r.created ? "" : " (already existed, left alone)"}. `,
                `Set its URL with ${r.envVar}. Implement the TODO, then Scrape it from Books.`));
              idIn.value = labelIn.value = urlIn.value = "";
              banner(null);
              refresh();
            } catch (err) {
              banner(err.message);
            }
          },
        }, "Create scraper"),
      ),
      out,
    ),
  );
}

// ---------------------------------------------------------------- scrape picker

/**
 * Two-phase scrape: choose one of the book's OWN leagues, list that league's
 * real matches from the site, then scrape odds for just the ones you pick.
 * Names and links differ per league, so nothing is ever guessed.
 */
function openPicker(provider) {
  const body = el("div", { class: "modal-body" }, el("div", { class: "empty" }, "Loading leagues…"));
  const title = el("h2", {}, `Scrape ${provider.label}`);
  const step = el("div", { class: "modal-step" }, "step 1 of 2 · choose a league");
  const modal = el("div", { class: "modal-backdrop", onclick: (e) => { if (e.target === modal) close(); } },
    el("div", { class: "modal" },
      el("div", { class: "modal-head" }, title, step,
        el("button", { class: "btn sm", onclick: () => close() }, "close")),
      body));
  document.body.append(modal);
  const close = () => modal.remove();

  const fail = (message, extra) =>
    body.replaceChildren(el("div", { class: "err-banner" }, el("span", {}, message)), extra ?? "");

  api("/api/leagues", { method: "POST", body: JSON.stringify({ id: provider.id }) })
    .then((data) => pickLeague(data.leagues ?? []))
    .catch(async (err) => {
      // No console_api.py yet → offer to have the agent write it.
      fail(err.message,
        el("button", {
          class: "btn primary",
          onclick: async () => {
            await api("/api/implement", { method: "POST", body: JSON.stringify({ id: provider.id }) })
              .catch((e) => banner(e.message));
            close();
            openDrawer(true);
          },
        }, `Have the agent implement ${provider.label}`));
    });

  function pickLeague(leagues) {
    step.textContent = `step 1 of 2 · ${leagues.length} leagues this book actually has`;
    body.replaceChildren(
      el("div", { class: "league-grid" }, leagues.map((lg) =>
        el("button", { class: "league", onclick: () => loadMatchList(lg) },
          el("span", {}, lg.name),
          el("span", { class: "league-path" }, lg.path)))),
    );
  }

  function loadMatchList(lg) {
    step.textContent = `step 2 of 2 · reading ${lg.name} from the site…`;
    body.replaceChildren(el("div", { class: "empty" },
      `Fetching match names for ${lg.name}. This opens a browser, so give it a moment — watch the console below for progress.`));
    openDrawer(true);
    api("/api/list-matches", { method: "POST", body: JSON.stringify({ id: provider.id, league: lg.key }) })
      .then((data) => pickMatches(lg, data.matches ?? []))
      .catch((err) => fail(err.message,
        el("button", {
          class: "btn",
          onclick: async () => {
            await api("/api/doctor", { method: "POST", body: JSON.stringify({ id: provider.id }) })
              .catch((e) => banner(e.message));
            close();
          },
        }, "Run the doctor on this")));
  }

  function pickMatches(lg, matches) {
    if (matches.length === 0) {
      fail(`No matches found in ${lg.name}. The league may be out of season, or the site's markup changed.`,
        el("button", {
          class: "btn",
          onclick: async () => {
            await api("/api/doctor", { method: "POST", body: JSON.stringify({ id: provider.id }) })
              .catch((e) => banner(e.message));
            close();
          },
        }, "Run the doctor"));
      return;
    }
    const picked = new Set(matches.map((mt) => mt.id));
    step.textContent = `step 2 of 2 · ${lg.name}`;

    const list = el("div", { class: "match-list" }, matches.map((mt) =>
      el("label", { class: "match-row" },
        el("input", {
          type: "checkbox",
          checked: "",
          onchange: (e) => {
            e.target.checked ? picked.add(mt.id) : picked.delete(mt.id);
            countLabel.textContent = `${picked.size} of ${matches.length} selected`;
          },
        }),
        el("span", {}, mt.name))));

    const countLabel = el("span", { class: "status-line" }, `${picked.size} of ${matches.length} selected`);
    const setAll = (on) => {
      picked.clear();
      for (const cb of list.querySelectorAll("input")) cb.checked = on;
      if (on) for (const mt of matches) picked.add(mt.id);
      countLabel.textContent = `${picked.size} of ${matches.length} selected`;
    };

    body.replaceChildren(
      el("div", { class: "modal-tools" },
        el("button", { class: "btn sm", onclick: () => setAll(true) }, "All"),
        el("button", { class: "btn sm", onclick: () => setAll(false) }, "None"),
        countLabel),
      list,
      el("div", { class: "modal-foot" },
        el("button", { class: "btn sm", onclick: () => pickLeague0() }, "← leagues"),
        el("button", {
          class: "btn primary",
          onclick: async () => {
            if (picked.size === 0) return banner("Select at least one match.");
            close();
            openDrawer(true);
            try {
              const r = await api("/api/scrape", {
                method: "POST",
                body: JSON.stringify({
                  ids: [provider.id],
                  league: lg.key,
                  leagueName: lg.name,
                  matchIds: [...picked],
                }),
              });
              if (r.failed?.length) banner(r.failed.map((f) => `${f.id}: ${f.error}`).join(" · "));
              refresh();
            } catch (err) {
              banner(err.message);
            }
          },
        }, "Scrape selected")),
    );
  }

  function pickLeague0() {
    step.textContent = "step 1 of 2 · choose a league";
    api("/api/leagues", { method: "POST", body: JSON.stringify({ id: provider.id }) })
      .then((d) => pickLeague(d.leagues ?? []))
      .catch((e) => fail(e.message));
  }
}

// ---------------------------------------------------------------- actions

async function startScrape(ids) {
  try {
    const r = await api("/api/scrape", { method: "POST", body: JSON.stringify({ ids }) });
    if (r.failed?.length) {
      banner(r.failed.map((f) => `${f.id}: ${f.error}`).join(" · "));
    } else {
      banner(null);
    }
    openDrawer(true);
    refresh();
  } catch (err) {
    banner(err.message);
  }
}

async function cancel(id) {
  try {
    await api("/api/cancel", { method: "POST", body: JSON.stringify({ id }) });
    refresh();
  } catch (err) {
    banner(err.message);
  }
}

// ---------------------------------------------------------------- live log

const logEl = () => $("#log");

function appendLog(providerId, line) {
  const box = logEl();
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  box.append(el("div", {},
    el("span", { class: "t" }, new Date(line.at).toLocaleTimeString()),
    el("span", { class: "who" }, providerId),
    el("span", { class: line.stream === "stderr" ? "err" : "" }, line.text),
  ));
  while (box.childElementCount > 800) box.firstChild.remove();
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function openDrawer(open) {
  const d = $("#drawer");
  d.classList.toggle("open", open);
  d.classList.toggle("collapsed", !open);
  $("#drawer-hint").textContent = open ? "click to collapse" : "click to expand";
}

function connectEvents() {
  const src = new EventSource("/api/events");
  src.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "line") appendLog(msg.providerId, msg.line);
    if (msg.type === "agent") {
      $("#drawer-dot").className = `dot ${msg.agent.status}`;
      $("#drawer-status").textContent =
        msg.agent.status === "running"
          ? `${msg.agent.kind} agent working on ${msg.providerId}…`
          : `${msg.agent.kind} agent ${msg.agent.status} — see the card for its report`;
      refresh();
    }
    if (msg.type === "run") {
      const running = msg.run.status === "running";
      $("#drawer-dot").className = `dot ${msg.run.status}`;
      $("#drawer-status").textContent = running
        ? `${msg.run.label} scraping…`
        : msg.run.status === "empty"
          ? `${msg.run.label} finished but saved nothing — its URL is probably dead`
          : `${msg.run.label} ${msg.run.status}${msg.run.saved ? ` · ${msg.run.saved} files` : ""}`;
      refresh();
      if (!running && state.view === "matches") loadMatches();
    }
  };
  src.onerror = () => {
    $("#drawer-status").textContent = "console disconnected — is server.mjs running?";
    $("#drawer-dot").className = "dot failed";
  };
}

// ---------------------------------------------------------------- util

/** Fresh = scraped today. Yesterday and older are "old" and shown separately. */
function ageLabel(row) {
  if (row.ageDays === undefined || row.ageDays === null) return "unknown";
  if (row.ageDays <= 0) return "today";
  if (row.ageDays === 1) return "yesterday";
  return `${row.ageDays}d old`;
}

function scopeTabs(current, counts, onPick) {
  const tab = (key, label, n) =>
    el("button", {
      class: `tab${current === key ? " on" : ""}`,
      onclick: () => onPick(key),
    }, label, n === undefined ? "" : el("span", { class: "tab-n" }, String(n)));
  return el("div", { class: "tabs" },
    tab("fresh", "Today", counts.fresh),
    tab("old", "Older", counts.old),
    tab("all", "All", counts.all),
  );
}

function applyScope(rows, scope) {
  if (scope === "fresh") return rows.filter((r) => r.fresh);
  if (scope === "old") return rows.filter((r) => !r.fresh);
  return rows;
}

function staleNotice(kind, olderCount, onSeeOlder) {
  return el("div", { class: "empty" },
    `Nothing scraped today. `,
    olderCount
      ? el("button", { class: "btn sm", onclick: onSeeOlder }, `see ${olderCount} older ${kind}`)
      : "Scrape a book to get started.",
  );
}

function timeAgo(ts) {
  if (!ts) return "—";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// ---------------------------------------------------------------- boot

$("#nav").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  state.view = btn.dataset.view;
  render();
});

$("#drawer-bar").addEventListener("click", () => {
  openDrawer(!$("#drawer").classList.contains("open"));
});

connectEvents();
refresh();
