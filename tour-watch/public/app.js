const $ = (id) => document.getElementById(id);
const EVENTS_URL = "/api/events?"; // your server holds the Ticketmaster key

/* ---------- smooth scroll ---------- */
if (window.Lenis) {
  const lenis = new Lenis();
  const raf = (time) => { lenis.raf(time); requestAnimationFrame(raf); };
  requestAnimationFrame(raf);
}

/* ---------- saved settings (stored in this visitor's browser) ---------- */
function loadJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch (err) { return fallback; }
}
function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (err) { /* storage blocked */ }
}

let favorites = loadJSON("tw.favorites", []);
const seen = new Set(loadJSON("tw.seen", []));
function markSeen(key) { seen.add(key); saveJSON("tw.seen", [...seen].slice(-500)); }

/* ---------- helpers ---------- */
function milesBetween(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function shiftDay(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function notify(title, body) {
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification(title, { body });
  }
}

/* ---------- turning a city (or US zip) into a location ---------- */
async function zipToPos(zip) {
  const res = await fetch("https://api.zippopotam.us/us/" + zip);
  if (!res.ok) throw new Error("Could not find that zip code.");
  const place = (await res.json()).places[0];
  return {
    lat: parseFloat(place.latitude),
    lon: parseFloat(place.longitude),
    label: place["place name"] + ", " + place["state abbreviation"],
  };
}

async function cityToPos(query) {
  const [name, region] = query.split(",").map((s) => s.trim());
  const res = await fetch(
    "https://geocoding-api.open-meteo.com/v1/search?count=10&language=en&name=" +
      encodeURIComponent(name)
  );
  if (!res.ok) throw new Error("City lookup failed. Try again.");
  const results = (await res.json()).results || [];
  if (!results.length) throw new Error("Could not find that city.");

  const want = (region || "").toLowerCase();
  const pick =
    (want &&
      results.find(
        (r) =>
          (r.admin1 || "").toLowerCase().startsWith(want) ||
          (r.country_code || "").toLowerCase() === want ||
          (r.country || "").toLowerCase().startsWith(want)
      )) ||
    results[0];

  return {
    lat: pick.latitude,
    lon: pick.longitude,
    label: [pick.name, pick.admin1].filter(Boolean).join(", "),
  };
}

let userPos = null;
let usingGps = false;

async function resolveLocation() {
  const city = $("search-city").value.trim();
  if (city) {
    usingGps = false;
    userPos = /^\d{5}$/.test(city) ? await zipToPos(city) : await cityToPos(city);
    saveJSON("tw.city", city);
  } else if (!usingGps || !userPos) {
    throw new Error("Enter your city to see concerts near you.");
  }
  return userPos;
}

/* ---------- drawing a concert ticket ---------- */
function renderShow(artist, ev, list, miles) {
  const venue = ev._embedded?.venues?.[0];
  const li = document.createElement("li");
  li.className = "show";

  const name = document.createElement("strong");
  name.textContent = artist;

  const where = document.createElement("span");
  let text = (venue?.name || "Venue TBA") + (venue?.city?.name ? ", " + venue.city.name : "");
  if (Number.isFinite(miles)) text += " · " + Math.round(miles) + " mi away";
  where.textContent = text;

  const when = document.createElement("time");
  when.textContent = ev.dates.start.localDate;

  const link = document.createElement("a");
  if (/^https:\/\//.test(ev.url || "")) link.href = ev.url;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = "Tickets";

  li.append(name, where, when, link);
  list.append(li);
}

async function fetchEvents(params) {
  const res = await fetch(EVENTS_URL + params);
  if (!res.ok) {
    const info = await res.json().catch(() => ({}));
    throw new Error(info.error || "Search failed (" + res.status + ").");
  }
  return res.json();
}

/* ---------- search ---------- */
const SORT_LABELS = { distance: "closest first", date: "soonest first", size: "biggest first" };

async function searchConcerts(keyword, pos, radius, from, to, sort) {
  const apiSort = {
    distance: "distance,asc",
    date: "date,asc",
    size: "relevance,desc", // Ticketmaster's popularity ranking
  }[sort];

  const params = new URLSearchParams({
    latlong: pos.lat + "," + pos.lon,
    radius: radius,
    unit: "miles",
    sort: apiSort,
    size: "100",
  });
  if (keyword) params.set("keyword", keyword);
  // widen the window by a day for time zones, then filter exactly below
  if (from) params.set("startDateTime", shiftDay(from, -1) + "T00:00:00Z");
  if (to) params.set("endDateTime", shiftDay(to, 1) + "T23:59:59Z");

  const data = await fetchEvents(params);

  const list = (data._embedded?.events || [])
    .filter(({ dates }) => {
      const d = dates.start.localDate;
      return (!from || d >= from) && (!to || d <= to);
    })
    .map((ev) => {
      const loc = ev._embedded?.venues?.[0]?.location;
      const miles = loc
        ? milesBetween(pos.lat, pos.lon, parseFloat(loc.latitude), parseFloat(loc.longitude))
        : Infinity;
      return { ev, miles };
    });

  if (sort === "size") return list; // keep Ticketmaster's biggest-first order

  return list.sort((a, b) => {
    const byDate = a.ev.dates.start.localDate.localeCompare(b.ev.dates.start.localDate);
    return sort === "date" ? byDate || a.miles - b.miles : a.miles - b.miles || byDate;
  });
}

async function runSearch(keyword) {
  const status = $("search-status");
  const list = $("results");
  list.replaceChildren();
  status.textContent = "Searching…";

  try {
    const from = $("search-from").value;
    const to = $("search-to").value;
    const sort = $("search-sort").value;
    if (from && to && to < from) throw new Error("The end date is before the start date.");

    const pos = await resolveLocation();
    const found = await searchConcerts(keyword, pos, $("search-radius").value, from, to, sort);

    if (!found.length) {
      status.textContent = "No concerts found near " + pos.label + ". Try a bigger distance or wider dates.";
      return;
    }
    status.textContent = found.length + " concerts near " + pos.label + ", " + SORT_LABELS[sort] + ".";
    found.forEach(({ ev, miles }) => {
      const artist = ev._embedded?.attractions?.[0]?.name || ev.name;
      renderShow(artist, ev, list, miles);
    });
  } catch (err) {
    status.textContent = err.message;
  }
}

$("search-form").onsubmit = (e) => {
  e.preventDefault();
  runSearch($("search-input").value.trim());
  check(); // refresh your artists for the same city
};

$("browse-nearby").onclick = () => {
  $("search-input").value = "";
  runSearch("");
  check();
};

$("use-location").onclick = () => {
  const status = $("search-status");
  if (!navigator.geolocation) {
    status.textContent = "Your browser can't share location. Type your city instead.";
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (p) => {
      userPos = { lat: p.coords.latitude, lon: p.coords.longitude, label: "your location" };
      usingGps = true;
      $("search-city").value = "";
      status.textContent = "Using your location. Press Search.";
    },
    () => { status.textContent = "Location was blocked. Type your city instead."; }
  );
};

/* ---------- your artists ---------- */
function renderChips() {
  const ul = $("fav-chips");
  ul.replaceChildren();
  favorites.forEach((name, i) => {
    const li = document.createElement("li");
    li.append(name);
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = "×";
    b.setAttribute("aria-label", "Remove " + name);
    b.onclick = () => {
      favorites.splice(i, 1);
      saveJSON("tw.favorites", favorites);
      renderChips();
      check();
    };
    li.append(b);
    ul.append(li);
  });
}

$("fav-form").onsubmit = (e) => {
  e.preventDefault();
  const name = $("fav-input").value.trim();
  const dupe = favorites.some((f) => f.toLowerCase() === name.toLowerCase());
  if (name && !dupe && favorites.length < 10) {
    favorites.push(name);
    saveJSON("tw.favorites", favorites);
    renderChips();
    check();
  }
  $("fav-input").value = "";
};

async function findShows(artist, pos, radius) {
  const params = new URLSearchParams({
    keyword: artist,
    latlong: pos.lat + "," + pos.lon,
    radius: radius,
    unit: "miles",
    sort: "date,asc",
  });
  const data = await fetchEvents(params);
  return (data._embedded?.events || []).filter((ev) =>
    ev._embedded?.attractions?.some((a) => a.name.toLowerCase() === artist.toLowerCase())
  );
}

let checkRun = 0;
async function check() {
  const run = ++checkRun;
  const list = $("show-list");
  list.replaceChildren();
  if (!favorites.length) return;

  let pos;
  try { pos = await resolveLocation(); } catch (err) { return; }
  const radius = $("search-radius").value;

  for (const artist of favorites) {
    let events;
    try { events = await findShows(artist, pos, radius); } catch (err) { continue; }
    if (run !== checkRun) return; // a newer check started; drop this one

    for (const ev of events) {
      const venue = ev._embedded?.venues?.[0];
      renderShow(artist, ev, list);

      if (!seen.has(ev.id + ":show")) {
        notify(`${artist} near you`, `${venue?.name || "Venue TBA"} on ${ev.dates.start.localDate}`);
        markSeen(ev.id + ":show");
      }
      const saleStart = ev.sales?.public?.startDateTime;
      const hoursLeft = saleStart ? (new Date(saleStart) - Date.now()) / 36e5 : null;
      if (hoursLeft > 0 && hoursLeft < 24 && !seen.has(ev.id + ":soon")) {
        notify("Tickets drop soon", `${artist} goes on sale ${new Date(saleStart).toLocaleString()}`);
        markSeen(ev.id + ":soon");
      }
    }
  }
}

/* ---------- email alerts ---------- */
$("alert-form").onsubmit = async (e) => {
  e.preventDefault();
  const status = $("alert-status");
  try {
    if (!favorites.length) throw new Error("Add at least one artist first.");
    const pos = await resolveLocation();
    status.textContent = "Sending…";
    const res = await fetch("/api/subscription", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: $("alert-email").value.trim(),
        artists: favorites,
        lat: pos.lat,
        lon: pos.lon,
        label: pos.label,
        radius: Number($("search-radius").value),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong. Try again.");
    status.textContent = data.message;
  } catch (err) {
    status.textContent = err.message;
  }
};

$("enable-notifications").onclick = () => {
  if ("Notification" in window) Notification.requestPermission();
};

/* ---------- start ---------- */
renderChips();
const savedCity = loadJSON("tw.city", "");
if (savedCity) {
  $("search-city").value = savedCity;
  runSearch("");
  check();
} else {
  $("search-status").textContent = "Enter your city to see concerts near you.";
}
setInterval(check, 60 * 60 * 1000); // refresh your artists hourly while the tab is open
