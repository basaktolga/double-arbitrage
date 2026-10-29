// Push alerts through ntfy (https://ntfy.sh). Anyone who knows the topic name can
// read it, so use a long random topic.

import { splitStakes } from "./arb.mjs";

export function createAlerter({ topic, server = "https://ntfy.sh", fetchImpl = globalThis.fetch, log = () => {} }) {
  const sent = new Map(); // key → profit at last alert

  function keyOf(a) {
    return [a.source, a.fixtureId ?? a.event, a.marketId ?? a.market, ...a.legs.map((l) => `${l.book}@${l.outcomeId ?? l.selection}`)].join("|");
  }

  async function notify(arbs, { minProfit, boostedOnly = false, total = 100 } = {}) {
    if (!topic) return 0;
    let count = 0;
    for (const a of arbs) {
      if (a.profitPct < minProfit) continue;
      if (boostedOnly && !a.boosted) continue;
      if (a.sameBook) continue; // shown in the app with a warning, never pushed
      const k = keyOf(a);
      const prev = sent.get(k);
      if (prev != null && a.profitPct < prev + 0.5) continue; // only re-alert if it got clearly better
      const start = a.startTime ? new Date(a.startTime * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "";
      const lines = splitStakes(a.legs, total).map((l) => `${l.selection}: ${l.price} @ ${l.book} → ${l.stake}`);
      const body = [a.event, `${a.market}${start ? " · " + start : ""}`, ...lines, `Stakes for ${total} total. Re-check every price before betting.`].join("\n");
      try {
        await fetchImpl(`${server.replace(/\/$/, "")}/${encodeURIComponent(topic)}`, {
          method: "POST",
          headers: {
            Title: `${a.boosted ? "Boosted arb" : "Arb"} +${a.profitPct.toFixed(2)}%`,
            Priority: a.profitPct >= 3 ? "5" : "4",
            Tags: a.boosted ? "zap,moneybag" : "moneybag",
          },
          body,
        });
        sent.set(k, a.profitPct);
        count++;
      } catch (e) {
        log(`ntfy failed: ${e.message}`);
      }
    }
    if (sent.size > 2000) sent.clear();
    return count;
  }

  return { notify, enabled: Boolean(topic) };
}
