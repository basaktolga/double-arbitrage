// Supervisor for collector-worker.mjs.
//
// The worker (and the Chromium it starts) runs in its own process group. While it
// runs we sum the memory of the whole process tree from /proc every second; if it
// passes the limit, or the run takes too long, the whole group is killed. The web
// server only ever sees a result object — never an exception — so a crashed or
// killed browser can't bring it down.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, "..", "collector-worker.mjs");
const PAGE = 4096; // bytes per memory page on Linux x86-64/arm64 (statm is in pages)

/**
 * Memory (MB) used by a process and all its descendants, via /proc. Uses PSS
 * (proportional set size), which splits shared pages between Chromium's processes;
 * plain RSS would count the shared browser binary once per process and overstate it
 * by ~70%. Falls back to RSS where smaps_rollup is unavailable. Linux only.
 */
export function treeRssMb(rootPid) {
  let entries;
  try {
    entries = fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d));
  } catch {
    return null; // not Linux
  }
  const parent = new Map();
  for (const pid of entries) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      parent.set(Number(pid), Number(after[1]));
    } catch {
      /* process exited meanwhile */
    }
  }
  if (!parent.has(rootPid)) return 0;
  const inTree = new Set([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, ppid] of parent) {
      if (!inTree.has(pid) && inTree.has(ppid)) {
        inTree.add(pid);
        grew = true;
      }
    }
  }
  let total = 0;
  for (const pid of inTree) {
    try {
      const m = fs.readFileSync(`/proc/${pid}/smaps_rollup`, "utf8").match(/^Pss:\s+(\d+)\s+kB/m);
      if (m) {
        total += Number(m[1]) * 1024;
        continue;
      }
    } catch {
      /* fall back to RSS */
    }
    try {
      total += Number(fs.readFileSync(`/proc/${pid}/statm`, "utf8").split(" ")[1]) * PAGE;
    } catch {
      /* exited */
    }
  }
  return total / 1024 / 1024;
}

/** Whole-container memory pressure from cgroup v2 (0..1), or null when not available. */
export function containerPressure() {
  try {
    const max = fs.readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim();
    if (max === "max") return null;
    const cur = Number(fs.readFileSync("/sys/fs/cgroup/memory.current", "utf8").trim());
    return cur / Number(max);
  } catch {
    return null;
  }
}

/**
 * opts: { url, categories[], maxMb, timeoutMs, env, onProgress }
 * Resolves (never rejects) with:
 *   { status, items[], pages[], error, peakMb, durationMs }
 * status: ok | blocked | geo_blocked | no_odds_elements | no_browser | memory_limit | timeout | crashed | error
 */
export function runCollector({ url, categories, maxMb = 400, timeoutMs = 8 * 60_000, env = {}, onProgress = () => {} }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let peakMb = 0;
    let result = null;
    let killedFor = null;
    let stderr = "";
    let buf = "";

    let child;
    try {
      child = spawn(process.execPath, [WORKER], {
        detached: true, // own process group → we can kill Chromium too
        stdio: ["ignore", "pipe", "pipe"],
        // Only what the worker needs — never the server's API keys or passwords.
        env: Object.fromEntries(Object.entries({
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
          NODE_PATH: process.env.NODE_PATH,
          ...env,
          STAKE_URL: url,
          STAKE_CATEGORIES: categories.join(","),
        }).filter(([, v]) => v != null)),
      });
    } catch (e) {
      resolve({ status: "error", items: [], pages: [], error: `could not start worker: ${e.message}`, peakMb: 0, durationMs: 0 });
      return;
    }

    const killGroup = (why) => {
      if (killedFor) return;
      killedFor = why;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* gone */
        }
      }
    };

    const watchdog = setInterval(() => {
      const mb = treeRssMb(child.pid);
      if (mb != null) {
        peakMb = Math.max(peakMb, mb);
        if (mb > maxMb) killGroup("memory_limit");
      }
      // Belt and braces: if the whole container is nearly full, stop the browser before
      // the kernel's OOM killer picks a process (which could be the web server).
      const pressure = containerPressure();
      if (pressure != null && pressure > 0.92) killGroup("memory_limit");
      if (Date.now() - started > timeoutMs) killGroup("timeout");
    }, 1000);
    watchdog.unref?.();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.type === "progress") {
          try {
            onProgress(msg);
          } catch {
            /* ignore */
          }
        } else if (msg.type === "result") result = msg;
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => {
      stderr = (stderr + c).slice(-2000);
    });

    const finish = (code, signal) => {
      clearInterval(watchdog);
      // Make sure no orphaned Chromium survives the worker.
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
      const durationMs = Date.now() - started;
      const peak = Math.round(peakMb);
      if (killedFor) {
        resolve({
          status: killedFor,
          items: result?.items ?? [],
          pages: result?.pages ?? [],
          error: killedFor === "memory_limit" ? `browser used more than ${maxMb} MB and was stopped` : `run took longer than ${Math.round(timeoutMs / 60000)} min and was stopped`,
          peakMb: peak,
          durationMs,
        });
      } else if (result) {
        resolve({ ...result, items: result.items ?? [], pages: result.pages ?? [], peakMb: peak, durationMs });
      } else {
        resolve({
          status: "crashed",
          items: [],
          pages: [],
          error: `worker exited (${signal ?? `code ${code}`}) without a result${stderr ? `: ${stderr.trim().split("\n").slice(-3).join(" | ")}` : ""}`,
          peakMb: peak,
          durationMs,
        });
      }
    };
    child.on("error", (e) => {
      stderr += e.message;
    });
    child.on("close", finish);
  });
}
