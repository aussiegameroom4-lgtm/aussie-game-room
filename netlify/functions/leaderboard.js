// Global leaderboard API for Scramble Pro.
// GET  /api/leaderboard?mode=endless|daily&limit=20   -> top scores
// POST /api/leaderboard?mode=endless|daily  { name, score } -> submit a score
//
// Scores are stored in Netlify Blobs, so no external database or account is
// needed beyond the Netlify site itself. Netlify provides the store
// credentials automatically inside a Function - nothing to configure.

import { getStore } from "@netlify/blobs";

const MODES = new Set(["endless", "daily"]);
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
    return json({ error: "mode must be 'endless' or 'daily'" }, 400);
  }

  const store = getStore("scramble-leaderboards");

  if (req.method === "GET") {
    const limitParam = parseInt(url.searchParams.get("limit") || "20", 10);
    const limit = Math.min(Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 20, MAX_ENTRIES);
    const list = (await store.get(mode, { type: "json" })) || [];
    return json({ mode, entries: list.slice(0, limit) });
  }

  if (req.method === "POST") {
    let payload;
    try {
      payload = await req.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }

    let { name, score } = payload || {};
    name = (typeof name === "string" ? name : "").trim().slice(0, MAX_NAME_LEN);
    if (!name) name = "Player";
    score = Math.floor(Number(score));

    if (!Number.isFinite(score) || score < 0 || score > MAX_SCORE) {
      return json({ error: "invalid score" }, 400);
    }

    const list = (await store.get(mode, { type: "json" })) || [];
    list.push({ name, score, date: Date.now() });
    list.sort((a, b) => b.score - a.score);
    const trimmed = list.slice(0, MAX_ENTRIES);
    await store.setJSON(mode, trimmed);

    const rankIndex = trimmed.findIndex((e) => e.name === name && e.score === score && e.date);
    const rank = rankIndex === -1 ? null : rankIndex + 1;

    return json({ mode, rank, madeTop: rank !== null, entries: trimmed.slice(0, 20) });
  }

  return json({ error: "method not allowed" }, 405);
};

export const config = {
  path: "/api/leaderboard",
};
