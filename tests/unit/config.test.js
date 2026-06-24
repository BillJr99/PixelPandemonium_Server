const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadConfig } = require("../../src/config");

test("loadConfig reads auth throttling names from server .env", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pixel-config-"));
  const configPath = path.join(dir, "config.yaml");
  fs.writeFileSync(configPath, "port: 8000\n");
  fs.writeFileSync(path.join(dir, ".env"), [
    "ADMIN_PASSWORD=test-admin",
    "DEFAULT_TEACHER_KEY=test-teacher",
    "DOWNLOAD_TOKEN=test-token",
    "AUTH_FAILURE_LIMIT=7",
    "AUTH_FAILURE_WINDOW_MINUTES=12",
    "AUTH_ADMIN_BAN_DAYS=3",
    "AUTH_TEACHER_BAN_MINUTES=15",
    "AUTH_STUDENT_BAN_MINUTES=20",
    ""
  ].join("\n"));

  const previous = {
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
    DEFAULT_TEACHER_KEY: process.env.DEFAULT_TEACHER_KEY,
    DOWNLOAD_TOKEN: process.env.DOWNLOAD_TOKEN,
    AUTH_FAILURE_LIMIT: process.env.AUTH_FAILURE_LIMIT,
    AUTH_FAILURE_WINDOW_MINUTES: process.env.AUTH_FAILURE_WINDOW_MINUTES,
    AUTH_ADMIN_BAN_DAYS: process.env.AUTH_ADMIN_BAN_DAYS,
    AUTH_TEACHER_BAN_MINUTES: process.env.AUTH_TEACHER_BAN_MINUTES,
    AUTH_STUDENT_BAN_MINUTES: process.env.AUTH_STUDENT_BAN_MINUTES
  };
  for (const key of Object.keys(previous)) delete process.env[key];
  try {
    const config = loadConfig(configPath);
    assert.equal(config.admin_password, "test-admin");
    assert.equal(config.default_teacher_key, "test-teacher");
    assert.equal(config.download_token, "test-token");
    assert.equal(config.auth_failure_limit, 7);
    assert.equal(config.auth_failure_window_minutes, 12);
    assert.equal(config.auth_admin_ban_days, 3);
    assert.equal(config.auth_teacher_ban_minutes, 15);
    assert.equal(config.auth_student_ban_minutes, 20);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
