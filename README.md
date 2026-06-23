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

Edit `config.yaml` before running or deploying.

- `port`: local Express port.
- `database_path`: SQLite database path for local/Node hosting.
- `allowed_origins`: browser origins allowed to call the API.
- `client_base_url`: public base URL of the static client. Returned URLs are built from this.
- `default_expiration_hours`: default lifetime for a class instance.
- `cleanup_interval_minutes`: interval for removing expired replay data.
- `download_token`: bearer/query token for `/download`.
- `legacy_routes_enabled`: keeps old `/insert` and `/retrieve` routes available.
- `cloudflare`: deployment names and D1 database id.

## Local Run

```bash
npm start
```

The default server is `http://localhost:8000`. Check:

```bash
curl http://localhost:8000/health
```

Realtime Faye is mounted at `/faye`.

## API

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
  -d '{"adminCode":"ADMIN-CODE"}'
```

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
- The teacher shares the student QR code or URL.
- Students submit tile pixels into that instance only.
- The teacher opens the replay URL and watches live updates.
- A teacher resets an instance for practice or reuse.
- Two teachers can use the same picture at the same time without data collision.
- Expired instances reject new writes and clear replay data during cleanup.

## Tests

Run:

```bash
./test.sh
```

The harness reads `config.yaml`, starts the server if it is not already running, creates two instances, verifies isolation, reset, invalid-code handling, and legacy routes.

If `node_modules` is missing, run `npm install` first.

## Cloudflare Deployment

Cloudflare Workers cannot run the Express/Faye server process directly. This repository includes a compatible Worker adapter in `src/cloudflare-worker.ts` using D1 for storage and Durable Objects for WebSocket pub/sub.

1. Install dependencies.
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
