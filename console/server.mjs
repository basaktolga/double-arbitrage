#!/usr/bin/env node
/**
 * Arb console — local control panel for the double-arbitrage scrapers.
 *
 *   node console/server.mjs      → http://127.0.0.1:8790
 *
 * Zero dependencies. Loopback only: it spawns processes and edits config, so it
 * must never be reachable from the network.
 */

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runAgent, doctorPrompt, implementPrompt, MODEL } from "./agent.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const PUBLIC = path.join(HERE, "public");
const CONFIG = path.join(HERE, "providers.json");
const ARB_DIR = path.join(REPO, "json-2file-arbfinder");
const PORT = Number(process.env.PORT ?? 8790);
const HOST = "127.0.0.1";

// ---------------------------------------------------------------- config

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG, "utf8"));
}

async function writeConfig(cfg) {
  await fsp.writeFile(CONFIG, JSON.stringify(cfg, null, 2) + "\n");
}

function outputDir(cfg) {
  return path.resolve(REPO, cfg.outputDir ?? "json-2file-arbfinder");
}

// ---------------------------------------------------------------- run registry

/** id → { id, providerId, status, startedAt, endedAt, lines[], exitCode } */
const runs = new Map();
const active = new Map(); // providerId → child process
const clients = new Set(); // SSE subscribers
let runSeq = 0;

function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(payload);
}

function pushLine(run, stream, text) {
  const line = { at: Date.now(), stream, text };
  run.lines.push(line);
  if (run.lines.length > 2000) run.lines.shift();
  broadcast({ type: "line", runId: run.id, providerId: run.providerId, line });
}

/** Path to a provider's console protocol script, if it has one. */
function consoleApi(provider) {
  return path.resolve(REPO, provider.dir, "console_api.py");
}

export function supportsProtocol(provider) {
  return fs.existsSync(consoleApi(provider));
}

function providerPython(provider) {
  return path.resolve(REPO, provider.dir, provider.python);
}

/**
 * Run one console_api.py subcommand and return the JSON it emitted after the
 * CONSOLE_JSON marker. Progress lines are streamed to the drawer meanwhile.
 */
function runProtocol(provider, args, { timeoutMs = 5 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const cwd = path.resolve(REPO, provider.dir);
    const python = providerPython(provider);
    if (!fs.existsSync(python)) return reject(new Error(`python missing: ${provider.python}`));
    if (!fs.existsSync(consoleApi(provider))) {
      return reject(new Error(`${provider.label} has no console_api.py yet`));
    }

    const child = spawn(python, ["console_api.py", ...args], {
      cwd,
      env: { ...process.env, ...provider.urls, PYTHONUNBUFFERED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    protocolRuns.set(provider.id, child);

    let payload = null;
    let capturing = false;
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }, timeoutMs);

    lineReader(child.stdout, (text) => {
      if (capturing && payload === null) {
        try {
          payload = JSON.parse(text);
        } catch {
          /* not the payload after all */
        }
        capturing = false;
        return;
      }
      if (text.trim() === "CONSOLE_JSON") {
        capturing = true;
        return;
      }
      broadcast({ type: "line", providerId: provider.id, line: { at: Date.now(), stream: "stdout", text } });
    });
    lineReader(child.stderr, (text) => {
      stderr += text + "\n";
      broadcast({ type: "line", providerId: provider.id, line: { at: Date.now(), stream: "stderr", text } });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      protocolRuns.delete(provider.id);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      protocolRuns.delete(provider.id);
      if (payload) return resolve(payload);
      reject(new Error(stderr.trim().split("\n").slice(-3).join(" ") || `exited ${code} without data`));
    });
  });
}

const protocolRuns = new Map();

function startScrape(provider, cfg, options = {}) {
  if (active.has(provider.id)) throw new Error(`${provider.label} is already running`);

  const cwd = path.resolve(REPO, provider.dir);
  if (!fs.existsSync(cwd)) throw new Error(`scraper directory missing: ${provider.dir}`);
  const python = path.resolve(cwd, provider.python);
  if (!fs.existsSync(python)) {
    throw new Error(`python not found for ${provider.label}: ${provider.python} (create its venv)`);
  }
  const useProtocol = supportsProtocol(provider) && options.league;
  const runner = useProtocol ? "console_api.py" : provider.runner;
  if (!fs.existsSync(path.resolve(cwd, runner))) {
    throw new Error(`runner missing: ${provider.dir}/${runner}`);
  }

  const out = outputDir(cfg);
  fs.mkdirSync(out, { recursive: true });

  const run = {
    id: `r${++runSeq}`,
    providerId: provider.id,
    label: provider.label,
    status: "running",
    startedAt: Date.now(),
    endedAt: null,
    exitCode: null,
    saved: 0,
    lines: [],
  };
  runs.set(run.id, run);

  // Two-phase mode: scrape only the chosen league, and only the chosen matches.
  const args = useProtocol
    ? ["console_api.py", "odds", out, options.league, (options.matchIds ?? []).join(",")]
    : [provider.runner, out];
  run.league = options.leagueName ?? options.league ?? null;
  run.matchCount = options.matchIds?.length ?? null;

  const child = spawn(python, args, {
    cwd,
    env: { ...process.env, ...provider.urls, PYTHONUNBUFFERED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // own process group, so cancel kills playwright's children too
  });
  active.set(provider.id, { child, run });
  broadcast({ type: "run", run: summary(run) });

  lineReader(child.stdout, (text) => {
    if (/\bsaved\b/i.test(text)) run.saved += 1;
    pushLine(run, "stdout", text);
  });
  lineReader(child.stderr, (text) => pushLine(run, "stderr", text));

  child.on("error", (err) => {
    pushLine(run, "stderr", `[console] spawn failed: ${err.message}`);
  });
  child.on("close", (code, signal) => {
    active.delete(provider.id);
    run.endedAt = Date.now();
    run.exitCode = code;
    // Exit 0 with nothing saved almost always means a dead mirror domain, not
    // success — surface it as "empty" so the URL gets a second look.
    run.status = run.cancelled
      ? "cancelled"
      : code === 0
        ? run.saved > 0
          ? "done"
          : "empty"
        : "failed";
    if (signal && !run.cancelled) run.status = "failed";
    broadcast({ type: "run", run: summary(run) });

    // A failed scrape is exactly when you want the doctor, so run it unprompted.
    if ((run.status === "failed" || run.status === "empty") && !run.cancelled) {
      void runDoctor(provider, run).catch((err) => {
        pushLine(run, "stderr", `[doctor] ${err.message}`);
      });
    }
  });

  return run;
}

function cancelScrape(providerId) {
  const entry = active.get(providerId);
  if (!entry) throw new Error("not running");
  entry.run.cancelled = true;
  try {
    process.kill(-entry.child.pid, "SIGTERM");
  } catch {
    entry.child.kill("SIGTERM");
  }
  setTimeout(() => {
    if (active.has(providerId)) {
      try {
        process.kill(-entry.child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }, 5000);
}

function lineReader(stream, onLine) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf("\n")) !== -1) {
      const text = buffer.slice(0, i).replace(/\r$/, "");
      buffer = buffer.slice(i + 1);
      if (text.trim() !== "") onLine(text);
    }
  });
  stream.on("end", () => {
    if (buffer.trim() !== "") onLine(buffer);
  });
}

function summary(run) {
  return {
    id: run.id,
    providerId: run.providerId,
    label: run.label,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    exitCode: run.exitCode,
    saved: run.saved,
    lineCount: run.lines.length,
    league: run.league ?? null,
    matchCount: run.matchCount ?? null,
  };
}

// ---------------------------------------------------------------- agents

/** id → { kind, status, summary, startedAt } */
const agentRuns = new Map();

function agentBusy(providerId) {
  return agentRuns.get(providerId)?.status === "running";
}

async function runAgentFor(provider, kind, prompt) {
  if (agentBusy(provider.id)) throw new Error(`an agent is already working on ${provider.label}`);
  const cwd = path.resolve(REPO, provider.dir);
  fs.mkdirSync(cwd, { recursive: true });

  const record = { kind, status: "running", summary: "", startedAt: Date.now(), model: MODEL };
  agentRuns.set(provider.id, record);
  broadcast({ type: "agent", providerId: provider.id, agent: record });

  const emit = (stream, text) =>
    broadcast({ type: "line", providerId: provider.id, line: { at: Date.now(), stream, text } });

  emit("stdout", `[${kind}] starting on ${provider.label} (${MODEL})`);
  const result = await runAgent({ prompt, cwd, onLine: emit });

  record.status = result.ok ? "done" : "failed";
  record.summary = result.summary;
  record.endedAt = Date.now();
  record.needsHuman = /ACTION NEEDED:\s*(?!none)\S/i.test(result.summary);
  broadcast({ type: "agent", providerId: provider.id, agent: record });
  for (const text of result.summary.split("\n")) {
    if (text.trim()) emit("stdout", `[${kind}] ${text.trim()}`);
  }
  return record;
}

function runDoctor(provider, run) {
  const logTail = (run?.lines ?? []).slice(-40).map((l) => l.text).join("\n") || "(no output captured)";
  const command = run?.league
    ? `console_api.py odds <out> ${run.league}`
    : `${provider.runner} <out>`;
  return runAgentFor(provider, "doctor", doctorPrompt({ provider, logTail, command }));
}

function runImplementer(provider) {
  return runAgentFor(provider, "implement", implementPrompt({ provider }));
}

// ---------------------------------------------------------------- data

const BOOK_RE = /_odds_([a-z0-9]+)\.json$/i;

/**
 * Whole calendar days between a timestamp and today: 0 = today, 1 = yesterday.
 * Calendar-based on purpose — data scraped at 23:50 is "yesterday" at 00:10,
 * which is how you'd actually think about it.
 */
function dayAge(ms) {
  const then = new Date(ms);
  then.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((today.getTime() - then.getTime()) / 86_400_000);
}

function freshness(ms) {
  const days = dayAge(ms);
  return { at: ms, ageDays: days, fresh: days <= 0 };
}

/** Group the scraped odds files by match, so you can see coverage at a glance. */
async function scanMatches(cfg) {
  const dir = outputDir(cfg);
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return { dir, matches: [], other: [] };
  }
  const matches = new Map();
  const other = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const m = name.match(BOOK_RE);
    if (!m) {
      other.push(name);
      continue;
    }
    const book = m[1].toLowerCase();
    const key = name.slice(0, m.index).replace(/_/g, " ");
    let stat;
    try {
      stat = await fsp.stat(path.join(dir, name));
    } catch {
      continue;
    }
    if (!matches.has(key)) matches.set(key, { match: key, books: {} });
    matches.get(key).books[book] = { file: name, size: stat.size, mtime: stat.mtimeMs };
  }
  const list = [...matches.values()].map((m) => {
    const newest = Math.max(...Object.values(m.books).map((b) => b.mtime));
    return {
      ...m,
      bookCount: Object.keys(m.books).length,
      newest,
      ...freshness(newest),
    };
  });
  list.sort((a, b) => b.newest - a.newest || b.bookCount - a.bookCount);
  return {
    dir,
    matches: list,
    other,
    freshCount: list.filter((m) => m.fresh).length,
  };
}

/** Run the arb finder in --json mode. */
function runArbFinder(files = []) {
  return new Promise((resolve, reject) => {
    const args = ["arb_finder.py", "--json", ...files];
    const child = spawn("python3", args, { cwd: ARB_DIR, env: { ...process.env, PYTHONUNBUFFERED: "1" } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => reject(new Error(`could not start arb_finder: ${e.message}`)));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(err.trim() || `arb_finder exited ${code}`));
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error(`arb_finder produced unreadable output: ${(err || out).slice(0, 300)}`));
      }
    });
  });
}

/**
 * Run the finder, then date each arb by the files it was derived from — an arb
 * is only as fresh as its odds, and stale odds are the dangerous kind.
 */
async function arbsWithAge(cfg) {
  const result = await runArbFinder();
  const dir = outputDir(cfg);

  const ageByMatch = new Map();
  for (const group of result.groups ?? []) {
    let newest = 0;
    for (const file of Object.values(group.files ?? {})) {
      try {
        newest = Math.max(newest, fs.statSync(path.join(dir, file)).mtimeMs);
      } catch {
        /* file moved since the scan */
      }
    }
    if (newest > 0) {
      Object.assign(group, freshness(newest));
      if (group.match) ageByMatch.set(group.match, newest);
    }
  }

  for (const arb of result.arbs ?? []) {
    const at = ageByMatch.get(arb.match);
    if (at) Object.assign(arb, freshness(at));
    else arb.fresh = false;
  }

  result.freshCount = (result.arbs ?? []).filter((a) => a.fresh).length;
  return result;
}

// ---------------------------------------------------------------- scaffold

const AGENT_TEMPLATE = (id, label, envVar) => `"""Headless runner for ${label}.

Called by the arb console as:  python agent_run.py <output-dir>
Write one <match>_odds_${id}.json per match into that directory, and print
progress lines so the console can show them live.
"""
import os, sys, json

OUT = sys.argv[1] if len(sys.argv) > 1 else "."
BASE = os.environ.get("${envVar}", "https://change-me.example")


def main():
    print(f"[${id}] starting against {BASE}", flush=True)

    # TODO: fetch the match list, then for each match build a dict of
    #   { "<market name>": { "<line>": {"over": 1.95, "under": 1.90} }, ... }
    # matching the shape the other scrapers emit (see bson-scraper output),
    # and save it so arb_finder can pair it with the other books:
    #
    # matches = fetch_matches()
    # for match in matches:
    #     markets = fetch_markets(match)
    #     fn = os.path.join(OUT, match["name"].replace(" ", "_").lower() + "_odds_${id}.json")
    #     json.dump(markets, open(fn, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
    #     print(f"[${id}] saved {os.path.basename(fn)}", flush=True)

    print("[${id}] not implemented yet — edit ${id}-scraper/agent_run.py", flush=True)
    return 1


if __name__ == "__main__":
    sys.exit(main())
`;

async function addProvider({ id, label, url, python }) {
  if (!/^[a-z0-9]+$/.test(id ?? "")) {
    throw new Error("id must be lowercase letters and digits only (it becomes the _odds_<id> suffix)");
  }
  const cfg = readConfig();
  if (cfg.providers.some((p) => p.id === id)) throw new Error(`provider "${id}" already exists`);

  const dir = `${id}-scraper`;
  const abs = path.join(REPO, dir);
  await fsp.mkdir(abs, { recursive: true });

  const runnerPath = path.join(abs, "agent_run.py");
  let created = false;
  if (!fs.existsSync(runnerPath)) {
    const envVar = `${id.toUpperCase()}_BASE`;
    await fsp.writeFile(runnerPath, AGENT_TEMPLATE(id, label || id, envVar));
    created = true;
  }

  const envVar = `${id.toUpperCase()}_BASE`;
  cfg.providers.push({
    id,
    label: label || id,
    dir,
    python: python || "../rainbet-scraper/myenv/bin/python",
    runner: "agent_run.py",
    enabled: true,
    urls: { [envVar]: url || "https://change-me.example" },
    note: "Scaffolded by the console — implement agent_run.py.",
  });
  await writeConfig(cfg);
  return { dir, created, runner: `${dir}/agent_run.py`, envVar };
}

// ---------------------------------------------------------------- http

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
  const send = (code, body, type = "application/json") => {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };

  try {
    // ---- events (SSE) ----
    if (url.pathname === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`retry: 2000\n\n`);
      clients.add(res);
      const keepAlive = setInterval(() => res.write(": ping\n\n"), 20_000);
      req.on("close", () => {
        clearInterval(keepAlive);
        clients.delete(res);
      });
      return;
    }

    if (url.pathname === "/api/state") {
      const cfg = readConfig();
      return send(200, {
        outputDir: outputDir(cfg),
        providers: cfg.providers.map((p) => {
          const cwd = path.resolve(REPO, p.dir);
          const python = path.resolve(cwd, p.python);
          return {
            ...p,
            ready: fs.existsSync(cwd) && fs.existsSync(python) && fs.existsSync(path.resolve(cwd, p.runner)),
            protocol: supportsProtocol(p),
            agent: agentRuns.get(p.id) ?? null,
            missing: [
              !fs.existsSync(cwd) ? `directory ${p.dir}` : null,
              !fs.existsSync(python) ? `python ${p.python}` : null,
              !fs.existsSync(path.resolve(cwd, p.runner)) ? `runner ${p.runner}` : null,
            ].filter(Boolean),
            running: active.has(p.id),
          };
        }),
        runs: [...runs.values()].map(summary).reverse().slice(0, 40),
      });
    }

    if (url.pathname === "/api/matches") {
      return send(200, await scanMatches(readConfig()));
    }

    if (url.pathname === "/api/arbs") {
      return send(200, await arbsWithAge(readConfig()));
    }

    if (url.pathname.startsWith("/api/logs/")) {
      const run = runs.get(url.pathname.split("/").pop());
      if (!run) return send(404, { error: "no such run" });
      return send(200, { ...summary(run), lines: run.lines });
    }

    if (req.method === "POST") {
      const body = await readBody(req);

      if (url.pathname === "/api/leagues") {
        const cfg = readConfig();
        const provider = cfg.providers.find((p) => p.id === body.id);
        if (!provider) return send(404, { error: `no such provider: ${body.id}` });
        if (!supportsProtocol(provider)) {
          return send(409, {
            error: `${provider.label} has no console_api.py`,
            needsImplementation: true,
          });
        }
        try {
          const data = await runProtocol(provider, ["leagues"], { timeoutMs: 60_000 });
          return send(200, data);
        } catch (err) {
          return send(400, { error: err.message });
        }
      }

      // Phase one: list the real match names for one league, live from the site.
      if (url.pathname === "/api/list-matches") {
        const cfg = readConfig();
        const provider = cfg.providers.find((p) => p.id === body.id);
        if (!provider) return send(404, { error: `no such provider: ${body.id}` });
        try {
          const data = await runProtocol(provider, ["matches", String(body.league)]);
          return send(200, data);
        } catch (err) {
          return send(400, { error: err.message });
        }
      }

      if (url.pathname === "/api/doctor") {
        const cfg = readConfig();
        const provider = cfg.providers.find((p) => p.id === body.id);
        if (!provider) return send(404, { error: `no such provider: ${body.id}` });
        const lastRun = [...runs.values()].reverse().find((r) => r.providerId === provider.id);
        try {
          void runDoctor(provider, lastRun);
          return send(200, { started: true, model: MODEL });
        } catch (err) {
          return send(400, { error: err.message });
        }
      }

      if (url.pathname === "/api/implement") {
        const cfg = readConfig();
        const provider = cfg.providers.find((p) => p.id === body.id);
        if (!provider) return send(404, { error: `no such provider: ${body.id}` });
        try {
          void runImplementer(provider);
          return send(200, { started: true, model: MODEL });
        } catch (err) {
          return send(400, { error: err.message });
        }
      }

      if (url.pathname === "/api/scrape") {
        const cfg = readConfig();
        const ids = body.ids?.length ? body.ids : cfg.providers.filter((p) => p.enabled).map((p) => p.id);
        const started = [];
        const failed = [];
        for (const id of ids) {
          const provider = cfg.providers.find((p) => p.id === id);
          if (!provider) {
            failed.push({ id, error: "unknown provider" });
            continue;
          }
          // A book that has never been implemented gets written first, not run.
          if (!supportsProtocol(provider) && !fs.existsSync(path.resolve(REPO, provider.dir, provider.runner))) {
            try {
              void runImplementer(provider);
              failed.push({ id, error: `${provider.label} has no scraper yet — the agent is writing it now` });
            } catch (err) {
              failed.push({ id, error: err.message });
            }
            continue;
          }
          try {
            started.push(summary(startScrape(provider, cfg, {
              league: body.league,
              leagueName: body.leagueName,
              matchIds: body.matchIds,
            })));
          } catch (err) {
            failed.push({ id, error: err.message });
          }
        }
        return send(200, { started, failed });
      }

      if (url.pathname === "/api/cancel") {
        try {
          cancelScrape(body.id);
          return send(200, { ok: true });
        } catch (err) {
          return send(400, { error: err.message });
        }
      }

      if (url.pathname === "/api/provider") {
        const cfg = readConfig();
        const provider = cfg.providers.find((p) => p.id === body.id);
        if (!provider) return send(404, { error: `no such provider: ${body.id}` });
        if (body.urls) {
          for (const [k, v] of Object.entries(body.urls)) {
            if (typeof v !== "string" || !/^https?:\/\//.test(v)) {
              return send(400, { error: `${k} must be a http(s) URL` });
            }
            provider.urls[k] = v.trim();
          }
        }
        if (typeof body.enabled === "boolean") provider.enabled = body.enabled;
        if (typeof body.label === "string" && body.label.trim()) provider.label = body.label.trim();
        await writeConfig(cfg);
        return send(200, { ok: true, provider });
      }

      if (url.pathname === "/api/provider/new") {
        try {
          return send(200, await addProvider(body));
        } catch (err) {
          return send(400, { error: err.message });
        }
      }

      if (url.pathname === "/api/output-dir") {
        const cfg = readConfig();
        const next = String(body.outputDir ?? "").trim();
        if (!next) return send(400, { error: "outputDir is required" });
        const abs = path.resolve(REPO, next);
        if (!fs.existsSync(abs)) return send(400, { error: `directory does not exist: ${abs}` });
        cfg.outputDir = path.relative(REPO, abs) || ".";
        await writeConfig(cfg);
        return send(200, { ok: true, outputDir: abs });
      }
    }

    // ---- static ----
    const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const abs = path.join(PUBLIC, file);
    if (!abs.startsWith(PUBLIC) || !fs.existsSync(abs)) return send(404, { error: "not found" });
    return send(200, await fsp.readFile(abs, "utf8"), MIME[path.extname(abs)] ?? "text/plain");
  } catch (err) {
    send(500, { error: err.message });
  }
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

server.listen(PORT, HOST, () => {
  console.log(`arb console → http://${HOST}:${PORT}`);
});

function shutdown() {
  for (const [id] of active) {
    try {
      cancelScrape(id);
    } catch {
      /* ignore */
    }
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
