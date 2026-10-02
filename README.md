# flightlog

A small self-hosted pilot logbook. Anyone can browse your flights, totals, and currency. Only you can add, edit, or delete entries, after signing in with Google.

- **Totals:** total time, PIC, dual received, cross-country, night, actual and simulated instrument, day and night landings, and approaches
- **Currency panel:** date of last flight, flight review due date (24 calendar months), medical certificate expiration (class and exam date entered on the site; 24 or 60 calendar months by age), and 90-day day and night passenger currency
- **Summaries:** hours by year and hours by aircraft
- **Searchable flight list,** grouped by year, with a detail view for each flight and CSV export
- **Privacy controls:** instructor names and certificate numbers, and your private notes, are hidden from visitors who aren't signed in (configurable)
- **Audit trail:** every add, edit, and delete is written to an `audit` table
- **Small footprint:** Python (FastAPI) + SQLite + one static page. Runs in about 60 MB of RAM.

## Quick start (Docker)

```bash
git clone https://github.com/jbzambon/flightlog.git && cd flightlog
cp .env.example .env            # fill in DOMAIN, ALLOWED_EMAILS, SECRET_KEY, GOOGLE_CLIENT_ID
docker compose up -d --build
```

Point a DNS A record for your `DOMAIN` at the server. The bundled Caddy container gets an HTTPS certificate automatically.

If you already run a reverse proxy, remove the `caddy` service from `docker-compose.yml` and proxy to the `flightlog` container on port 8081. Also send the header `Cross-Origin-Opener-Policy: same-origin-allow-popups`; the Google sign-in popup needs it.

## Google sign-in

1. In [Google Cloud Console](https://console.cloud.google.com), go to **Google Auth Platform** and configure the consent screen: set the audience to External and add yourself as a test user. Only the basic *email* and *profile* scopes are used, so Google doesn't need to verify the app.
2. Go to **Clients → Create client** and choose **Web application**. Under *Authorized JavaScript origins*, add `https://<your DOMAIN>`. Leave the redirect URIs empty.
3. Put the client ID in `.env` as `GOOGLE_CLIENT_ID` and restart. There's no client secret to manage.

Only the addresses listed in `ALLOWED_EMAILS` can edit.

## Loading your existing logbook

On first start, if the database is empty, the app loads `app/seed_flights.json`. That file is in `.gitignore`, so your data never ends up in the repo. It uses the same format as [`app/seed_flights.example.json`](app/seed_flights.example.json): a list of flights with these fields:

| Field | Meaning |
|---|---|
| `date` | `YYYY-MM-DD` (required) |
| `aircraft_type`, `tail` | e.g. `C-172S`, `N12345` |
| `dep`, `arr`, `via` | airport identifiers; put stops en route in `via`, comma-separated |
| `day_to`, `night_to`, `day_ldg`, `night_ldg`, `approaches` | counts |
| `total` (required), `se`, `me`, `pic`, `dual`, `xc`, `night`, `actual`, `hood`, `ground` | hours |
| `instructor`, `remarks`, `notes` | text; `instructor` and `notes` are hidden from the public by default |
| `page` | page number in your paper logbook |
| `flight_review` | `true` on a flight where you completed a flight review or checkride (feeds the currency panel) |

To try the app with demo data, set `SEED_FILE=/app/seed_flights.example.json`.

## Configuration (`.env`)

| Variable | Default | |
|---|---|---|
| `SITE_TITLE` | `Flight Log` | header and browser tab title |
| `SITE_FOOTER` | empty | optional note under the flight list |
| `HOME_AIRPORT` | empty | pre-fills From/To on new flights |
| `SOURCE_URL` | this repo | "Source code on GitHub" link in the footer; set empty to hide |
| `GOOGLE_CLIENT_ID` | | see above |
| `ALLOWED_EMAILS` | | comma-separated list of accounts that can edit |
| `SECRET_KEY` | | signs the session cookie; use a long random string |
| `PUBLIC_HIDDEN_FIELDS` | `instructor,notes` | fields hidden from signed-out visitors |
| `FLIGHTLOG_DB` | `/data/flightlog.db` in Docker | SQLite database path |
| `COOKIE_SECURE` | `true` | set `false` only for local HTTP testing |

## Running locally without Docker

```bash
pip install -r requirements.txt
cd app && SECRET_KEY=dev COOKIE_SECURE=false SEED_FILE=seed_flights.example.json uvicorn main:app --reload
```

## Backups

All your data is in one SQLite file. Back it up with:

```bash
sqlite3 data/flightlog.db ".backup 'flightlog-$(date +%F).db'"
```

**Export CSV** on the site gives you a portable copy.

## License

MIT
