# Pixel Pandemonium Server

Node Express/Faye backend for Pixel Pandemonium. It stores replay events, serves instance-scoped APIs, and provides realtime pub/sub channels for live replay.

## Requirements

- Node.js 18 or newer
- npm
- SQLite support through the `sqlite3` npm package
- Optional for Cloudflare: Wrangler and a Cloudflare account

Install dependencies:

```bash
npm install
```

## Configuration

Edit `config.yaml` and `.env` before running or deploying.

- `port`: local Express port.
- `database_path`: SQLite database path for local/Node hosting.
- `allowed_origins`: browser origins allowed to call the API.
- `client_base_url`: public base URL of the static client. Returned URLs are built from this.
- `default_expiration_hours`: default lifetime for a class instance.
- `cleanup_interval_minutes`: interval for removing expired replay data.
- `sqlite_busy_timeout_ms`: how long SQLite waits for a locked database before failing a write/read.
- `rate_limit_max_per_minute`: maximum API requests per client IP per minute.
- `admin_password`: shared admin password, normally loaded from `.env`.
- `download_token`: bearer/query token for `/download`.
- `legacy_routes_enabled`: keeps old `/insert` and `/retrieve` routes available.
- `cloudflare`: deployment names and D1 database id.

`.env` contains local secrets and defaults:

```bash
ADMIN_PASSWORD=admin
DOWNLOAD_TOKEN=change-me-before-deploying
```

The committed values are intentionally simple local defaults. Change both values
before public deployment. Environment variables override `config.yaml`; for
example, set `ADMIN_PASSWORD` or `PIXEL_PANDEMONIUM_ADMIN_PASSWORD` in production.

## Local Run

Terminal 1:

```bash
npm start
```

The default server is `http://localhost:8000`. Check:

```bash
curl http://localhost:8000/health
```

Realtime Faye is mounted at `/faye`.

## Admin Access

Admin access currently has two checks:

1. A per-instance `adminCode`, generated when the teacher creates an instance.
   This code scopes access to one specific instance and appears in the generated
   admin URL.
2. A shared admin password from `.env`/environment configuration. Local default:
   `admin`.

Admin APIs accept the shared password as `adminPassword` in the JSON body, as an
`adminPassword` query parameter, or as the `X-Admin-Password` header. The browser
admin page prompts for it when it is not already in the URL/session.

### Diagnostics

The server logs structured JSON lines to stdout/stderr. Each HTTP request gets a
`requestId`, start log, finish log, status code, duration, origin, and IP. Server
errors include the request id, route, status, error code, message, and stack.

Example error response:

```json
{
  "valid": false,
  "error": "SQLITE_BUSY: database is locked",
  "requestId": "lxp3l9jn-2c"
}
```

Use the `requestId` from a browser/client error to find the matching server log.
For local classroom demos, `config.yaml` sets a higher request limit and a SQLite
busy timeout so rapid student canvas submissions wait instead of failing during
brief write contention.

Terminal 2 can run the test harness:

```bash
./test.sh
```

## API

### List pictures

The server prepopulates the database with the original CS173 Pixel Pandemonium image inventory.

```bash
curl http://localhost:8000/pictures \
  -H 'Origin: http://localhost:4000'
```

`POST /instance/create` validates `pictureId` against this table.

### Create an instance

```bash
curl -X POST http://localhost:8000/instance/create \
  -H 'Origin: http://localhost:4000' \
  -H 'Content-Type: application/json' \
  -d '{
    "pictureId": "tetris",
    "teacherName": "Ada Lovelace",
    "dateTime": "2026-06-23T10:30:00",
    "expirationHours": 72
  }'
```

The response includes `instanceCode`, `adminCode`, `studentUrl`, `replayUrl`, `adminUrl`, and `expiresAt`.

### Validate an instance

```bash
curl http://localhost:8000/instance/INSTANCE-CODE/status \
  -H 'Origin: http://localhost:4000'
```

### Insert replay data

```bash
curl -X POST http://localhost:8000/instance/INSTANCE-CODE/insert \
  -H 'Origin: http://localhost:4000' \
  -H 'Content-Type: application/json' \
  -d '{"data":"0,0,10,10,#ff0000,0,0"}'
```

### Retrieve replay data

```bash
curl http://localhost:8000/instance/INSTANCE-CODE/retrieve \
  -H 'Origin: http://localhost:4000'
```

### Reset an instance

```bash
curl -X POST http://localhost:8000/instance/INSTANCE-CODE/reset \
  -H 'Origin: http://localhost:4000' \
  -H 'Content-Type: application/json' \
  -d '{"adminCode":"ADMIN-CODE","adminPassword":"admin"}'
```

### Admin inspect an instance

```bash
curl "http://localhost:8000/instance/INSTANCE-CODE/admin?admin=ADMIN-CODE&adminPassword=admin" \
  -H 'Origin: http://localhost:4000'
```

Returns instance metadata plus replay rows. This is used by `admin.html`.

### Update one replay row

```bash
curl -X POST http://localhost:8000/instance/INSTANCE-CODE/event/ROW-ID/update \
  -H 'Origin: http://localhost:4000' \
  -H 'Content-Type: application/json' \
  -d '{"adminCode":"ADMIN-CODE","adminPassword":"admin","data":"0,0,10,10,#00ff00,0,0"}'
```

### Delete one replay row

```bash
curl -X POST http://localhost:8000/instance/INSTANCE-CODE/event/ROW-ID/delete \
  -H 'Origin: http://localhost:4000' \
  -H 'Content-Type: application/json' \
  -d '{"adminCode":"ADMIN-CODE","adminPassword":"admin"}'
```

### Deactivate an instance

```bash
curl -X POST http://localhost:8000/instance/INSTANCE-CODE/deactivate \
  -H 'Origin: http://localhost:4000' \
  -H 'Content-Type: application/json' \
  -d '{"adminCode":"ADMIN-CODE","adminPassword":"admin"}'
```

Deactivate is a soft delete. It sets `ACTIVE = 0`, preserves the instance row and replay data, and makes the instance behave as not found for student/status/replay access. The legacy `/instance/:code/delete` route is retained as an alias for deactivation.

## Instance Codes

Codes are generated from:

- picture prefix
- teacher-name token
- requested date/time token
- two random digits
- Luhn-style check digit

The browser catches most typos locally, and the server still validates code format, existence, and expiration.

## Use Cases

- A teacher creates an instance for a picture and class time.
- The server validates the selected picture against the prepopulated original CS173 image inventory.
- The teacher shares the student QR code or URL.
- Students submit tile pixels into that instance only.
- The teacher opens the replay URL and watches live updates.
- A teacher resets an instance for practice or reuse.
- A teacher/admin edits or deletes individual replay rows from the admin page.
- A teacher/admin deactivates an instance without deleting stored replay data.
- A teacher/admin generates time-lapse animations from actual instance data or from the finished product, including unfinished activities.
- Two teachers can use the same picture at the same time without data collision.
- Expired instances reject new writes and clear replay data during cleanup.

## Tests

Run:

```bash
npm install
./test.sh
```

The harness runs unit tests first, then reads `config.yaml`, starts the server if it is not already running, creates two instances, verifies seeded pictures, isolation, reset, invalid-code handling, and legacy routes.

Unit tests only:

```bash
npm run test:unit
```

API integration tests only:

```bash
npm run test:integration
```

If `node_modules` is missing, run `npm install` first.

## Cloudflare Deployment

Cloudflare Workers cannot run the Express/Faye server process directly. This repository includes a compatible Worker adapter in `src/cloudflare-worker.ts` using D1 for storage and Durable Objects for WebSocket pub/sub.

1. Install dependencies:

```bash
npm install
```

2. Log in:

```bash
npx wrangler login
```

3. Create a D1 database:

```bash
npm run cloudflare:db:create
```

4. Put the printed database id into `wrangler.jsonc`.
5. Apply migrations:

```bash
npm run cloudflare:db:migrate:remote
```

6. Deploy:

```bash
npm run cloudflare:deploy
```

The Cloudflare adapter exposes the same HTTP routes. Realtime uses a WebSocket channel contract rather than the Faye Node client, because Faye’s Node adapter is not supported in Workers.

After Cloudflare deploys, update the client `config.yaml`:

```yaml
server_url: https://your-worker.your-subdomain.workers.dev
realtime_url: https://your-worker.your-subdomain.workers.dev
base_url: https://your-github-user.github.io/PixelPandemonium_client
```

Then deploy the client to GitHub Pages from its `gh-pages` branch.

## Replit Deployment

The Node Express/Faye server can also run on Replit. This is supported for testing or simple hosting, although the project is designed to avoid depending on Replit long term.

1. Create a Node.js Repl.
2. Upload or clone this server repository.
3. Install dependencies:

```bash
npm install
```

4. Configure `config.yaml`:

```yaml
allowed_origins:
  - https://your-github-user.github.io
client_base_url: https://your-github-user.github.io/PixelPandemonium_client
database_path: ./main.db
```

5. Start the server:

```bash
npm start
```

The server honors Replit’s `PORT` environment variable when present, falling back to `config.yaml` `port` locally. SQLite data is stored in `main.db` in the Repl filesystem.

After Replit starts, update the client `config.yaml`:

```yaml
server_url: https://your-repl-url.replit.app
realtime_url: https://your-repl-url.replit.app
base_url: https://your-github-user.github.io/PixelPandemonium_client
```
