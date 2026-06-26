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

Restore Node dependencies after cloning or after removing `node_modules` with
the same command:

```bash
npm install
```

## Quick Start: Cloudflare Server + Hosted Client

When deploying the server to Cloudflare and hosting the static client on GitHub
Pages, make sure the server allows the browser origin of the client. For the
**deployed Cloudflare Worker** the origin list lives in `ALLOWED_ORIGINS` in
`wrangler.jsonc` (the deploy script prompts for it); the `allowed_origins` in
`config.yaml` shown below applies to the **local Node server**. See
[CORS / Allowed Origins](#cors--allowed-origins) for the full rules, including the
custom-domain + `*.github.io` dual-origin requirement. Set `client_base_url` to
the full public client URL:

```yaml
allowed_origins:
  - https://YOUR-GITHUB-USER.github.io
client_base_url: https://YOUR-GITHUB-USER.github.io/PixelPandemonium_Client
```

If the client is hosted on a custom domain, list both that origin and the
underlying `*.github.io` origin (see the CORS section). The client repository must
point `server_url` and `realtime_url` at the Cloudflare Worker URL or custom
Worker domain.

The guided Cloudflare deployment script can walk through the full server
deployment:

```bash
./scripts/deploy-cloudflare.sh
```

The script checks dependencies, runs `wrangler login`, detects whether the
Worker and D1 database already exist and (on re-deploy) offers to destroy and
recreate each, prompts for the public client URL and allowed browser origins,
creates or configures the D1 database, sets `ADMIN_PASSWORD`,
`DEFAULT_TEACHER_KEY` and `DOWNLOAD_TOKEN` as Cloudflare Worker secrets, applies
remote D1 migrations, and runs `wrangler deploy`. When it finishes it prints the
Worker URL and the resolved environment values, including the secret values you
entered during that run, so run it somewhere private.

If your Cloudflare login can reach more than one account — for example because you
were invited to a shared account as a Workers Platform Admin — the script lists the
accounts after login and lets you pick which one to deploy to. See
[Deploying to someone else's Cloudflare account](#deploying-to-someone-elses-cloudflare-account-delegated-access)
for the full delegation flow.

Re-running the script is safe and is the normal way to ship an update: it reuses
the existing D1 database (your class data is preserved) unless you explicitly
choose to destroy and recreate it, and `wrangler deploy` overwrites the Worker
in place.

To remove the Cloudflare resources named in `wrangler.jsonc`, run:

```bash
./scripts/deploy-cloudflare.sh --destroy
```

Destroy mode logs in, asks you to type `DESTROY`, then deletes the Worker and
the D1 database named in `wrangler.jsonc`. Deleting the D1 database deletes its
stored replay and instance data.

For modest classroom or demo usage, this deployment can run on Cloudflare's free
tier as long as usage stays within Cloudflare's current free limits. At the time
of writing, Cloudflare lists Workers Free at 100,000 requests per day, D1 Free
at 5 million rows read per day, 100,000 rows written per day, and 5 GB total
storage, and Durable Objects are available on Workers Free when using the SQLite
storage backend. If a free-tier limit is exceeded, Cloudflare documents that
further operations of that type fail until limits reset; do not assume the
browser will always receive a simple HTTP `429`. The deploy script never asks
for credit-card information. Workers Free normally should not require billing
details, but account signup and verification requirements are controlled by
Cloudflare and may change.

## Configuration

### Where configuration values come from

This project has two server runtimes that read configuration from completely
separate places. They are **not** synced — a value set for one has no effect on
the other, so when a setting must match across both (for example the allowed
origins), set it in both.

**Local Node/Express server** (`npm start`, `./scripts/deploy-local.sh`), in
increasing order of priority:

1. Built-in defaults in `src/config.js`.
2. `config.yaml` overrides those defaults.
3. `.env` / environment variables override `config.yaml` (highest priority).

`deploy-local.sh` writes the prompted values into `.env`; it never edits
`config.yaml`. Keys it does not prompt for (e.g. `database_path`,
`client_base_url`, `cleanup_interval_minutes`, `sqlite_busy_timeout_ms`) come from
`config.yaml` or the defaults — edit `config.yaml` by hand to change those.

**Cloudflare Worker** (`wrangler deploy`, `./scripts/deploy-cloudflare.sh`):

1. Non-secret values come from `vars` in `wrangler.jsonc`, applied on each deploy.
2. Secrets (`ADMIN_PASSWORD`, `DEFAULT_TEACHER_KEY`, `DOWNLOAD_TOKEN`) are stored
   as Cloudflare Worker secrets by the deploy script, never in a file.
3. A changed `wrangler.jsonc` takes effect only after a redeploy; a variable set
   directly in the Cloudflare dashboard can diverge from the file until the next
   deploy re-applies it.

The Worker reads **only** its `env` bindings (`wrangler.jsonc` `vars` + secrets +
the D1 and Durable Object bindings). It does **not** read `config.yaml` or `.env`
at all — those files apply solely to the local Node server. `deploy-cloudflare.sh`
writes prompted values into `wrangler.jsonc` and stores secrets with Wrangler.

Both deploy scripts print the full effective configuration for their runtime in
the closing summary, so you can audit exactly what will run. For the origin
allow-list specifically, see [CORS / Allowed Origins](#cors--allowed-origins).

### Settings reference

Edit `config.yaml` and create a local `.env` before running or deploying.

- `port`: local Express port.
- `database_path`: SQLite database path for local/Node hosting.
- `allowed_origins`: browser origins allowed to call the API.
- `client_base_url`: public base URL of the static client. Returned URLs are built from this.
- `default_expiration_hours`: default lifetime for a class instance. The default
  is `8760`, roughly 12 months. The public Tetris demo is seeded separately and
  lasts indefinitely.
- `cleanup_interval_minutes`: interval for removing expired replay data.
- `sqlite_busy_timeout_ms`: how long SQLite waits for a locked database before failing a write/read.
- `rate_limit_max_per_second`: maximum short-burst API requests per client IP per second.
- `rate_limit_max_per_minute`: maximum sustained API requests per client IP per minute.
- `rate_limit_max_per_day`: maximum API requests per client IP per day.
- `auth_failure_limit`: failed key/password attempts allowed in the auth-failure window.
- `auth_failure_window_minutes`: minutes in the auth-failure counting window.
- `auth_admin_ban_days`: days to temporarily ban an IP after too many admin password/code failures.
- `auth_teacher_ban_minutes`: minutes to temporarily ban an IP after too many teacher key failures.
- `auth_student_ban_minutes`: minutes to temporarily ban an IP after too many student class-key failures.
- `admin_password`: shared admin password, normally loaded from `.env` or the environment.
- `default_teacher_key`: first global teacher key seeded into the SQLite
  `TEACHER_KEYS` table, normally loaded from `.env` or the environment.
- `download_token`: bearer/query token for `/download`, loaded from `.env`, the environment, or `config.yaml`.
- `legacy_routes_enabled`: keeps old `/insert` and `/retrieve` routes available.
- `cloudflare`: deployment names and D1 database id.

Secrets are configured with environment variables. Copy `.env.example` to `.env`
for local development:

```bash
cp .env.example .env
```

The `.env` format is simple `KEY=value` lines:

```bash
ADMIN_PASSWORD=admin
DEFAULT_TEACHER_KEY=teacher
DOWNLOAD_TOKEN=change-me-before-deploying
ALLOWED_ORIGINS=http://localhost:4000,http://127.0.0.1:4000,https://billmongan.com,https://www.billmongan.com,https://billjr99.github.io
AUTH_FAILURE_LIMIT=5
AUTH_FAILURE_WINDOW_MINUTES=10
AUTH_ADMIN_BAN_DAYS=1
AUTH_TEACHER_BAN_MINUTES=10
AUTH_STUDENT_BAN_MINUTES=10
RATE_LIMIT_MAX_PER_SECOND=3
RATE_LIMIT_MAX_PER_MINUTE=20
RATE_LIMIT_MAX_PER_DAY=10000
LEGACY_ROUTES_ENABLED=false
```

The committed `.env.example` values are intentionally simple local defaults.
`.env` itself is ignored by git and should contain machine-specific secrets.
Change production secret values before public deployment:

- `ADMIN_PASSWORD`: the shared password required by teacher/admin APIs.
- `DEFAULT_TEACHER_KEY`: the default global teacher key seeded into the
  database on every server startup. Local default: `teacher`.
- `DOWNLOAD_TOKEN`: the bearer/query token required by `/download`.
- `ALLOWED_ORIGINS`: comma-separated browser origins allowed to call the API
  (CORS). When set, it overrides `allowed_origins` in `config.yaml` for the local
  Node server. See [CORS / Allowed Origins](#cors--allowed-origins).
- `AUTH_FAILURE_LIMIT`: failed key/password attempts before a temporary IP ban.
- `AUTH_FAILURE_WINDOW_MINUTES`: minutes in the auth-failure counting window.
- `AUTH_ADMIN_BAN_DAYS`: days to ban an IP after too many admin password/code failures. Default: `1`.
- `AUTH_TEACHER_BAN_MINUTES`: minutes to ban an IP after too many teacher key failures. Default: `10`.
- `AUTH_STUDENT_BAN_MINUTES`: minutes to ban an IP after too many student class-key failures. Default: `10`.
- `RATE_LIMIT_MAX_PER_SECOND`: short request burst allowed from one IP. Default:
  `3`, enough for fast clicking but low enough to stop simple automation.
- `RATE_LIMIT_MAX_PER_MINUTE`: sustained requests allowed from one IP.
  Default: `20`.
- `RATE_LIMIT_MAX_PER_DAY`: daily requests allowed from one IP. Default:
  `10000`, intentionally high enough for classrooms sharing one school NAT IP.
- `LEGACY_ROUTES_ENABLED`: enables old `/insert` and `/retrieve` routes.
  Recommended Cloudflare production value: `false`.

When a general request rate limit is exceeded, the server returns HTTP `429`
with a JSON error telling the client to slow down. The general IP limits are
applied as stacked per-second, per-minute, and per-day windows. These general
limits are separate from authentication-failure bans, which also return `429`
after too many bad keys or passwords.

Environment variables override `config.yaml`; for example, set `ADMIN_PASSWORD`,
`PIXEL_PANDEMONIUM_ADMIN_PASSWORD`, `DEFAULT_TEACHER_KEY`, or
`PIXEL_PANDEMONIUM_DEFAULT_TEACHER_KEY` in production. For Cloudflare Workers,
use `./scripts/deploy-cloudflare.sh` to configure `wrangler.jsonc`, create or
reuse the D1 database, and store production secrets with Wrangler. The server
`.env` file is for local Node/Express runs; it is not the production secret
store for the deployed Worker.

## CORS / Allowed Origins

The server only answers browser API calls whose `Origin` is on an allow-list.
A request with **no** `Origin` header (server-to-server, `curl`, the `/health`
probe) is always allowed; browsers, however, always send `Origin` on the
cross-origin `fetch` to the Worker, so a missing entry blocks every student.
A blocked request gets `403 {"error":"Forbidden: Invalid origin"}`. Matching is
case-insensitive.

**Two runtimes, two separate sources — they are not auto-synced:**

| Runtime | Source of allowed origins | Used by |
| --- | --- | --- |
| Cloudflare Worker (production) | `ALLOWED_ORIGINS` in `wrangler.jsonc` | `deploy-cloudflare.sh` (its prompt default is read from `wrangler.jsonc`, **not** `config.yaml`) and a bare `wrangler deploy` |
| Local Node/Express | `allowed_origins` in `config.yaml`, overridden by `ALLOWED_ORIGINS` in `.env` if set | `deploy-local.sh` / `npm start` |

Because the Cloudflare deploy reads its default from `wrangler.jsonc` and the
local server reads `config.yaml`/`.env`, **update the origin list in both places**
when it changes — editing `config.yaml` alone does not affect the deployed Worker.

**Custom-domain GitHub Pages needs two origins.** When the client is served from
a custom domain that fronts GitHub Pages, browsers may report either origin, so
list both the custom domain and the underlying `*.github.io` host. Also list the
`www` and apex hosts separately — `https://www.billmongan.com` does not match an
entry of `https://billmongan.com`. The shipped default covers this project:

```
http://localhost:4000,https://billmongan.com,https://www.billmongan.com,https://billjr99.github.io
```

Both deploy scripts prompt for the origin list and default to the committed
values, so pressing Enter keeps these. To customize, type a comma-separated list
at the prompt.

**A changed `ALLOWED_ORIGINS` only takes effect after a redeploy.** Editing
`wrangler.jsonc` does nothing until you run `./scripts/deploy-cloudflare.sh` (or
`npm run cloudflare:deploy`). If the deployed Worker still rejects an origin that
is already in `wrangler.jsonc`, check for an `ALLOWED_ORIGINS` variable set in the
Cloudflare dashboard, which overrides the file.

**Troubleshooting:** if students are unexpectedly prompted for a class access key
on the public Tetris demo, it is almost always a `403 Forbidden: Invalid origin`
from a missing allowed origin, not a real key problem. Verify with:

```bash
curl -s -H "Origin: https://YOUR-CLIENT-HOST" \
  https://YOUR-WORKER.workers.dev/instance/tetris/status
```

A correctly configured origin returns `200` with `"valid": true`; a blocked
origin returns `403 Forbidden: Invalid origin`. (Space repeated probes a few
seconds apart so the per-IP rate limiter does not answer with `429` first.)

## Local Run

The guided local script prompts for the default admin password, global teacher
key, download token, and the rate-limit / auth-ban protection settings, writes
them to `.env` (which is gitignored), prints a summary, and starts the server:

```bash
./scripts/deploy-local.sh
```

Pass `--no-start` to only (re)write `.env` without launching the server. The
same protections as the Cloudflare Worker apply locally: per-IP request rate
limiting, temporary auth banning on repeated credential failures, and realtime
(Faye) per-IP message rate limiting.

You can still start the server directly once `.env` exists (or let the server
prompt you for any missing required values on first run in a terminal):

```bash
npm start
```

The default server is `http://localhost:8000`. Check:

```bash
curl http://localhost:8000/health
```

`/health` returns a `version` field (the value of `APP_VERSION` in
`src/version.js`) alongside `status`, `runtime`, and the route list. Both
runtimes report the same version, so after a deploy you can confirm the live
build by checking that `version` matches the value you pushed — for example
`curl https://YOUR-WORKER.workers.dev/health`. Bump `APP_VERSION` on every
deploy.

Realtime Faye is mounted at `/faye`.

## Admin Access

Admin access currently has three checks:

1. A per-instance `adminCode`, generated when the teacher creates an instance.
   This code scopes access to one specific instance and appears in the generated
   admin URL.
2. A per-instance `teacherKey`, generated when the teacher creates an instance.
   Teacher/admin URLs include it as `teacherKey=...`.
3. A shared admin password from `.env`/environment configuration. Local default:
   `admin`.

Admin APIs accept the shared password as `adminPassword` in the JSON body, as an
`adminPassword` query parameter, or as the `X-Admin-Password` header. The browser
admin page prompts for it when it is not already in the URL/session.

Teacher portal APIs accept a global teacher key as `teacherAccessKey` in the
JSON body, as a `teacherAccessKey` query parameter, or as the
`X-Teacher-Access-Key` header. A global teacher key is required to create
instances from the teacher-facing create page or to list/administer existing
non-demo instances from the teacher dashboard. Instances created through a
teacher key are owned by that teacher key. Teacher-key access can list, inspect,
animate, and reset only those owned instances; admin-password access can still
list and administer all instances. The server seeds `DEFAULT_TEACHER_KEY=teacher`
locally unless changed, and re-adds that key on startup if it is missing from
the database.

Student/status/replay APIs require the per-instance class key as `key=...`,
`accessKey` in the JSON body, or the `X-Instance-Key` header. Teacher/admin
actions require `teacherKey=...`, `teacherKey` in the JSON body, or the
`X-Teacher-Key` header.

The built-in public Tetris demo is the exception. The server always seeds
`instanceCode=tetris` and `instanceName=tetris` for the bundled Tetris picture.
Anyone can open `instructions.html?instance=tetris`, submit pixels, or retrieve
replay rows without a class key. Anyone can reset it without a key or
admin password. The public demo cannot be deleted or deactivated, and teachers
cannot create another instance named `tetris`.

The Express server enables CORS for configured `allowed_origins` and accepts the
custom key/password headers used by the client. It stores normal application
data in SQLite: instances, replay rows, custom picture specs/artifacts, and
auth-failure throttling. Repeated bad class keys, teacher keys, admin codes, or
admin passwords from the same IP are temporarily blocked. Defaults are
`AUTH_FAILURE_LIMIT=5`, `AUTH_FAILURE_WINDOW_MINUTES=10`,
`AUTH_ADMIN_BAN_DAYS=1`, `AUTH_TEACHER_BAN_MINUTES=10`, and
`AUTH_STUDENT_BAN_MINUTES=10`.

### Protection coverage

Per-IP request rate limiting (`RATE_LIMIT_MAX_PER_SECOND` / `_MINUTE` / `_DAY`)
applies to every HTTP endpoint on both the Node server and the Cloudflare Worker
(CORS preflight `OPTIONS` requests are exempt). Temporary auth banning applies on
every credential check (admin password, student class key, teacher key, admin
code); endpoints with no credential are still rate limited. The realtime
transport is also protected: the connection/upgrade is rate limited like any
request, and each connection/IP is capped at 50 realtime messages per second
with a 64&nbsp;KB max message size. On the Worker this cap lives in the
`PubSubRoom` Durable Object; on the Node server it lives in the Faye `incoming`
extension. The reserved `tetris` demo is exempt from key checks (but not from
rate limiting).

Realtime channels are also access-key authorized, so the realtime transport is
not a way around the class key. A channel is `/faye/messages/<instanceCode>`, and
subscribing to or publishing on it requires that instance's class access key (or
teacher key); the client sends it as `&key=...` on the WebSocket URL and as
`ext.key` on Faye messages. The Worker validates the key at the WebSocket upgrade
and pins each connection to its authorized channel; the Node server validates it
per subscribe/publish in the Faye extension (with a short-lived key cache). An
invalid key is rejected (HTTP `403` on the Worker upgrade, a subscribe/publish
error on Faye), and the `tetris` demo channel is exempt.

Because the client now sends the realtime key, deploy the client before (or with)
the server: an older cached client that omits the key will be denied realtime and
fall back to HTTP persistence with live updates only on reload.

The Cloudflare Worker now supports the same global teacher portal as the Node
server (`/teacher/validate`, `/teacher/instances`, `/teacher-keys`), backed by a
`TEACHER_KEYS` table and a `DEFAULT_TEACHER_KEY` Worker secret, and it requires
an admin password or a valid global teacher key to create instances.

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

## Server `.env` Startup Setup

The `.env` file exists only on the server. The static client never stores,
creates, reads, or modifies a client-side `.env`. The easiest way to create it
is `./scripts/deploy-local.sh`, which prompts for these values (with the current
ones as defaults) and writes the file for you; the keys below document what it
writes.

Required local `.env` values:

```bash
ADMIN_PASSWORD=admin
DEFAULT_TEACHER_KEY=teacher
DOWNLOAD_TOKEN=change-me-before-deploying
ALLOWED_ORIGINS=http://localhost:4000,http://127.0.0.1:4000,https://billmongan.com,https://www.billmongan.com,https://billjr99.github.io
AUTH_FAILURE_LIMIT=5
AUTH_FAILURE_WINDOW_MINUTES=10
AUTH_ADMIN_BAN_DAYS=1
AUTH_TEACHER_BAN_MINUTES=10
AUTH_STUDENT_BAN_MINUTES=10
RATE_LIMIT_MAX_PER_SECOND=3
RATE_LIMIT_MAX_PER_MINUTE=20
RATE_LIMIT_MAX_PER_DAY=10000
LEGACY_ROUTES_ENABLED=false
```

- `ADMIN_PASSWORD` is the shared login required by teacher/admin APIs.
- `DEFAULT_TEACHER_KEY` is the first global teacher key, seeded into the
  database on every startup. The local default is `teacher`.
- `DOWNLOAD_TOKEN` protects the full replay-data export at `/download`.
- `ALLOWED_ORIGINS` is the comma-separated list of browser origins allowed to
  call the API. When set it overrides `allowed_origins` in `config.yaml`. See
  [CORS / Allowed Origins](#cors--allowed-origins).
- `AUTH_FAILURE_LIMIT` and `AUTH_FAILURE_WINDOW_MINUTES` control how many
  failed auth attempts are allowed within the counting window.
- `AUTH_ADMIN_BAN_DAYS`, `AUTH_TEACHER_BAN_MINUTES`, and
  `AUTH_STUDENT_BAN_MINUTES` control how long an IP is banned after too many
  admin, teacher, or student-key failures.
- `RATE_LIMIT_MAX_PER_SECOND`, `RATE_LIMIT_MAX_PER_MINUTE`, and
  `RATE_LIMIT_MAX_PER_DAY` control stacked IP-based throttling. The defaults
  allow fast human clicking and a full classroom behind one shared school IP.
- `LEGACY_ROUTES_ENABLED=false` disables the old unauthenticated `/insert` and
  `/retrieve` routes, which is recommended for Cloudflare production.

Rate-limit failures should return HTTP `429`. The static client should treat
`429` as a recoverable "slow down and try again" response rather than a fatal
class-instance error.

When the server starts, it checks for `.env` and for required keys. If the file
or a required key is missing and the server is running in an interactive
terminal, startup prompts for values with defaults prepopulated for revision and
writes the server-side `.env`. If startup is non-interactive, the server exits
with an error explaining which keys are missing. Until the server has a valid
`.env`, client logins and teacher/admin operations are unavailable because the
server does not finish startup.

## API

### List pictures

The picture catalog lives entirely on the server. The database is prepopulated
with the bundled Pixel Pandemonium image inventory (including the public Tetris
demo); the static client no longer carries a picture list or any picture files —
it fetches `/pictures` for its create/admin menus.

```bash
curl http://localhost:8000/pictures \
  -H 'Origin: http://localhost:4000'
```

Each entry returns `id`, `title`, `script` (always `/pictures/<id>/spec.js`),
`custom` (0 for predefined, 1 for teacher-created), and `numRows`/`numCols`.
`POST /instance/create` validates `pictureId` against this table.

#### Seeded (predefined) pictures

The predefined catalog is stored as protected (`CUSTOM=0`) rows that carry their
full spec in `SPEC_JSON`, served from `/pictures/<id>/spec.js` exactly like custom
pictures. They are **read-only templates**: a teacher selects one to create their
own instance (under their own teacher key / name); the seed images themselves
cannot be modified or overwritten except by an admin (a custom upload can never
target a predefined id — see [Create a custom picture](#create-a-custom-picture)).

The seed data is generated from the original posterizer composite files by
`scripts/extract-picture-specs.js`, which writes two outputs that must always be
regenerated together (never hand-edited):

- `src/data/pictureSeeds.json` — loaded at startup by the Node server's `seedPictures()`.
- `migrations/0003_seed_picture_specs.sql` — applied to D1/Cloudflare via `wrangler d1 migrations apply`.

To re-run after the source composites change:

```bash
node scripts/extract-picture-specs.js [path-to-PixelPandemonium_Client]
```

The 16 seeded images: `tetris` (Demo (Tetris)), `cs4allpa2022`, `cs4philly2021`,
`cs4philly2022`, `eagles`, `eagles2`, `ghopper`, `lovestatue`, `mikewazowski`,
`phillyscifest`, `pixar2022`, `robotspringboard`, `robotspringboard2022`,
`rocky2022`, `yellowsubmarine`, `yellowsubmarine2022`.

The table also stores teacher-created custom pictures (`CUSTOM=1`).

### Create a custom picture

Custom pictures are normalized to the same runtime data shape as the original
posterizer composite JavaScript files:

```json
{
  "palette": [[255, 255, 255], [0, 0, 0]],
  "numRows": 1,
  "numCols": 1,
  "pages": [
    {
      "col": "A",
      "row": "1",
      "uncompressed": [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
      "compressed": [1, 0, 1, 1]
    }
  ]
}
```

`compressed` is optional. The server regenerates it when missing.

```bash
curl -X POST http://localhost:8000/pictures/custom \
  -H 'Origin: http://localhost:4000' \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "Class Logo",
    "teacherAccessKey": "teacher",
    "spec": {
      "palette": [[255,255,255],[0,0,0]],
      "numRows": 1,
      "numCols": 1,
      "pages": [
        {"col":"A","row":"1","uncompressed":[0,1,0,1,0,1,0,1,0,1,0,1,0,1,0]}
      ]
    }
  }'
```

The response includes `id`, `script`, `specUrl`, and `zipUrl`. Use the returned
`id` as `pictureId` when creating an instance.

### Download custom spec files

```bash
curl http://localhost:8000/pictures/CUSTOM-PICTURE-ID/spec.js \
  -H 'Origin: http://localhost:4000'

curl -o specs.zip http://localhost:8000/pictures/CUSTOM-PICTURE-ID/spec-files.zip \
  -H 'Origin: http://localhost:4000'
```

The zip contains generated posterizer-style files: composite JS, composite CSV,
uncompressed TXT, compressed TXT, color map TXT, and color map HTML.

### Create an instance

```bash
curl -X POST http://localhost:8000/instance/create \
  -H 'Origin: http://localhost:4000' \
  -H 'Content-Type: application/json' \
  -d '{
    "pictureId": "tetris",
    "teacherName": "Ada Lovelace",
    "dateTime": "2026-06-23T10:30:00",
    "teacherAccessKey": "teacher"
  }'
```

The response includes `instanceCode`, `adminCode`, `accessKey`, `teacherKey`,
`studentUrl`, `replayUrl`, `teacherUrl`, `adminUrl`, and `expiresAt`.
Status/admin responses also include `pictureTitle`; custom pictures include
`pictureCustom`, `pictureSpecUrl`, and `pictureZipUrl` so the static client can
load the server-served spec.

`instanceName` is optional in the create request. It must be unique when
provided. If omitted, the server uses the generated `instanceCode` as the unique
instance name. The name `tetris` is reserved for the built-in public demo. The
`studentUrl` is the teacher-shareable URL for that specific
instance and includes the class key. The `teacherUrl` and `adminUrl` include the
separate teacher key.

Omit `expirationHours` to use the configured 12-month default, or provide a
positive hour count to override it for that one instance.

Admin-created instances may send `adminPassword` instead of `teacherAccessKey`.

### Validate an instance

```bash
curl "http://localhost:8000/instance/INSTANCE-CODE/status?key=CLASS-KEY" \
  -H 'Origin: http://localhost:4000'
```

### Insert replay data

```bash
curl -X POST http://localhost:8000/instance/INSTANCE-CODE/insert \
  -H 'Origin: http://localhost:4000' \
  -H 'Content-Type: application/json' \
  -d '{"accessKey":"CLASS-KEY","data":"0,0,10,10,#ff0000,0,0"}'
```

### Retrieve replay data

```bash
curl "http://localhost:8000/instance/INSTANCE-CODE/retrieve?key=CLASS-KEY" \
  -H 'Origin: http://localhost:4000'
```

### Reset an instance

```bash
curl -X POST http://localhost:8000/instance/INSTANCE-CODE/reset \
  -H 'Origin: http://localhost:4000' \
  -H 'Content-Type: application/json' \
  -d '{"adminCode":"ADMIN-CODE","teacherKey":"TEACHER-KEY","adminPassword":"admin"}'
```

### Admin inspect an instance

```bash
curl "http://localhost:8000/instance/INSTANCE-CODE/admin?admin=ADMIN-CODE&teacherKey=TEACHER-KEY&adminPassword=admin" \
  -H 'Origin: http://localhost:4000'
```

Returns instance metadata plus replay rows. This is used by `admin.html`.

### List active instances

```bash
curl "http://localhost:8000/instances?adminPassword=admin" \
  -H 'Origin: http://localhost:4000'
```

Returns active instances, picture metadata, keys, admin codes, and generated
student/replay/teacher/admin URLs. This powers the admin page landing view when
`admin.html` is opened without a specific instance code.

### Validate a global teacher key

```bash
curl "http://localhost:8000/teacher/validate?teacherAccessKey=teacher" \
  -H 'Origin: http://localhost:4000'
```

### List instances as a teacher

```bash
curl "http://localhost:8000/teacher/instances?teacherAccessKey=teacher" \
  -H 'Origin: http://localhost:4000'
```

This powers the teacher dashboard after a global teacher key is accepted.
The response includes only instances created by that same global teacher key.

### Manage global teacher keys

```bash
curl "http://localhost:8000/teacher-keys?adminPassword=admin" \
  -H 'Origin: http://localhost:4000'

curl -X POST http://localhost:8000/teacher-keys \
  -H 'Origin: http://localhost:4000' \
  -H 'Content-Type: application/json' \
  -d '{"teacherKey":"section-a","label":"Section A","adminPassword":"admin"}'
```

Only admin access can list or create global teacher keys. Duplicate teacher
keys, including the configured default teacher key, are rejected with `409`.

### Rotate class or teacher keys

```bash
curl -X POST http://localhost:8000/instance/INSTANCE-CODE/rotate-key \
  -H 'Origin: http://localhost:4000' \
  -H 'Content-Type: application/json' \
  -d '{"keyType":"student","adminCode":"ADMIN-CODE","teacherKey":"TEACHER-KEY","adminPassword":"admin"}'
```

Use `"keyType":"student"` to reset the class key in student/replay links. Use
`"keyType":"teacher"` to reset the teacher/admin key. Old links containing the
rotated key stop working.

### Update one replay row

```bash
curl -X POST http://localhost:8000/instance/INSTANCE-CODE/event/ROW-ID/update \
  -H 'Origin: http://localhost:4000' \
  -H 'Content-Type: application/json' \
  -d '{"adminCode":"ADMIN-CODE","teacherKey":"TEACHER-KEY","adminPassword":"admin","data":"0,0,10,10,#00ff00,0,0"}'
```

### Delete one replay row

```bash
curl -X POST http://localhost:8000/instance/INSTANCE-CODE/event/ROW-ID/delete \
  -H 'Origin: http://localhost:4000' \
  -H 'Content-Type: application/json' \
  -d '{"adminCode":"ADMIN-CODE","teacherKey":"TEACHER-KEY","adminPassword":"admin"}'
```

### Delete or deactivate an instance

```bash
curl -X POST http://localhost:8000/instance/INSTANCE-CODE/deactivate \
  -H 'Origin: http://localhost:4000' \
  -H 'Content-Type: application/json' \
  -d '{"adminCode":"ADMIN-CODE","teacherKey":"TEACHER-KEY","adminPassword":"admin"}'
```

Instances cannot be deleted or deactivated. The legacy
`/instance/:code/deactivate` and `/instance/:code/delete` routes are retained
only to return `403` with `Instances cannot be deactivated or deleted`.

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
- The server validates the selected picture against the bundled image inventory.
- A teacher can upload outside posterizer specs or a browser-generated image spec,
  store it as a custom picture, download generated spec files, and create an
  instance from that custom picture.
- The teacher shares the student QR code or URL.
- Student and replay URLs include a class key and cannot be used with only the
  guessed instance code.
- Teacher/admin URLs include a separate teacher key and cannot be used with only
  the guessed instance/admin code.
- A global teacher key is required to create instances or use the teacher
  dashboard for non-demo instances, and teachers only see/administer instances
  created with that same global teacher key.
- Students submit tile pixels into that instance only.
- The teacher opens the replay URL and watches live updates.
- A teacher resets an instance for practice or reuse.
- A teacher/admin edits or deletes individual replay rows from the admin page.
- Instances cannot be deleted or deactivated.
- A teacher/admin rotates the class key or teacher key from the admin page when
  a link needs to be invalidated.
- A teacher/admin generates time-lapse animations from actual instance data or from the finished product, including unfinished activities.
- Two teachers can use the same picture at the same time without data collision.
- Expired instances reject new writes and clear replay data during cleanup.

## Tests

Run:

```bash
npm install
./test.sh
```

The harness runs unit tests first, then reads `config.yaml`, starts the server if
it is not already running, creates static and custom instances, verifies seeded
pictures, custom spec JS, custom spec zip downloads, isolation, reset,
invalid-code handling, and legacy routes.
It also verifies class-key enforcement, teacher-key enforcement, key rotation,
unique instance-name enforcement, and temporary IP blocking after repeated bad
auth attempts.

Unit tests only:

```bash
npm run test:unit
```

API integration tests only:

```bash
npm run test:integration
```

If `node_modules` is missing, run `npm install` first.

Some Node/npm tooling may print:

```text
The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.
```

This is only terminal color configuration. `FORCE_COLOR` takes precedence over
`NO_COLOR`; unset `FORCE_COLOR` if you want `NO_COLOR` to suppress colored test
output.

## Cloudflare Deployment

Cloudflare Workers cannot run the Express/Faye server process directly. This repository includes a compatible Worker adapter in `src/cloudflare-worker.ts` using D1 for SQLite-compatible storage and Durable Objects for WebSocket pub/sub.

### Prerequisites

Before deploying to Cloudflare, you must have:

1. A **Cloudflare account**: Sign up at https://dash.cloudflare.com/sign-up if you don't already have one. A free account is sufficient for testing and modest classroom usage.
2. A **Cloudflare Workers account**: Cloudflare Workers are included with all Cloudflare plans. Workers are available on the free tier, but you will need to verify your account and enable Workers when prompted.
3. **Wrangler CLI**: The Cloudflare command-line tool will be installed via `npm install` in the steps below.

### Deployment Steps

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

### Deploying to someone else's Cloudflare account (delegated access)

You can deploy this server into another person's or an organization's Cloudflare
account — for example a school or shared classroom account — without anyone sharing
their password. The account owner invites you instead:

1. In **their** Cloudflare dashboard, go to **Manage Account → Members → Invite**.
2. Invite your email and grant the **Workers Platform Admin** permission. This is the
   right role for a team member or a back-up admin: it lets you manage Workers, D1,
   Durable Objects, and secrets without full account access.

Once you accept the invite, your own `wrangler login` authenticates as **you**, while
the deploy targets **their** account. You just have to tell Wrangler which account to
use, because `wrangler.jsonc` does not pin an `account_id`.

1. Find the target account ID. After `npx wrangler login`, run:

```bash
npx wrangler whoami
```

This prints the **Account Name** and **Account ID** for every account your login can
reach — your own and any you were invited to. Copy the ID of the account you want to
deploy to.

2. Point the deploy at that account by exporting the ID before running it:

```bash
export CLOUDFLARE_ACCOUNT_ID=<their-account-id>
./scripts/deploy-cloudflare.sh
```

Every Wrangler step (D1 create, secrets, remote migrations, `wrangler deploy`) then
runs against that account, and the Worker is published on their `*.workers.dev`
subdomain. Run `unset CLOUDFLARE_ACCOUNT_ID` when you want to deploy to your own
account again.

You do not have to set the variable by hand: `./scripts/deploy-cloudflare.sh` runs
`wrangler whoami` after login, and when your login can reach more than one account it
shows a numbered menu and sets `CLOUDFLARE_ACCOUNT_ID` to your choice for the rest of
the run. An account ID already present in the environment is respected and skips the
menu.

The Cloudflare adapter exposes the same HTTP routes. Realtime uses a WebSocket channel contract rather than the Faye Node client, because Faye’s Node adapter is not supported in Workers.

After Cloudflare deploys, update the client `config.yaml`:

```yaml
server_url: https://your-worker.your-subdomain.workers.dev
realtime_url: https://your-worker.your-subdomain.workers.dev
base_url: https://your-github-user.github.io/PixelPandemonium_Client
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
client_base_url: https://your-github-user.github.io/PixelPandemonium_Client
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
base_url: https://your-github-user.github.io/PixelPandemonium_Client
```
