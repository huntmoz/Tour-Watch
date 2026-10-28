// Passes searches to Ticketmaster while keeping your API key on the server.
const ALLOWED = [
  "keyword", "latlong", "radius", "unit", "sort", "size", "startDateTime", "endDateTime",
];

const json = (body, status) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export default async (req) => {
  const key = process.env.TICKETMASTER_KEY;
  if (!key) return json({ error: "The site is missing its Ticketmaster key." }, 500);

  const incoming = new URL(req.url).searchParams;
  const params = new URLSearchParams();
  for (const name of ALLOWED) {
    const value = incoming.get(name);
    if (value) params.set(name, value.slice(0, 200));
  }
  params.set("classificationName", "music");
  params.set("size", String(Math.min(Number(params.get("size")) || 50, 100)));
  params.set("apikey", key);

  let upstream;
  try {
    upstream = await fetch("https://app.ticketmaster.com/discovery/v2/events.json?" + params);
  } catch (err) {
    return json({ error: "Could not reach Ticketmaster." }, 502);
  }
  if (!upstream.ok) {
    return json({ error: "Ticketmaster returned an error (" + upstream.status + ")." }, 502);
  }

  return new Response(await upstream.text(), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
  });
};

export const config = { path: "/api/events" };
