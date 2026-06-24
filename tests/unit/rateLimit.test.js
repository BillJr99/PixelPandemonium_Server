const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(baseUrl, child) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
      lastError = new Error(`health returned ${response.status}`);
    } catch (err) {
      lastError = err;
    }
    await delay(250);
  }
  throw lastError || new Error("server did not start");
}

async function startServer(t, envLines) {
  const repoRoot = path.resolve(__dirname, "../..");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pixel-rate-limit-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const serverPath = path.join(repoRoot, "src/server.js");
  const logPath = path.join(dir, "server.log");
  const logStream = fs.createWriteStream(logPath);

  fs.writeFileSync(path.join(dir, "config.yaml"), [
    `port: ${port}`,
    "database_path: ./main.db",
    "allowed_origins:",
    "  - http://localhost:4000",
    "client_base_url: http://localhost:4000",
    "cleanup_interval_minutes: 60",
    "sqlite_busy_timeout_ms: 5000",
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
    ...envLines,
    ""
  ].join("\n"));

  const child = spawn(process.execPath, [serverPath], {
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

async function expectPicturesRequest(baseUrl, status) {
  const response = await fetch(`${baseUrl}/pictures`, { headers: { Origin: "http://localhost:4000" } });
  assert.equal(response.status, status);
  return response;
}

test("server returns 429 when per-IP minute request rate limit is exceeded", async (t) => {
  const { baseUrl } = await startServer(t, [
    "RATE_LIMIT_MAX_PER_SECOND=100",
    "RATE_LIMIT_MAX_PER_MINUTE=3",
    "RATE_LIMIT_MAX_PER_DAY=100"
  ]);

  await expectPicturesRequest(baseUrl, 200);
  await expectPicturesRequest(baseUrl, 200);
  const limited = await expectPicturesRequest(baseUrl, 429);
  assert.match(await limited.text(), /Too many requests/i);
});

test("server returns 429 when per-IP daily request rate limit is exceeded", async (t) => {
  const { baseUrl } = await startServer(t, [
    "RATE_LIMIT_MAX_PER_SECOND=100",
    "RATE_LIMIT_MAX_PER_MINUTE=100",
    "RATE_LIMIT_MAX_PER_DAY=3"
  ]);

  await expectPicturesRequest(baseUrl, 200);
  await expectPicturesRequest(baseUrl, 200);
  const limited = await expectPicturesRequest(baseUrl, 429);
  assert.match(await limited.text(), /Too many requests/i);
});
