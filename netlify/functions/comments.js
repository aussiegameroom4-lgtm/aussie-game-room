// Inbox for the Contact & feedback form, plus the homepage "Players are saying" box.
//
// How it works:
//  - Every message sent on /contact/ is saved here (and Netlify Forms keeps a backup copy).
//  - You read everything on ONE private page: /admin/comments/  (needs your admin key).
//  - If the player ticked "You can show my comment", that message gets a "Show on website"
//    button. Tap it and it appears on the homepage. No push needed, no build credits.
//
// GET  /api/comments                          -> comments shown on the homepage (public)
// POST /api/comments  {type,game,text,name,email,share,displayName,website} -> new message (public)
// GET  /api/comments?admin=1                  -> inbox + shown comments   (admin key)
// POST /api/comments?action=approve&id=...    -> show on website          (admin key)
// POST /api/comments?action=hide&id=...       -> take off website         (admin key)
// POST /api/comments?action=read&id=...       -> mark as read / unread    (admin key)
// POST /api/comments?action=delete&id=...     -> delete for good          (admin key)
//
// The admin key is the ADMIN_KEY environment variable in Netlify.

import { getStore } from "@netlify/blobs";

const MAX_TEXT = 3000;
const MAX_INBOX = 500;
const MAX_SHOWN = 30;
const GAMES = new Set(["", "Word Scramble", "Word Chain Express", "Stack Attack: Numbers", "Stack Attack: Words"]);
const TYPES = new Set(["Feedback", "Bug", "Idea", "Question", "Other"]);

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", ...extra },
  });
const noStore = { "Cache-Control": "no-store", "Netlify-CDN-Cache-Control": "no-store" };

function isAdmin(req) {
  const key = process.env.ADMIN_KEY || "";
  const sent = req.headers.get("x-admin-key") || "";
  return key.length >= 12 && sent === key;
}
const clean = (s, max) => String(s || "").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
const oneLine = (s, max) => clean(s, max).replace(/\s+/g, " ");

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key",
      },
    });
  }

  const url = new URL(req.url);
  const store = getStore("player-comments");
  const load = async (k) => (await store.get(k, { type: "json" })) || [];

  // ---------- public: comments shown on the homepage ----------
  if (req.method === "GET" && !url.searchParams.get("admin")) {
    const shown = await load("approved");
    return json(
      { comments: shown.map(({ text, name, game }) => ({ text, name, game })) },
      200,
      // Netlify keeps a copy for 5 minutes, so busy days don't run this function on every visit
      { "Cache-Control": "public, max-age=60", "Netlify-CDN-Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" }
    );
  }

  // ---------- admin ----------
  if (url.searchParams.get("admin") || url.searchParams.get("action")) {
    if (!isAdmin(req)) return json({ error: "wrong key" }, 401, noStore);
    let inbox = await load("inbox");
    let shown = await load("approved");

    if (req.method === "GET") return json({ inbox, shown }, 200, noStore);

    if (req.method === "POST") {
      const action = url.searchParams.get("action");
      const id = url.searchParams.get("id") || "";
      const msg = inbox.find((m) => m.id === id);
      if (!msg && !shown.some((c) => c.id === id)) return json({ error: "not found" }, 404, noStore);

      if (action === "approve" && msg && msg.share) {
        shown = [{ id, text: msg.text, name: msg.displayName || "", game: msg.game || "" }, ...shown.filter((c) => c.id !== id)].slice(0, MAX_SHOWN);
        msg.shown = true; msg.read = true;
      } else if (action === "hide") {
        shown = shown.filter((c) => c.id !== id);
        if (msg) msg.shown = false;
      } else if (action === "read" && msg) {
        msg.read = !msg.read;
      } else if (action === "delete") {
        inbox = inbox.filter((m) => m.id !== id);
        shown = shown.filter((c) => c.id !== id);
      } else {
        return json({ error: "invalid action" }, 400, noStore);
      }
      await store.setJSON("inbox", inbox);
      await store.setJSON("approved", shown);
      return json({ inbox, shown }, 200, noStore);
    }
    return json({ error: "method not allowed" }, 405, noStore);
  }

  // ---------- public: a player sends a message ----------
  if (req.method === "POST") {
    let b;
    try { b = await req.json(); } catch { return json({ error: "invalid JSON" }, 400, noStore); }
    b = b || {};
    if (b.website) return json({ ok: true }, 200, noStore); // bot trap
    const text = clean(b.text, MAX_TEXT);
    if (text.length < 3) return json({ error: "too short" }, 400, noStore);
    const email = oneLine(b.email, 120);
    const msg = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      at: Date.now(),
      type: TYPES.has(b.type) ? b.type : "Other",
      game: GAMES.has(b.game) ? b.game : "",
      text,
      name: oneLine(b.name, 60),
      email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "",
      share: !!b.share,
      displayName: oneLine(b.displayName, 40),
      read: false,
      shown: false,
    };
    const inbox = await load("inbox");
    inbox.unshift(msg);
    await store.setJSON("inbox", inbox.slice(0, MAX_INBOX));
    return json({ ok: true }, 200, noStore);
  }

  return json({ error: "method not allowed" }, 405, noStore);
};

export const config = { path: "/api/comments" };
