# Tour Watch

Folder layout
- public/               the website (index.html, style.css, app.js)
- netlify/functions/    the server pieces (key-hiding proxy, email sign-up, hourly alert check)
- netlify/lib/          shared email helper
- netlify.toml, package.json

Environment variables to set in Netlify (Site configuration > Environment variables):
- TICKETMASTER_KEY  your (new) Ticketmaster Consumer Key
- RESEND_API_KEY    your Resend API key
- FROM_EMAIL        e.g. Tour Watch <alerts@yourdomain.com>  (domain must be verified in Resend)
- SITE_URL          your site's address, e.g. https://tour-watch.netlify.app
- CRON_SECRET       any long random string you make up

Test locally with: npx netlify dev  (needs Node.js; opens the site and the /api routes)
