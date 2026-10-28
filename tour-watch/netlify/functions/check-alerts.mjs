// Runs every hour. It only starts the long-running job, because scheduled
// functions have a short time limit.
export default async () => {
  const site = (process.env.SITE_URL || "").replace(/\/$/, "");
  const secret = process.env.CRON_SECRET;
  if (!site || !secret) {
    console.log("Set SITE_URL and CRON_SECRET in Netlify to turn on alerts.");
    return;
  }
  const res = await fetch(site + "/.netlify/functions/check-alerts-background", {
    method: "POST",
    headers: { "x-cron-secret": secret },
  });
  console.log("Started alert check:", res.status);
};

export const config = { schedule: "@hourly" };
