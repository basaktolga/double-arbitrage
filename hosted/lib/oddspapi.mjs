// OddsPapi v5 REST client (https://docs.oddspapi.io).
//
// Limits per key: odds endpoints 10 req/s, everything else 100 req/min. We space
// calls accordingly and honour Retry-After on 429. Responses are normalised
// defensively because the fixture view nests some fields (participants, status).

const BASE = "https://v5.oddspapi.io/en";
const ODDS_GAP_MS = 120;
const OTHER_GAP_MS = 650;

export class OddsPapiError extends Error {
  constructor(message, { status, code, path } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.path = path;
  }
}

export function createClient({ apiKey, fetchImpl = globalThis.fetch, base = BASE, sleep = defaultSleep, log = () => {} }) {
  const lastCall = { odds: 0, other: 0 };
  const calls = [];

  async function get(path, params = {}) {
    if (!apiKey) throw new OddsPapiError("ODDSPAPI_KEY is not set", { code: "missing_api_key", path });
    const group = path.startsWith("/fixtures/odds") ? "odds" : "other";
    const gap = group === "odds" ? ODDS_GAP_MS : OTHER_GAP_MS;
    const wait = lastCall[group] + gap - Date.now();
    if (wait > 0) await sleep(wait);

    const u = new URL(base + path);
    for (const [k, v] of Object.entries(params)) if (v != null && v !== "") u.searchParams.set(k, String(v));

    for (let attempt = 0; attempt < 4; attempt++) {
      lastCall[group] = Date.now();
      let res;
      try {
        res = await fetchImpl(u.toString(), { headers: { "X-API-Key": apiKey, Accept: "application/json" } });
      } catch (e) {
        record(path, 0, "network_error");
        throw new OddsPapiError(`${path}: network error (${e.message})`, { status: 0, code: "network_error", path });
      }
      if (res.status === 429) {
        record(path, 429, "rate_limited");
        const after = Number(res.headers.get("retry-after")) || 1;
        log(`rate limited on ${path}, waiting ${after}s`);
        await sleep(after * 1000 + 250);
        continue;
      }
      if (!res.ok) {
        let body = {};
        try {
          body = await res.json();
        } catch {
          /* not json */
        }
        record(path, res.status, body.code);
        throw new OddsPapiError(`${path}: HTTP ${res.status}${body.code ? ` (${body.code})` : ""}${body.message ? ` — ${body.message}` : ""}`, {
          status: res.status,
          code: body.code,
          path,
        });
      }
      record(path, res.status);
      return res.json();
    }
    throw new OddsPapiError(`${path}: still rate limited after retries`, { status: 429, code: "rate_limited", path });
  }

  function record(path, status, code) {
    calls.push({ at: Date.now(), path, status, code: code ?? null });
    if (calls.length > 200) calls.shift();
  }

  return {
    get,
    calls,
    bookmakers: async () => asArray(await get("/bookmakers")).map((b) => ({
      slug: b.slug ?? b.bookmaker ?? b.id,
      name: b.bookmakerName ?? b.name ?? b.slug,
      active: b.active !== false,
    })),
    markets: (sportId) => get("/markets", { sportId }),
    fixtures: async (sportId, fromSec, toSec) => {
      const base = { sportId, statusId: 0 };
      try {
        return asArray(await get("/fixtures", { ...base, startTimeFrom: fromSec, startTimeTo: toSec })).map(normFixture);
      } catch (e) {
        if (![400, 422].includes(e.status)) throw e;
        log("fixtures: time-range filter rejected, retrying without it");
        return asArray(await get("/fixtures", base)).map(normFixture);
      }
    },
    /** Main-line odds for up to 100 fixtures per call. Returns [{ fixtureId, odds, bookmakers }]. */
    oddsMain: async (fixtureIds, bookmakers) => {
      const out = [];
      for (let i = 0; i < fixtureIds.length; i += 100) {
        const chunk = fixtureIds.slice(i, i + 100);
        out.push(...asViews(await get("/fixtures/odds/main", { fixtureIds: chunk.join(","), bookmakers: bookmakers.join(",") })));
      }
      return out;
    },
    /** Full odds for one fixture (fallback when /odds/main is not allowed for the key). */
    odds: async (fixtureId, bookmakers) => {
      const views = asViews(await get("/fixtures/odds", { fixtureId, bookmakers: bookmakers.join(",") }));
      return views[0] ?? { fixtureId, odds: {}, bookmakers: {} };
    },
  };
}

function defaultSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function asArray(x) {
  if (Array.isArray(x)) return x;
  if (!x || typeof x !== "object") return [];
  for (const k of ["data", "fixtures", "bookmakers", "markets", "items", "results"]) if (Array.isArray(x[k])) return x[k];
  return [];
}

function asViews(x) {
  let arr;
  if (Array.isArray(x)) arr = x;
  else if (x && Array.isArray(x.fixtures)) arr = x.fixtures;
  else if (x && Array.isArray(x.data)) arr = x.data;
  else if (x && x.odds) arr = [x];
  else if (x && typeof x === "object") arr = Object.entries(x).map(([fixtureId, v]) => ({ fixtureId, ...v }));
  else arr = [];
  return arr
    .filter((v) => v && typeof v === "object")
    .map((v) => ({ fixtureId: v.fixtureId, odds: v.odds ?? v.bookmakerOdds ?? {}, bookmakers: v.bookmakers ?? {}, fixture: normFixture(v) }));
}

const pick = (obj, paths) => {
  for (const p of paths) {
    let v = obj;
    for (const k of p.split(".")) v = v == null ? undefined : v[k];
    if (v != null && v !== "") return v;
  }
  return undefined;
};

export function normFixture(f) {
  const start = Number(pick(f, ["startTime", "status.startTime", "schedule.startTime", "trueStartTime"]));
  return {
    fixtureId: f.fixtureId,
    home: pick(f, ["participant1Name", "participants.participant1Name", "participant1.participantName", "participant1.name"]),
    away: pick(f, ["participant2Name", "participants.participant2Name", "participant2.participantName", "participant2.name"]),
    startTime: Number.isFinite(start) ? (start > 1e12 ? Math.round(start / 1000) : start) : null,
    statusId: Number(pick(f, ["statusId", "status.statusId"]) ?? 0),
    sportId: Number(pick(f, ["sportId", "sport.sportId"]) ?? String(f.fixtureId ?? "").slice(2, 4)) || null,
    tournament: pick(f, ["tournamentName", "tournament.tournamentName", "tournament.name"]) ?? null,
    hasOdds: pick(f, ["hasOdds"]),
  };
}
