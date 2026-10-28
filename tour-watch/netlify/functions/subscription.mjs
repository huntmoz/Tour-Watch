// Email sign-up: POST saves a request and emails a confirm link.
// GET ?action=confirm or ?action=unsubscribe handles the links inside those emails.
import { getStore } from "@netlify/blobs";
import { sendEmail, esc } from "../lib/email.mjs";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const page = (title, text) =>
  new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>` +
      `<body style="font-family:-apple-system,system-ui,sans-serif;max-width:480px;margin:15vh auto;padding:0 24px;text-align:center">` +
      `<h1>${esc(title)}</h1><p>${esc(text)}</p><p><a href="/">Back to Tour Watch</a></p></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } }
  );

async function emailKey(email) {
  const bytes = new TextEncoder().encode(email.toLowerCase());
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function cleanPrefs(body) {
  const artists = Array.isArray(body.artists)
    ? body.artists.map((a) => String(a).trim().slice(0, 80)).filter(Boolean).slice(0, 10)
    : [];
  const lat = Number(body.lat);
  const lon = Number(body.lon);
  const radius = Number(body.radius);
  if (!artists.length) throw new Error("Add at least one artist.");
  if (!(lat >= -90 && lat <= 90) || !(lon >= -180 && lon <= 180)) throw new Error("Invalid location.");
  return {
    artists,
    lat,
    lon,
    radius: Math.min(Math.max(radius || 75, 5), 300),
    label: String(body.label || "").slice(0, 100),
  };
}

export default async (req) => {
  const store = getStore("subscribers");
  const url = new URL(req.url);

  if (req.method === "POST") {
    let body;
    try { body = await req.json(); } catch (err) { return json({ error: "Bad request." }, 400); }

    const email = String(body.email || "").trim();
    if (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ error: "Enter a valid email address." }, 400);
    }
    let prefs;
    try { prefs = cleanPrefs(body); } catch (err) { return json({ error: err.message }, 400); }

    const key = await emailKey(email);
    const existing = await store.get(key, { type: "json" });
    if (existing?.lastConfirmEmailAt && Date.now() - existing.lastConfirmEmailAt < 10 * 60 * 1000) {
      return json({ error: "We already emailed you. Check your inbox and spam folder first." }, 429);
    }

    const record = existing || {
      email, token: crypto.randomUUID(), confirmed: false,
      artists: [], lat: 0, lon: 0, radius: 75, label: "", notified: [],
    };
    record.pending = prefs;
    record.lastConfirmEmailAt = Date.now();

    const link = `${url.origin}/api/subscription?action=confirm&k=${key}&t=${record.token}`;
    try {
      await sendEmail({
        to: email,
        subject: "Confirm your Tour Watch alerts",
        html:
          `<div style="font-family:-apple-system,system-ui,sans-serif;max-width:480px">` +
          `<h2>Confirm your alerts</h2>` +
          `<p>You asked for alerts about ${esc(prefs.artists.join(", "))} near ${esc(prefs.label || "your location")}.</p>` +
          `<p><a href="${esc(link)}" style="display:inline-block;background:#0071e3;color:#fff;padding:12px 22px;border-radius:980px;text-decoration:none">Confirm alerts</a></p>` +
          `<p style="color:#6e6e73;font-size:13px">If you didn’t ask for this, ignore this email and nothing will happen.</p></div>`,
      });
    } catch (err) {
      console.error(err);
      return json({ error: "We couldn’t send the email. Try again later." }, 502);
    }

    await store.setJSON(key, record);
    return json({ message: "Check your inbox to confirm. If you don’t see it, look in spam." });
  }

  // Links from emails
  const k = url.searchParams.get("k") || "";
  const t = url.searchParams.get("t") || "";
  const action = url.searchParams.get("action");
  const record = /^[a-f0-9]{64}$/.test(k) ? await store.get(k, { type: "json" }) : null;
  if (!record || record.token !== t) return page("Link not valid", "This link has expired or was already used.");

  if (action === "confirm") {
    if (record.pending) { Object.assign(record, record.pending); record.pending = null; }
    record.confirmed = true;
    await store.setJSON(k, record);
    return page("You’re in", "Alerts are on. We’ll email you when shows appear or tickets are about to go on sale.");
  }
  if (action === "unsubscribe") {
    await store.delete(k);
    return page("Unsubscribed", "You won’t get any more emails from Tour Watch.");
  }
  return page("Nothing to do", "That link didn’t include an action.");
};

export const config = { path: "/api/subscription" };
