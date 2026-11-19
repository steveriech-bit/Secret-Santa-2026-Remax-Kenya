import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";

const slug = n => n.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "p";
const hash = (n, p) => createHash("sha256").update(slug(n) + ":" + p + ":santa").digest("hex");
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
const ready = m => !!m.pairs && (!m.drawAt || Date.now() >= m.drawAt);

async function listPlayers(s) {
  const { blobs } = await s.list({ prefix: "p/" });
  const all = await Promise.all(blobs.map(b => s.get(b.key, { type: "json" })));
  return all.filter(Boolean).sort((a, b) => a.at - b.at);
}

export default async (req) => {
  const s = getStore("santa");
  const route = new URL(req.url).pathname.replace(/^\/api\/?/, "");
  const meta = (await s.get("meta", { type: "json" })) || { pairs: null, drawAt: null };
  let b = {};
  if (req.method === "POST") { try { b = await req.json(); } catch {} }
  const isAdmin = () => !!process.env.ADMIN_KEY && b.key === process.env.ADMIN_KEY;

  if (route === "state") {
    const ps = await listPlayers(s);
    return json({ players: ps.map(p => p.nick), drawn: !!meta.pairs, drawAt: meta.drawAt, ready: ready(meta), now: Date.now() });
  }

  if (route === "join") {
    const nick = String(b.nick || "").trim(), pin = String(b.pin || ""), gender = String(b.gender || "");
    if (!nick || nick.length > 20) return json({ error: "Enter a nickname (up to 20 characters)." }, 400);
    if (!["Male", "Female"].includes(gender)) return json({ error: "Please select your gender." }, 400);
    if (!/^\d{4}$/.test(pin)) return json({ error: "Choose a 4-digit PIN." }, 400);
    if (meta.pairs) return json({ error: "The draw is done, so sign-ups are closed." }, 409);
    const key = "p/" + slug(nick);
    if (await s.get(key)) return json({ error: "That nickname is taken. Try another." }, 409);
    await s.setJSON(key, { nick, gender, pin: hash(nick, pin), at: Date.now(), fails: 0, lock: 0 });
    return json({ ok: true });
  }

  if (route === "reveal") {
    if (!ready(meta)) return json({ error: "Matches are not unlocked yet." }, 403);
    const key = "p/" + slug(String(b.nick || ""));
    const p = await s.get(key, { type: "json" });
    if (!p) return json({ error: "Nickname not found." }, 404);
    if (p.lock > Date.now()) return json({ error: "Too many wrong PINs. Try again in a few minutes." }, 429);
    if (p.pin !== hash(p.nick, String(b.pin || ""))) {
      p.fails = (p.fails || 0) + 1;
      if (p.fails >= 5) { p.lock = Date.now() + 10 * 60 * 1000; p.fails = 0; }
      await s.setJSON(key, p);
      return json({ error: "Wrong PIN. Try again." }, 401);
    }
    if (p.fails) { p.fails = 0; await s.setJSON(key, p); }
    const match = meta.pairs[p.nick] || null;
    const mp = match ? await s.get("p/" + slug(match), { type: "json" }) : null;
    return json({ match, gender: (mp && mp.gender) || null });
  }

  // organiser routes
  if (!process.env.ADMIN_KEY) return json({ error: "Set the ADMIN_KEY environment variable in Netlify first." }, 500);
  if (!isAdmin()) return json({ error: "Wrong organiser password." }, 401);

  if (route === "admin-check") return json({ ok: true });

  if (route === "config") {
    meta.drawAt = b.drawAt ? Number(b.drawAt) : null;
    await s.setJSON("meta", meta);
    return json({ ok: true });
  }

  if (route === "draw") {
    if (meta.pairs) return json({ error: "Already drawn." }, 409);
    const ps = await listPlayers(s);
    if (ps.length < 3) return json({ error: "At least 3 people are needed." }, 400);
    const names = ps.map(p => p.nick);
    for (let i = names.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [names[i], names[j]] = [names[j], names[i]];
    }
    meta.pairs = {};
    names.forEach((n, i) => { meta.pairs[n] = names[(i + 1) % names.length]; });
    await s.setJSON("meta", meta);
    return json({ ok: true });
  }

  if (route === "reset") {
    const { blobs } = await s.list({ prefix: "p/" });
    await Promise.all(blobs.map(x => s.delete(x.key)));
    await s.delete("meta");
    return json({ ok: true });
  }

  return json({ error: "Not found" }, 404);
};

export const config = { path: "/api/*" };
