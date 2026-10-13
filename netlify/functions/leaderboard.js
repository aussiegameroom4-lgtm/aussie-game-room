// Global leaderboard API for Scramble Pro and Word Chain Express.
// GET  /api/leaderboard?mode=endless|daily|mission-climb|mission-biglap|mission-world|mission-payit|mission-inner&limit=20 -> top scores
// POST /api/leaderboard?mode=...  { name, score } -> submit a score
// Names are checked against a bad-word filter (400 if rejected).
// Mission boards keep ONE entry per player name (their best total).
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
]);
// Boards that keep ONE entry per player name (their best)
const BEST_PER_NAME = (mode) => mode.startsWith("mission-") || mode === "wcr-campaign" || mode === "daily" || mode === "wcr-daily";
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
  if (mode === "wcr-daily" || mode === "daily") {
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
    const list = (await store.get(key, { type: "json" })) || [];
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

    let list = (await store.get(key, { type: "json" })) || [];
    const entry = { name, score, date: Date.now() };
    if (cls) entry.cls = cls;
    if (BEST_PER_NAME(mode)) {
      // One entry per name: keep the best total only.
      const existing = list.find((e) => e.name.toLowerCase() === name.toLowerCase());
      if (existing) {
        if (score > existing.score) {
          list = list.filter((e) => e !== existing);
          list.push(entry);
        }
      } else {
        list.push(entry);
      }
    } else {
      list.push(entry);
    }
    list.sort((a, b) => b.score - a.score);
    const trimmed = list.slice(0, MAX_ENTRIES);
    await store.setJSON(key, trimmed);

    const rankIndex = trimmed.findIndex((e) => e.name.toLowerCase() === name.toLowerCase() && (BEST_PER_NAME(mode) || e.score === score) && e.date);
    const rank = rankIndex === -1 ? null : rankIndex + 1;

    return json({ mode, rank, madeTop: rank !== null, entries: trimmed.slice(0, 20) });
  }

  return json({ error: "method not allowed" }, 405);
};

export const config = {
  path: "/api/leaderboard",
};
