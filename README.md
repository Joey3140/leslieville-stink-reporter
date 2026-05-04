# Leslieville Stink Reporter

Public, community-run odour reporting portal for residents near Toronto's Ashbridges Bay wastewater treatment plant. Submit reports in seconds; see live heatmap by Forward Sortation Area; subscribe to alerts when your area crosses a threshold.

> Built in response to Coun. Paula Fletcher (Toronto-Danforth) noting that the city's existing 311 system isn't capturing the scale of the problem ("the Leslieville stench").

---

## Stack

- Node.js 22.x · Express · vanilla JS frontend (no build step)
- Firestore (Firebase Admin SDK) · Pino · Zod
- Leaflet + CARTO/OSM tiles · static FSA GeoJSON
- Cloudflare Turnstile (free, no signup) · Resend (email alerts, v1.1)
- Vercel serverless

## Local development

```bash
npm install
cp /dev/null .env   # then paste env vars below
npm run dev         # http://localhost:3000
```

Without a real Firebase project the API routes return 500 (Firestore unavailable). Static pages, `/api/config`, and `/api/reports/meta` work fully offline. To smoke test routes without real Firestore, set `RATE_LIMIT_WHITELIST_IPS=::1,127.0.0.1` so requests reach the validators.

### Required environment variables

```
# Firebase (required)
FIREBASE_SERVICE_ACCOUNT='{...}'   # full service account JSON, single-line escaped

# Cloudflare Turnstile (required for production submissions)
TURNSTILE_SITE_KEY=
TURNSTILE_SECRET_KEY=
# Use 1x0000000000000000000000000000000AA + token "XXXX.DUMMY.TOKEN.XXXX" for tests
# https://developers.cloudflare.com/turnstile/troubleshooting/testing/

# Resend (required when alerts subsystem ships in Phase 3)
RESEND_API_KEY=
RESEND_FROM='Leslieville Stink Reporter <onboarding@resend.dev>'

# OpenWeatherMap (optional — powers the wind widget on the map; widget hides if unset)
# Free tier: 60 calls/min, 1M/month. Sign up at https://home.openweathermap.org/api_keys
OPENWEATHERMAP_API_KEY=

# App secrets — generate with: openssl rand -hex 32
IP_HASH_SECRET=
CRON_SECRET=

# Operational
RATE_LIMIT_WHITELIST_IPS=        # comma-separated, optional
SUBMISSIONS_PAUSED=false         # kill switch
PUBLIC_BASE_URL=https://leslieville-stink-reporter.vercel.app

# Alert thresholds (Phase 3)
ALERT_THRESHOLD_REPORTS=10
ALERT_THRESHOLD_SEVERITY_AVG=3
ALERT_COOLDOWN_HOURS=6

# Runtime
NODE_ENV=development
PORT=3000
LOG_LEVEL=debug
```

## Firestore setup

Create a Firebase project, enable Firestore in **production mode**, generate a service account key (Project Settings → Service accounts → Generate new private key) and paste the JSON into `FIREBASE_SERVICE_ACCOUNT`.

### Required composite indexes

Firestore will prompt you to create these the first time each query runs. Click the URL in the error log, or pre-create them:

| Collection | Fields |
|---|---|
| `reports` | `status` Asc · `createdAt` Desc |
| `reports` | `clientId` Asc · `ipHash` Asc · `createdAt` Asc |
| `reports` | `status` Asc · `createdAt` Asc · `userConsentedLocation` Asc |
| `reports` | `status` Asc · `fsa` Asc · `createdAt` Asc |
| `daily-counts` | `date` Asc |

### TTL policies (REQUIRED for privacy)

Privacy depends on TTL — without these, IP hashes and reports persist forever despite README claims:

| Collection | Field | Effect |
|---|---|---|
| `reports` | `expiresAt` | Auto-deletes the report (and its ipHash/userAgent/description) after 30 days |
| `rate-limits` | `expiresAt` | Auto-deletes spent rate-limit buckets |

In the Firestore console: **Firestore → TTL → Add policy** for each of the above. Configure once per project.

## FSA boundary data

The map uses pre-clipped GeoJSON for ~12 FSAs around Ashbridges Bay (`public/data/fsa-leslieville.geojson`, ~9KB).

To rebuild:

```bash
mkdir -p /tmp/lsv-fsa
curl -sL https://raw.githubusercontent.com/sachijay/canada_maps/main/exported_files/forward_sortation_areas_simplified.geojson -o /tmp/lsv-fsa/all-canada.geojson
npm run build:fsa
```

The build script reprojects from EPSG:3347 (StatCan Lambert) to WGS84 lat/lng and filters to the watched FSAs.

## API surface

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/reports` | Submit a report (Zod-validated, rate-limited 10/hr/IP, Turnstile-verified) |
| `GET` | `/api/reports/heatmap?window=24h\|7d\|30d\|all` | `{ counts: { fsa: n } }` |
| `GET` | `/api/reports/recent?limit=20` | Last N active reports, public-safe fields |
| `GET` | `/api/reports/dots?window=24h\|7d` | Jittered lat/lng dots for opt-in reports |
| `GET` | `/api/reports/stats` | `{ today, thisWeek, thisYear, uniqueReportersThisWeek }` |
| `GET` | `/api/reports/meta` | Static enums (severity labels, odour types) |
| `GET` | `/api/config` | Public config: Turnstile site key, kill-switch state |

Phase 3 (alerts) adds:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/subscribers` | Subscribe (sends confirmation email) |
| `GET` | `/api/subscribers/confirm?token=…` | Confirm subscription |
| `POST/GET` | `/api/subscribers/unsubscribe` | One-click unsubscribe |
| `POST` | `/api/cron/alert-check` | Cron — every 5 min |
| `POST` | `/api/cron/prune-rate-limits` | Cron — daily |

## Deploy to Vercel

```bash
npm install -g vercel
vercel link        # follow prompts
vercel env add FIREBASE_SERVICE_ACCOUNT
vercel env add TURNSTILE_SITE_KEY
vercel env add TURNSTILE_SECRET_KEY
vercel env add RESEND_API_KEY
vercel env add OPENWEATHERMAP_API_KEY    # optional — wind widget on the map
vercel env add IP_HASH_SECRET            # openssl rand -hex 32
vercel env add CRON_SECRET               # openssl rand -hex 32
vercel env add PUBLIC_BASE_URL           # https://leslieville-stink-reporter.vercel.app
vercel --prod
```

Default deploy URL is `https://leslieville-stink-reporter.vercel.app`. Cron jobs in `vercel.json` run on Hobby with a per-day quota; Pro lifts the quota.

### Cron auth model

Vercel Cron automatically attaches `Authorization: Bearer ${CRON_SECRET}` to every cron request **as long as `CRON_SECRET` is set as a project env variable**. Our `cronAuth` middleware rejects any request without the matching token, so:

- An attacker hitting `/api/cron/alert-check` directly gets 401 (no token).
- Vercel's scheduler hits it with the right token and proceeds.
- If you ever rename `CRON_SECRET`, also update `middleware/cron-auth.js`.

Verify after deploy: `curl -X POST https://leslieville-stink-reporter.vercel.app/api/cron/alert-check` should return 401.

## Privacy

- No login. No name. Email optional (alerts only).
- IPs are HMAC-hashed with a server secret (never stored raw); rate-limit docs auto-expire after 30 days.
- Precise location is opt-in, jittered ~100m before storage and display.
- Description field is capped at 280 chars and scanned for PII (email/phone/address). Flagged reports are held in `pending-review` and only shown after manual approval via the Firestore console.
- Aggregated daily counts per FSA are kept indefinitely as a public record.

## Roadmap

- **v0.1** — reporting + heatmap + recent feed + stats + map dots ✅
- **v0.5** — fresh-eyes findings applied (CSP hardened, deterministic jitter, IP-hash retention via TTL, dedup spoofing prevention, GPS-outside-FSA rejection) ✅
- **v0.9 (this commit)** — email alerts subsystem (Resend, double opt-in, cron-triggered with cooldown + daily cap circuit breaker, one-click unsubscribe) ✅
- **v1.0** — Claude Design output applied to UI; Cloudflare Turnstile + Resend + Firebase keys wired; deployed to Vercel
- **v1.1** — custom sending domain (SPF/DKIM/DMARC), weekly digest, photo uploads, admin moderation UI
