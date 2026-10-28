// Sends one email through Resend. Needs RESEND_API_KEY and FROM_EMAIL.
export async function sendEmail({ to, subject, html }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.FROM_EMAIL;
  if (!key || !from) throw new Error("Email is not set up (RESEND_API_KEY / FROM_EMAIL).");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, html }),
  });
  if (!res.ok) throw new Error("Email provider error " + res.status + ": " + (await res.text()));
}

// Makes text safe to place inside HTML.
export const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
