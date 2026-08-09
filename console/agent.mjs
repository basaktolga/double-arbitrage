/**
 * Agentic helpers: the doctor (diagnose + fix a broken book) and the
 * implementer (write a scaffolded book's scraper on first use).
 *
 * Both shell out to the Claude Code CLI on Sonnet. They edit only inside the
 * scraper's own directory.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const MODEL = "claude-sonnet-5";

/** Tools the agents may use — enough to read, edit and test a scraper. */
const ALLOWED = ["Read", "Edit", "Write", "Grep", "Glob", "Bash"];

function claudeAvailable() {
  const dirs = (process.env.PATH ?? "").split(":");
  return dirs.some((d) => d && fs.existsSync(path.join(d, "claude")));
}

/**
 * Run a Claude Code session headlessly, streaming a readable transcript.
 * onLine receives progress text; resolves with { ok, summary }.
 */
export function runAgent({ prompt, cwd, onLine, timeoutMs = 15 * 60_000 }) {
  return new Promise((resolve) => {
    if (!claudeAvailable()) {
      onLine("stderr", "[agent] the `claude` CLI is not on PATH — install Claude Code to use this");
      resolve({ ok: false, summary: "claude CLI not found" });
      return;
    }

    const args = [
      "-p", prompt,
      "--model", MODEL,
      "--output-format", "stream-json",
      "--verbose",
      "--permission-mode", "acceptEdits",
      "--allowedTools", ALLOWED.join(","),
      "--add-dir", cwd,
    ];

    const child = spawn("claude", args, {
      cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    let summary = "";
    let ok = false;
    let buffer = "";

    const timer = setTimeout(() => {
      onLine("stderr", `[agent] timed out after ${Math.round(timeoutMs / 60000)} min`);
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf("\n")) !== -1) {
        const raw = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        if (!raw.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(raw);
        } catch {
          continue;
        }
        for (const text of describe(msg)) onLine("stdout", text);
        if (msg.type === "result") {
          ok = msg.subtype === "success";
          if (typeof msg.result === "string") summary = msg.result;
        }
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => onLine("stderr", `[agent] ${String(d).trim()}`));

    child.on("error", (err) => {
      clearTimeout(timer);
      onLine("stderr", `[agent] could not start: ${err.message}`);
      resolve({ ok: false, summary: err.message });
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve({ ok, summary: summary || (ok ? "finished" : "no summary returned") });
    });
  });
}

/** Turn one stream-json message into human-readable console lines. */
function describe(msg) {
  const out = [];
  if (msg.type === "assistant") {
    for (const block of msg.message?.content ?? []) {
      if (block.type === "text" && block.text?.trim()) {
        out.push(`[agent] ${block.text.trim().split("\n")[0].slice(0, 300)}`);
      }
      if (block.type === "tool_use") {
        const input = block.input ?? {};
        const detail = input.command ?? input.file_path ?? input.pattern ?? "";
        out.push(`[agent] ${block.name}${detail ? `: ${String(detail).slice(0, 160)}` : ""}`);
      }
    }
  }
  if (msg.type === "result") {
    out.push(`[agent] ${msg.subtype === "success" ? "done" : `ended: ${msg.subtype}`}`);
  }
  return out;
}

// ---------------------------------------------------------------- prompts

export function doctorPrompt({ provider, logTail, command }) {
  return `You are diagnosing a broken sports-odds scraper in this directory.

BOOK: ${provider.label} (id: ${provider.id})
COMMAND THAT FAILED: ${command}
CONFIGURED URLS (these come from the console's providers.json and are passed as env vars):
${Object.entries(provider.urls).map(([k, v]) => `  ${k}=${v}`).join("\n")}

OUTPUT FROM THE FAILED RUN (tail):
${logTail}

Your job:
1. Work out the ACTUAL cause. Read main.py and console_api.py in this directory.
   Common causes, in rough order of likelihood:
   - the mirror domain is dead or moved (DNS failure, timeout, redirect to a new host)
   - the site's HTML/selectors changed, so scraping returns nothing
   - a league path in LEAGUES no longer exists
   - the API shape changed
2. Verify your hypothesis before fixing. You may use Bash — e.g.
   \`curl -sIL -m 15 <url>\` to check whether a domain resolves, or run
   \`./myenv/bin/python console_api.py leagues\` to check the module imports.
   Do NOT run a full scrape; it is slow.
3. If it is fixable in code (a selector, a path, a parsing bug), fix it in this
   directory and say exactly what you changed.
4. If it needs something only the human can supply — most importantly a NEW
   MIRROR DOMAIN, or credentials — do NOT guess a URL. Say clearly what you need.

Finish with a short report in exactly this shape:

DIAGNOSIS: <one or two sentences>
FIXED: <yes|no>
ACTION NEEDED: <what the human must do, or "none">

Be concise. Do not refactor anything unrelated.`;
}

export function implementPrompt({ provider, sampleBook }) {
  return `Implement the odds scraper for a new bookmaker in this directory.

BOOK: ${provider.label} (id: ${provider.id})
URL(S) (passed to your code as environment variables):
${Object.entries(provider.urls).map(([k, v]) => `  ${k}=${v}`).join("\n")}

You are writing \`console_api.py\` in this directory. It MUST implement exactly
this command-line protocol, because the console calls it:

  python console_api.py leagues
      -> print the line "CONSOLE_JSON" then one JSON object:
         {"leagues":[{"key":"<stable-id>","name":"Premier League","path":"<url path>"}]}

  python console_api.py matches <league-key>
      -> print "CONSOLE_JSON" then:
         {"league":{...},"matches":[{"id":"<stable-id>","name":"Team A - Team B","link":"<url>"}]}

  python console_api.py odds <out-dir> <league-key> [id,id,...]
      -> scrape ONLY the given match ids (empty = all in that league) and write
         one file per match named  <match_name_with_underscores>_odds_${provider.id}.json
         into <out-dir>. Print "[${provider.id}] saved <filename>" for each.
         Exit 0 if at least one file was written, 1 otherwise.

CRITICAL — the output JSON format must match the other books so the arb finder
can pair them. Read ../bson-scraper/console_api.py and ../bson-scraper/main.py
for the reference implementation, and look at an existing output file such as
../json-2file-arbfinder/uruguay_-_spain_odds_bson.json to copy the exact market
structure. Only over/under style total markets matter.

Rules:
- Read the URL from os.environ with a sensible fallback, as the other scrapers do.
- Use playwright (sync API) — \`../rainbet-scraper/myenv/bin/python\` has it, and
  patchright too if the site has bot protection.
- Only ever scrape leagues you actually discovered on the site. Never invent paths.
- Verify as you go with Bash: fetch the site, inspect the real markup or API
  responses, and confirm your selectors match. Do not guess.
- If the site cannot be scraped without something you don't have (login,
  captcha, paid API), stop and say so rather than writing code that pretends.

Finish with:

IMPLEMENTED: <yes|no>
LEAGUES FOUND: <count or names>
ACTION NEEDED: <what the human must do, or "none">`;
}
