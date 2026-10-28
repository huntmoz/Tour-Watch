// Long-running job (up to 15 minutes): looks for new shows and ticket sales
// for every confirmed subscriber and sends one email each.
import { getStore } from "@netlify/blobs";
import { sendEmail, esc } from "../lib/email.mjs";

const DAY = 864e5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function formatWhen(iso, tz) {
  try {
    return new Date(iso).toLocaleString("en-US", {
      timeZone: tz || "UTC", dateStyle: "medium", timeStyle: "short", timeZoneName: "short",
    });
  } catch (err) {
    return new Date(iso).toUTCString();
  }
}

function buildAlerts(sub, events, artist, site) {
  const out = [];
  const now = Date.now();
  for (const ev of events) {
    const venue = ev._embedded?.venues?.[0];
    const where = (venue?.name || "a venue") + (venue?.city?.name ? ", " + venue.city.name : "");
    const url = /^https:\/\//.test(ev.url || "") ? ev.url : site;
    const add = (id, title, detail) => {
      if (!sub.notified.includes(id)) out.push({ id, title, detail, url });
    };

    add(ev.id + ":show", `${artist} is playing near you`, `${where} on ${ev.dates.start.localDate}`);

    const sales = [];
    (ev.sales?.presales || []).forEach((p) => {
      if (p.startDateTime) sales.push({ label: p.name || "Presale", start: p.startDateTime });
    });
    if (ev.sales?.public?.startDateTime && !ev.sales.public.startTBD) {
      sales.push({ label: "General sale", start: ev.sales.public.startDateTime });
    }
    for (const s of sales) {
      const diff = new Date(s.start) - now;
      const when = formatWhen(s.start, venue?.timezone);
      if (diff > 0 && diff <= DAY) {
        add(`${ev.id}:soon:${s.label}`, `${s.label} starts within 24 hours`, `${artist} at ${where}. Opens ${when}.`);
      } else if (diff <= 0 && diff > -DAY) {
        add(`${ev.id}:live:${s.label}`, `${s.label} is open now`, `${artist} at ${where}. Opened ${when}.`);
      }
    }
  }
  return out;
}

function renderEmail(sub, key, alerts, site) {
  const items = alerts
    .map((a) =>
      `<li style="margin:0 0 16px"><strong>${esc(a.title)}</strong><br>${esc(a.detail)}<br>` +
      `<a href="${esc(a.url)}">Open ticket page</a></li>`)
    .join("");
  const unsub = `${site}/api/subscription?action=unsubscribe&k=${key}&t=${sub.token}`;
  return (
    `<div style="font-family:-apple-system,system-ui,sans-serif;max-width:520px">` +
    `<h2 style="margin:0 0 16px">Tour Watch</h2><ul style="padding-left:18px">${items}</ul>` +
    `<p style="color:#6e6e73;font-size:13px">Concerts near ${esc(sub.label || "your location")}. ` +
    `<a href="${esc(unsub)}">Unsubscribe</a></p></div>`
  );
}

export default async (req) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("x-cron-secret") !== secret) {
    console.log("Rejected: missing or wrong secret.");
    return new Response(null, { status: 202 });
  }
  const tmKey = process.env.TICKETMASTER_KEY;
  const site = (process.env.SITE_URL || "").replace(/\/$/, "");
  if (!tmKey || !site) {
    console.log("Missing TICKETMASTER_KEY or SITE_URL.");
    return new Response(null, { status: 202 });
  }

  const store = getStore("subscribers");
  const { blobs } = await store.list();
  const cache = new Map(); // same artist + place + radius is only looked up once per run

  async function findShows(artist, sub) {
    const cacheKey = [artist.toLowerCase(), sub.lat.toFixed(1), sub.lon.toFixed(1), sub.radius].join("|");
    if (cache.has(cacheKey)) return cache.get(cacheKey);

    const params = new URLSearchParams({
      apikey: tmKey, keyword: artist, classificationName: "music",
      latlong: sub.lat + "," + sub.lon, radius: String(sub.radius),
      unit: "miles", sort: "date,asc", size: "50",
    });
    await sleep(250); // stay under Ticketmaster's rate limit
    let events = [];
    try {
      const res = await fetch("https://app.ticketmaster.com/discovery/v2/events.json?" + params);
      if (res.ok) {
        const data = await res.json();
        events = (data._embedded?.events || []).filter((ev) =>
          ev._embedded?.attractions?.some((a) => a.name.toLowerCase() === artist.toLowerCase()));
      }
    } catch (err) {
      console.error("Ticketmaster lookup failed for", artist, err);
    }
    cache.set(cacheKey, events);
    return events;
  }

  let sent = 0;
  for (const { key } of blobs) {
    const sub = await store.get(key, { type: "json" });
    if (!sub?.confirmed || !sub.artists?.length) continue;
    sub.notified ||= [];

    const alerts = [];
    const seenIds = new Set();
    for (const artist of sub.artists) {
      const events = await findShows(artist, sub);
      for (const a of buildAlerts(sub, events, artist, site)) {
        if (!seenIds.has(a.id)) { seenIds.add(a.id); alerts.push(a); }
      }
    }
    if (!alerts.length) continue;

    try {
      await sendEmail({
        to: sub.email,
        subject: alerts.length === 1 ? alerts[0].title : `Tour Watch: ${alerts.length} updates`,
        html: renderEmail(sub, key, alerts, site),
      });
      sub.notified = [...sub.notified, ...alerts.map((a) => a.id)].slice(-500);
      await store.setJSON(key, sub);
      sent++;
    } catch (err) {
      console.error("Could not email a subscriber:", err.message);
    }
  }
  console.log(`Alert check finished. Emails sent: ${sent}.`);
  return new Response(null, { status: 202 });
};
