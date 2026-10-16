// Global leaderboard API for Scramble Pro, Word Chain Express and Stack Attack (Numbers + Words).
// GET  /api/leaderboard?mode=<board>&limit=20 -> top scores
// POST /api/leaderboard?mode=<board>  { name, score } -> submit a score
// Daily boards also need &day=YYYY-MM-DD (a separate board for each day).
// Names are checked against a bad-word filter (400 if rejected).
// EVERY board keeps ONE entry per player name (their best score). Names match
// whatever the capitals or spaces ("Nofks", "nofks", " NOFKS ") so nobody can take
// more than one spot. Old duplicate entries are merged away automatically.
//
// Scores are stored in Netlify Blobs, so no external database or account is
// needed beyond the Netlify site itself. Netlify provides the store
// credentials automatically inside a Function - nothing to configure.

import { getStore } from "@netlify/blobs";

// Shared name filter (used in the game AND on the server).
const NF_STRONG = ['fuck','fuk','shit','bitch','cunt','nigg','faggot','retard','whore','slut','bastard','wank','twat','piss','bollock','rapist','nazi','hitler','kike','spic','chink','tranny','porn','penis','vagina','dildo','jizz','pussy','asshole','arsehole','dickhead','cocksuck','motherf','blowjob','handjob','cumshot','paedo','pedo','molest','bukake','bukkake','clit','scrote','shag','knobhead','prick','coon','gook','wetback','dyke','sodom','incest','masturbat','orgasm','genital','nutsack','ballsack','kkk','isis','rimjob'];
const NF_TOKENS = ['ass','arse','tit','tits','cum','cock','dick','fag','fags','paki','anus','boob','boobs','sex','sexy','rape','raped','nig','nigga','hoe','hoes','coons','homo','pimp','bum','crap','damn','hell','balls','nuts','butt','poo','piss','wtf','stfu'];
function nameAllowed(raw){
  const name = String(raw || '');
  if(/[<>&"`\\]/.test(name)) return false;
  const leet = { '0':'o','1':'i','3':'e','4':'a','5':'s','7':'t','8':'b','@':'a','$':'s','!':'i','+':'t','|':'i','(':'c' };
  const norm = name.toLowerCase().replace(/[01345788@$!+|(]/g, ch => leet[ch] || ch);
  const safe = ['scunthorpe','shiitake','shitake','therapist','matsushita','cocktail','cockatoo','cockatiel','peacock','hancock','dickson','dickinson','dickens','analyst','assassin','assist','assume','classic','class','mass','bass','glass','grass','brass','passion','compass','sussex','essex','middlesex'];
  let collapsed = norm.replace(/[^a-z]/g, '').replace(/(.)\1{2,}/g, '$1');
  safe.forEach(w => { collapsed = collapsed.split(w).join(''); });
  if(NF_STRONG.some(w => collapsed.includes(w))) return false;
  const tokens = norm.split(/[^a-z]+/).filter(Boolean);
  const weak = NF_TOKENS.map(t => t.replace(/(.)\1+/g, '$1'));
  // a bad word as typed, or a stretched-out bad word ("booob"), but not a real name that only looks like one once squashed ("Bob")
  return !tokens.some(t => NF_TOKENS.includes(t) || (t !== t.replace(/(.)\1+/g, '$1') && weak.includes(t.replace(/(.)\1+/g, '$1'))));
}

const MODES = new Set([
  "endless",
  "daily",
  "mission-climb",
  "mission-biglap",
  "mission-world",
  "mission-payit",
  "mission-inner",
  // Word Chain Express
  "wcr-endless",
  "wcr-blitz",
  "wcr-daily",
  "wcr-campaign",
  // Stack Attack: Numbers
  "sa-num-missions",
  "sa-num-endless",
  "sa-num-daily",
  // Stack Attack: Words
  "sa-words-missions",
  "sa-words-endless",
  "sa-words-daily",
]);
// Boards with a separate board for each day (?day=YYYY-MM-DD)
const DAILY_MODES = new Set(["daily", "wcr-daily", "sa-num-daily", "sa-words-daily"]);

// The same name whatever the capitals or spaces: "Nofks", "nofks", " NOFKS " all match
const nameKey = (n) => String(n || "").trim().toLowerCase().replace(/\s+/g, " ");

// One entry per name: keep each player's best score (the earlier one wins a tie), highest first
function bestPerName(list) {
  const best = new Map();
  list.forEach((e) => {
    if (!e || typeof e.score !== "number") return;
    const k = nameKey(e.name);
    const cur = best.get(k);
    if (!cur || e.score > cur.score || (e.score === cur.score && (e.date || 0) < (cur.date || 0))) best.set(k, e);
  });
  return [...best.values()].sort((a, b) => b.score - a.score || (a.date || 0) - (b.date || 0));
}
const MAX_ENTRIES = 100;
const MAX_NAME_LEN = 14;
const MAX_SCORE = 1_000_000;

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

// Word Scramble's Daily used to have one all-time board ("daily"). Scores from that day (Sydney time) that
// landed there (before the update, or from someone with an old copy of the game open)
// are counted on today's board too. Each name keeps only its best score.
async function withOldDaily(store, list, day) {
  const old = (await store.get("daily", { type: "json" })) || [];
  return bestPerName([...list, ...old.filter((e) => e.date && new Date(e.date).toLocaleDateString("en-CA", { timeZone: "Australia/Sydney" }) === day)]);
}

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  const url = new URL(req.url);
  const mode = url.searchParams.get("mode");
  if (!mode || !MODES.has(mode)) {
    return json({ error: "invalid mode" }, 400);
  }

  const store = getStore("scramble-leaderboards");

  // Daily boards: a separate board for each day (?day=2026-10-12)
  let key = mode;
  if (DAILY_MODES.has(mode)) {
    const day = url.searchParams.get("day") || "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      // old copies of Word Scramble (still open in someone's browser) don't send a day: keep them on the old board
      if (mode === "daily" && !day) key = "daily";
      else return json({ error: "invalid day" }, 400);
    } else key = `${mode}-${day}`;
  }

  if (req.method === "GET") {
    const limitParam = parseInt(url.searchParams.get("limit") || "20", 10);
    const limit = Math.min(Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 20, MAX_ENTRIES);
    let list = bestPerName((await store.get(key, { type: "json" })) || []);
    if (mode === "daily" && key !== "daily") list = await withOldDaily(store, list, key.slice(6));
    return json({ mode, entries: list.slice(0, limit) });
  }

  if (req.method === "POST") {
    let payload;
    try {
      payload = await req.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }

    let { name, score, cls } = payload || {};
    // Word Chain Express sends the player's Passenger Class badge (e.g. "first")
    cls = typeof cls === "string" && /^[a-z-]{1,20}$/.test(cls) ? cls : undefined;
    name = (typeof name === "string" ? name : "").trim().slice(0, MAX_NAME_LEN);
    if (!name) name = "Player";
    if (!nameAllowed(name)) {
      return json({ error: "name not allowed" }, 400);
    }
    score = Math.floor(Number(score));

    if (!Number.isFinite(score) || score < 0 || score > MAX_SCORE) {
      return json({ error: "invalid score" }, 400);
    }

    // Clean out any old duplicates first, then keep this player's best score only
    let list = bestPerName((await store.get(key, { type: "json" })) || []);
    const entry = { name, score, date: Date.now() };
    if (cls) entry.cls = cls;
    const existing = list.find((e) => nameKey(e.name) === nameKey(name));
    if (!existing) list.push(entry);
    else if (score > existing.score) list = list.filter((e) => e !== existing).concat(entry);
    list = bestPerName(list);
    const trimmed = list.slice(0, MAX_ENTRIES);
    await store.setJSON(key, trimmed);
    // the rank shown to the player includes today's scores from the old board
    const ranked = (mode === "daily" && key !== "daily") ? await withOldDaily(store, trimmed, key.slice(6)) : trimmed;

    const rankIndex = ranked.findIndex((e) => nameKey(e.name) === nameKey(name));
    const rank = rankIndex === -1 ? null : rankIndex + 1;
    const best = rankIndex === -1 ? score : ranked[rankIndex].score;

    // newBest: false when this score didn't beat the player's earlier best (their best stays on the board)
    return json({ mode, rank, madeTop: rank !== null, best, newBest: score >= best, entries: ranked.slice(0, 20) });
  }

  return json({ error: "method not allowed" }, 405);
};

export const config = {
  path: "/api/leaderboard",
};
