// Team / player name matching across bookmakers.
//
// Different books spell the same side differently ("Man Utd" / "Manchester United",
// "Beşiktaş" / "Besiktas", "Djokovic N." / "Novak Djokovic"). We compare token sets
// after normalising accents, dropping club suffixes and expanding a few aliases.

const STOP = new Set([
  "fc", "cf", "sc", "afc", "club", "the", "de", "fk", "sk", "ac", "as", "cd", "ud",
  "sv", "bk", "if", "cp", "esports", "esport", "team", "gaming",
]);
const ALIAS = { utd: "united", man: "manchester", st: "saint", intl: "international" };

export const MATCH_THRESHOLD = 0.6;

export function tokens(name) {
  const s = String(name ?? "")
    .toLowerCase()
    .replace(/ı/g, "i")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ");
  return s
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => ALIAS[t] ?? t)
    .filter((t) => !STOP.has(t));
}

function tokMatch(a, b) {
  if (a === b) return true;
  if (a.length === 1) return b.startsWith(a);
  if (b.length === 1) return a.startsWith(b);
  return Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a));
}

/** 0..1 similarity of two names (1 = every token on both sides found on the other). */
export function nameScore(x, y) {
  const A = tokens(x);
  const B = tokens(y);
  if (!A.length || !B.length) return 0;
  let ma = 0;
  let mb = 0;
  for (const a of A) if (B.some((b) => tokMatch(a, b))) ma++;
  for (const b of B) if (A.some((a) => tokMatch(a, b))) mb++;
  return (ma + mb) / (A.length + B.length);
}

/** "A vs B" / "A - B" / "A v B" → { home, away } */
export function splitMatch(s) {
  const parts = String(s ?? "")
    .split(/\s+(?:vs\.?|v|-|–)\s+/i)
    .map((x) => x.trim())
    .filter(Boolean);
  return parts.length >= 2 ? { home: parts[0], away: parts[1] } : null;
}

/**
 * Best fixture for a home/away pair. Order-insensitive, because books disagree on
 * which side is "home". Ties go to the earliest kick-off.
 */
export function findFixture(fixtures, home, away) {
  let best = null;
  for (const f of fixtures) {
    if (!f.home || !f.away) continue;
    const straight = Math.min(nameScore(home, f.home), nameScore(away, f.away));
    const swapped = Math.min(nameScore(home, f.away), nameScore(away, f.home));
    const score = Math.max(straight, swapped);
    if (score < MATCH_THRESHOLD) continue;
    if (!best || score > best.score || (score === best.score && f.startTime < best.fixture.startTime)) {
      best = { fixture: f, score, swapped: swapped > straight };
    }
  }
  return best;
}

const DRAW_RE = /^(draw|tie|berabere|beraberlik|x)$/i;

/** Which side a selection label refers to: "1", "X", "2" or null. */
export function sideOf(label, fixture) {
  const l = String(label ?? "").trim();
  if (DRAW_RE.test(l)) return "X";
  const s1 = nameScore(l, fixture.home);
  const s2 = nameScore(l, fixture.away);
  if (Math.max(s1, s2) < MATCH_THRESHOLD || s1 === s2) return null;
  return s1 > s2 ? "1" : "2";
}

const SPORT_SLUGS = {
  soccer: 10, football: 10, futbol: 10,
  basketball: 11, basketbol: 11,
  tennis: 12, tenis: 12,
  baseball: 13,
  "american-football": 14,
  "ice-hockey": 15, hockey: 15,
  "dota-2": 16, dota: 16,
  "counter-strike": 17, cs2: 17, csgo: 17,
  "league-of-legends": 18, lol: 18,
  darts: 19, mma: 20, boxing: 21, handball: 22, volleyball: 23,
  snooker: 24, "table-tennis": 25,
  rugby: 26, "rugby-union": 26, "rugby-league": 26,
  cricket: 27, futsal: 29, "aussie-rules": 31,
  valorant: 61,
};

export function sportIdFor(category) {
  return SPORT_SLUGS[String(category ?? "").toLowerCase()] ?? null;
}

export const SPORT_NAMES = {
  10: "Soccer", 11: "Basketball", 12: "Tennis", 13: "Baseball", 14: "American Football",
  15: "Ice Hockey", 16: "Dota 2", 17: "Counter-Strike", 18: "League of Legends", 19: "Darts",
  20: "MMA", 21: "Boxing", 22: "Handball", 23: "Volleyball", 24: "Snooker", 25: "Table Tennis",
  26: "Rugby", 27: "Cricket", 29: "Futsal", 31: "Aussie Rules", 61: "Valorant",
};
