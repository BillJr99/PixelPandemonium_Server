const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawn } = require("node:child_process");

// Integration tests for the server-side picture catalog: predefined (seeded)
// pictures are stored in the DB, served from /pictures/:id/spec.js, selectable for
// instance creation, and immutable to teacher edits. These boot the real Node
// server, so they require dependencies to be installed (npm install). They mirror
// the harness in rateLimit.test.js.

const ORIGIN = "http://localhost:4000";
const HEADERS = { Origin: ORIGIN };
const ADMIN_HEADERS = { Origin: ORIGIN, "content-type": "application/json", "x-admin-password": "admin" };

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// This suite runs against the realistic per-IP rate limits from config.yaml
// (rather than disabling them) and paces every request to stay under the
// per-second cap, so it never trips the limiter. Each test gets a fresh server,
// so its few requests also stay well under the per-minute cap.
const RATE_LIMIT_PER_SECOND = 3; // mirrors config.yaml rate_limit_max_per_second
const REQUEST_SPACING_MS = Math.ceil(1000 / RATE_LIMIT_PER_SECOND) + 120; // ~454ms, safely under 3/sec

let nextRequestAt = 0;
async function rl(url, opts) {
  const now = Date.now();
  if (now < nextRequestAt) await delay(nextRequestAt - now);
  nextRequestAt = Date.now() + REQUEST_SPACING_MS;
  return fetch(url, opts);
}

async function waitForHealth(baseUrl, child) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (child.exitCode !== null) break;
    try {
      const response = await rl(`${baseUrl}/health`);
      if (response.ok) return;
      lastError = new Error(`health returned ${response.status}`);
    } catch (err) {
      lastError = err;
    }
    await delay(250);
  }
  throw lastError || new Error("server did not start");
}

async function startServer(t) {
  const repoRoot = path.resolve(__dirname, "../..");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pixel-pictures-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const logStream = fs.createWriteStream(path.join(dir, "server.log"));

  fs.writeFileSync(path.join(dir, "config.yaml"), [
    `port: ${port}`,
    "database_path: ./main.db",
    "allowed_origins:",
    `  - ${ORIGIN}`,
    "client_base_url: http://localhost:4000",
    "cleanup_interval_minutes: 60",
    "sqlite_busy_timeout_ms: 5000",
    // Realistic production rate limits; the suite paces itself to stay under them.
    `rate_limit_max_per_second: ${RATE_LIMIT_PER_SECOND}`,
    "rate_limit_max_per_minute: 20",
    "rate_limit_max_per_day: 10000",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(dir, ".env"), [
    "ADMIN_PASSWORD=admin",
    "DEFAULT_TEACHER_KEY=teacher",
    "DOWNLOAD_TOKEN=change-me-before-deploying",
    "AUTH_FAILURE_LIMIT=5",
    "AUTH_FAILURE_WINDOW_MINUTES=10",
    "AUTH_ADMIN_BAN_DAYS=1",
    "AUTH_TEACHER_BAN_MINUTES=10",
    "AUTH_STUDENT_BAN_MINUTES=10",
    ""
  ].join("\n"));

  const child = spawn(process.execPath, [path.join(repoRoot, "src/server.js")], {
    cwd: dir,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    logStream.end();
    await delay(100);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl, child);
  return { baseUrl };
}

function evalSpecJs(source) {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox;
}

test("GET /pictures lists seeded pictures with dimensions and custom=0", async (t) => {
  const { baseUrl } = await startServer(t);
  const res = await rl(`${baseUrl}/pictures`, { headers: HEADERS });
  assert.equal(res.status, 200);
  const pictures = await res.json();
  const tetris = pictures.find((p) => p.id === "tetris");
  assert.ok(tetris, "tetris should be listed");
  assert.equal(tetris.script, "/pictures/tetris/spec.js");
  assert.equal(Number(tetris.custom), 0, "predefined pictures are custom=0");
  assert.ok(Number(tetris.numRows) > 0 && Number(tetris.numCols) > 0, "dimensions present");
});

test("GET /pictures/:id/spec.js serves a predefined picture's spec", async (t) => {
  const { baseUrl } = await startServer(t);
  const res = await rl(`${baseUrl}/pictures/tetris/spec.js`, { headers: HEADERS });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /javascript/);
  const globals = evalSpecJs(await res.text());
  assert.ok(Array.isArray(globals.palette) && globals.palette.length > 0);
  assert.ok(Array.isArray(globals.pages) && globals.pages.length > 0);
  assert.ok(Number(globals.numRows) > 0 && Number(globals.numCols) > 0);
});

test("GET /pictures/:id/spec-files.zip generates predefined artifacts on demand", async (t) => {
  const { baseUrl } = await startServer(t);
  const res = await rl(`${baseUrl}/pictures/eagles/spec-files.zip`, { headers: HEADERS });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /zip/);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.ok(bytes.length > 0, "zip should be non-empty");
  assert.equal(bytes.slice(0, 2).toString("latin1"), "PK", "zip magic header");
});

test("GET /pictures/:id/spec.js returns 404 for an unknown picture", async (t) => {
  const { baseUrl } = await startServer(t);
  const res = await rl(`${baseUrl}/pictures/does-not-exist/spec.js`, { headers: HEADERS });
  assert.equal(res.status, 404);
});

test("a teacher can create an instance from a predefined picture", async (t) => {
  const { baseUrl } = await startServer(t);
  const create = await rl(`${baseUrl}/instance/create`, {
    method: "POST",
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ pictureId: "eagles", teacherName: "Test Teacher", dateTime: "2026-06-26T10:00", instanceName: "verify-eagles" })
  });
  assert.equal(create.status, 201);
  const created = await create.json();
  assert.ok(created.instanceCode, "instance code returned");

  const status = await rl(`${baseUrl}/instance/${encodeURIComponent(created.instanceCode)}/status?key=${encodeURIComponent(created.accessKey || "")}`, { headers: HEADERS });
  assert.equal(status.status, 200);
  const data = await status.json();
  assert.equal(data.pictureId, "eagles");
  assert.equal(data.pictureScript, "/pictures/eagles/spec.js");
  assert.equal(data.pictureSpecUrl, "/pictures/eagles/spec.js");
});

test("predefined pictures are immutable: custom upload cannot overwrite a seeded id", async (t) => {
  const { baseUrl } = await startServer(t);
  const validSpec = {
    palette: [[0, 0, 0], [255, 255, 255]],
    numRows: 1,
    numCols: 1,
    pages: [{ col: "A", row: "1", uncompressed: [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0] }]
  };
  // A valid spec but a reserved (non custom-) id must be rejected by the id guard.
  const attempt = await rl(`${baseUrl}/pictures/custom`, {
    method: "POST",
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ id: "eagles", title: "Hijack", spec: validSpec })
  });
  assert.equal(attempt.status, 400, "must reject overwriting a predefined id");

  // eagles is unchanged: still served and still custom=0.
  const spec = await rl(`${baseUrl}/pictures/eagles/spec.js`, { headers: HEADERS });
  assert.equal(spec.status, 200);
  const list = await (await rl(`${baseUrl}/pictures`, { headers: HEADERS })).json();
  assert.equal(Number(list.find((p) => p.id === "eagles").custom), 0);
});

test("a teacher can create and serve a genuine custom picture", async (t) => {
  const { baseUrl } = await startServer(t);
  const validSpec = {
    palette: [[0, 0, 0], [255, 255, 255]],
    numRows: 1,
    numCols: 1,
    pages: [{ col: "A", row: "1", uncompressed: [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0] }]
  };
  const created = await (await rl(`${baseUrl}/pictures/custom`, {
    method: "POST",
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ title: "My Logo", spec: validSpec })
  })).json();
  assert.match(created.id, /^custom-/);
  const spec = await rl(`${baseUrl}${created.specUrl}`, { headers: HEADERS });
  assert.equal(spec.status, 200);
  const globals = evalSpecJs(await spec.text());
  assert.equal(Number(globals.numRows), 1);
  assert.equal(Number(globals.numCols), 1);
});
