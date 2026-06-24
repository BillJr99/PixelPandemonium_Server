const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const rateLimit = require("express-rate-limit");
const cors = require("cors");
const faye = require("faye");
const sqlite3 = require("sqlite3").verbose();
const { loadConfig } = require("./config");
const {
  migrate,
  createInstance,
  getInstance,
  requireActiveInstance,
  resetInstance,
  cleanupExpired,
  validateCheckDigit,
  listPictures,
  getPicture,
  createCustomPicture,
  customPictureSpecJs,
  customPictureArtifacts,
  run,
  get,
  all
} = require("./instanceManager");
const { zipFiles } = require("./customPictures");

const config = loadConfig();
const app = express();
app.set("trust proxy", 1);
let requestCounter = 0;
let migrationComplete = false;
let migrationPromise = null;

function openDb() {
  const db = new sqlite3.Database(config.database_path);
  db.configure("busyTimeout", Number(config.sqlite_busy_timeout_ms || 5000));
  return db;
}

function envPath() {
  return path.join(process.cwd(), ".env");
}

function defaultEnvText() {
  return [
    `ADMIN_PASSWORD=${String(config.admin_password || "admin")}`,
    `DOWNLOAD_TOKEN=${String(config.download_token || "change-me-before-deploying")}`,
    `AUTH_FAILURE_LIMIT=${String(config.auth_failure_limit || 5)}`,
    `AUTH_FAILURE_WINDOW_MINUTES=${String(config.auth_failure_window_minutes || 10)}`,
    `AUTH_BAN_DAYS=${String(config.auth_ban_days || 1)}`,
    ""
  ].join("\n");
}

function parseEnvText(text) {
  const parsed = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 0) continue;
    parsed[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
  }
  return parsed;
}

async function ensureServerEnv() {
  const required = ["ADMIN_PASSWORD", "DOWNLOAD_TOKEN", "AUTH_FAILURE_LIMIT", "AUTH_FAILURE_WINDOW_MINUTES", "AUTH_BAN_DAYS"];
  const file = envPath();
  const existingText = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const parsed = parseEnvText(existingText);
  const missing = required.filter((key) => !parsed[key]);
  if (!missing.length) return;

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`Server .env is missing required key(s): ${missing.join(", ")}. Create ${file} before starting the server.`);
  }

  const readline = require("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question, fallback) => new Promise((resolve) => {
    rl.question(`${question} [${fallback}]: `, (answer) => resolve(answer.trim() || fallback));
  });

  const next = { ...parsed };
  for (const key of missing) {
    const fallback = key === "ADMIN_PASSWORD"
      ? String(config.admin_password || "admin")
      : key === "DOWNLOAD_TOKEN"
        ? String(config.download_token || "change-me-before-deploying")
        : key === "AUTH_FAILURE_LIMIT"
          ? String(config.auth_failure_limit || 5)
          : key === "AUTH_FAILURE_WINDOW_MINUTES"
            ? String(config.auth_failure_window_minutes || 10)
            : String(config.auth_ban_days || 1);
    next[key] = await ask(key, fallback);
  }
  rl.close();

  const preserved = existingText.split(/\r?\n/).filter((line) => {
    const key = line.split("=")[0].trim();
    return key && !required.includes(key);
  });
  const content = preserved.concat(required.map((key) => `${key}=${next[key]}`), "").join("\n");
  fs.writeFileSync(file, content, { mode: 0o600 });
  applyEnvText(content);
}

function applyEnvText(text) {
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (key === "ADMIN_PASSWORD") config.admin_password = value;
    if (key === "DOWNLOAD_TOKEN") config.download_token = value;
    if (key === "AUTH_FAILURE_LIMIT") config.auth_failure_limit = Number(value);
    if (key === "AUTH_FAILURE_WINDOW_MINUTES") config.auth_failure_window_minutes = Number(value);
    if (key === "AUTH_BAN_DAYS") config.auth_ban_days = Number(value);
  }
}

function log(level, message, details = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...details
  };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

async function ensureMigrated(db) {
  if (migrationComplete) return;
  if (!migrationPromise) {
    migrationPromise = (async () => {
      await migrate(db);
      await run(db, "PRAGMA journal_mode = WAL").catch((err) => {
        log("warn", "Could not enable SQLite WAL mode", { error: err.message });
      });
      migrationComplete = true;
    })();
  }
  await migrationPromise;
}

function originAllowed(origin) {
  if (!origin) return true;
  return (config.allowed_origins || []).some((allowed) => origin === allowed || origin.endsWith(allowed));
}

function buildUrls(instanceCode, adminCode, accessKey, teacherKey) {
  const base = String(config.client_base_url).replace(/\/$/, "");
  const key = encodeURIComponent(accessKey || "");
  const teacher = encodeURIComponent(teacherKey || "");
  return {
    studentUrl: `${base}/instructions.html?instance=${encodeURIComponent(instanceCode)}&key=${key}`,
    replayUrl: `${base}/replay.html?instance=${encodeURIComponent(instanceCode)}&key=${key}`,
    teacherUrl: `${base}/teacher-dashboard.html?instance=${encodeURIComponent(instanceCode)}&teacherKey=${teacher}&admin=${encodeURIComponent(adminCode)}`,
    adminUrl: `${base}/admin.html?instance=${encodeURIComponent(instanceCode)}&teacherKey=${teacher}&admin=${encodeURIComponent(adminCode)}`
  };
}

function buildStudentUrls(instanceCode, accessKey) {
  const base = String(config.client_base_url).replace(/\/$/, "");
  const key = encodeURIComponent(accessKey || "");
  return {
    studentUrl: `${base}/instructions.html?instance=${encodeURIComponent(instanceCode)}&key=${key}`,
    replayUrl: `${base}/replay.html?instance=${encodeURIComponent(instanceCode)}&key=${key}`
  };
}

function generateUrlKey() {
  return crypto.randomBytes(8).toString("hex").toUpperCase();
}

function isTetrisDemoCode(code) {
  return String(code || "").toLowerCase() === "tetris";
}

function isTetrisDemo(row) {
  return row && row.INSTANCE_CODE === "tetris" && row.PICTURE_ID === "tetris";
}

function publicInstance(row) {
  return {
    instanceCode: row.INSTANCE_CODE,
    instanceName: row.INSTANCE_NAME || row.INSTANCE_CODE,
    pictureId: row.PICTURE_ID,
    teacherName: row.TEACHER_NAME,
    requestedDateTime: row.REQUESTED_DATETIME,
    createdAt: row.CREATED_AT,
    expiresAt: row.EXPIRES_AT
  };
}

async function publicInstanceWithPicture(db, row) {
  const data = publicInstance(row);
  const picture = await getPicture(db, row.PICTURE_ID);
  if (picture) {
    data.pictureTitle = picture.title;
    data.pictureScript = picture.script;
    data.pictureCustom = !!picture.custom;
    if (picture.custom) {
      data.pictureSpecUrl = `/pictures/${encodeURIComponent(picture.id)}/spec.js`;
      data.pictureZipUrl = `/pictures/${encodeURIComponent(picture.id)}/spec-files.zip`;
    }
  }
  return data;
}

function adminPasswordFromRequest(req) {
  return req.get("x-admin-password") || (req.body && req.body.adminPassword) || req.query.adminPassword || "";
}

function clientIp(req) {
  return String(req.ip || req.get("x-forwarded-for") || req.socket.remoteAddress || "unknown").split(",")[0].trim();
}

function authConfig() {
  return {
    limit: Math.max(1, Number(config.auth_failure_limit || 5)),
    windowMs: Math.max(1, Number(config.auth_failure_window_minutes || 10)) * 60 * 1000,
    banMs: Math.max(1, Number(config.auth_ban_days || 1)) * 24 * 60 * 60 * 1000
  };
}

async function requireNotAuthBanned(db, req) {
  const ip = clientIp(req);
  const row = await get(db, "SELECT * FROM AUTH_FAILURES WHERE IP = ?", [ip]);
  if (!row || !row.BANNED_UNTIL) return;
  if (new Date(row.BANNED_UNTIL).getTime() <= Date.now()) {
    await run(db, "DELETE FROM AUTH_FAILURES WHERE IP = ?", [ip]);
    return;
  }
  const err = new Error("Too many failed authentication attempts. Try again later.");
  err.status = 429;
  throw err;
}

async function recordAuthFailure(db, req, reason) {
  const ip = clientIp(req);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const { limit, windowMs, banMs } = authConfig();
  const row = await get(db, "SELECT * FROM AUTH_FAILURES WHERE IP = ?", [ip]);
  let count = 1;
  let firstAt = nowIso;
  if (row && !row.BANNED_UNTIL && now - new Date(row.FIRST_FAILURE_AT).getTime() <= windowMs) {
    count = Number(row.FAILURE_COUNT || 0) + 1;
    firstAt = row.FIRST_FAILURE_AT;
  }
  const bannedUntil = count >= limit ? new Date(now + banMs).toISOString() : null;
  await run(
    db,
    `INSERT INTO AUTH_FAILURES (IP, FAILURE_COUNT, FIRST_FAILURE_AT, BANNED_UNTIL)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(IP) DO UPDATE SET
       FAILURE_COUNT = excluded.FAILURE_COUNT,
       FIRST_FAILURE_AT = excluded.FIRST_FAILURE_AT,
       BANNED_UNTIL = excluded.BANNED_UNTIL`,
    [ip, count, firstAt, bannedUntil]
  );
  log("warn", "Authentication failure recorded", { ip, reason, count, bannedUntil });
}

async function clearAuthFailures(db, req) {
  await run(db, "DELETE FROM AUTH_FAILURES WHERE IP = ?", [clientIp(req)]);
}

async function authError(db, req, message, reason) {
  await recordAuthFailure(db, req, reason);
  const err = new Error(message);
  err.status = 403;
  throw err;
}

async function requireAdminPassword(db, req) {
  if (isTetrisDemoCode(req.params && req.params.code)) return;
  await requireNotAuthBanned(db, req);
  const expected = String(config.admin_password || "");
  if (!expected) return;
  if (String(adminPasswordFromRequest(req)) === expected) return;
  await authError(db, req, "Invalid admin password", "admin-password");
}

function errorResponse(req, res, err) {
  const status = err.status || 500;
  const requestId = req && req.requestId;
  log(status >= 500 ? "error" : "warn", "Request failed", {
    requestId,
    method: req && req.method,
    path: req && req.originalUrl,
    status,
    error: err.message || "Server error",
    code: err.code,
    errno: err.errno,
    stack: status >= 500 ? err.stack : undefined
  });
  res.status(status).json({ valid: false, error: err.message || "Server error", requestId });
}

async function requireAdminInstance(db, code, adminCode, req) {
  if (!validateCheckDigit(code)) {
    const err = new Error("Invalid instance code");
    err.status = 400;
    throw err;
  }
  const row = await getInstance(db, code);
  if (!row) {
    const err = new Error("Instance not found");
    err.status = 404;
    throw err;
  }
  if (!row.ACTIVE) {
    const err = new Error("Instance not found");
    err.status = 404;
    throw err;
  }
  if (isTetrisDemo(row)) return row;
  if (row.ADMIN_CODE !== adminCode) {
    if (req) await authError(db, req, "Invalid admin code", "admin-code");
    else {
      const err = new Error("Invalid admin code");
      err.status = 403;
      throw err;
    }
  }
  return row;
}

function accessKeyFromRequest(req) {
  return req.get("x-instance-key") || (req.body && req.body.accessKey) || req.query.key || req.query.accessKey || "";
}

function teacherKeyFromRequest(req) {
  return req.get("x-teacher-key") || (req.body && req.body.teacherKey) || req.query.teacherKey || "";
}

async function requireInstanceAccess(db, req, row) {
  if (isTetrisDemo(row)) return;
  await requireNotAuthBanned(db, req);
  if (String(accessKeyFromRequest(req)) === String(row.ACCESS_KEY || "")) {
    await clearAuthFailures(db, req);
    return;
  }
  await authError(db, req, "Invalid instance access key", "instance-access-key");
}

async function requireTeacherAccess(db, req, row) {
  if (isTetrisDemo(row)) return;
  await requireNotAuthBanned(db, req);
  if (String(teacherKeyFromRequest(req)) === String(row.TEACHER_KEY || "")) return;
  await authError(db, req, "Invalid teacher key", "teacher-key");
}

const corsOptions = {
  origin(origin, callback) {
    if (originAllowed(origin)) callback(null, true);
    else callback(new Error(`Not allowed by CORS: ${origin}`));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "X-Instance-Key", "X-Teacher-Key", "X-Admin-Password"],
  credentials: true
};

app.use((req, res, next) => {
  req.requestId = `${Date.now().toString(36)}-${(++requestCounter).toString(36)}`;
  const startedAt = process.hrtime.bigint();
  log("info", "Request started", {
    requestId: req.requestId,
    method: req.method,
    path: req.originalUrl,
    origin: req.get("origin") || null,
    ip: req.ip
  });
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    log(res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info", "Request finished", {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Number(durationMs.toFixed(1))
    });
  });
  next();
});
app.use(cors(corsOptions));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: Number(config.rate_limit_max_per_minute || 180),
  message: "Too many requests from this IP in a short time window. Please try again later."
}));

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    runtime: "node-express-faye",
    routes: [
      "/instance/create",
      "/instance/:code/status",
      "/instance/:code/insert",
      "/instance/:code/retrieve",
      "/instance/:code/reset",
      "/faye"
    ]
  });
});

app.get("/pictures", async (req, res) => {
  const db = openDb();
  try {
    await ensureMigrated(db);
    res.json(await listPictures(db));
  } catch (err) {
    errorResponse(req, res, err);
  } finally {
    db.close();
  }
});

app.post("/pictures/custom", async (req, res) => {
  const db = openDb();
  try {
    await ensureMigrated(db);
    await requireAdminPassword(db, req);
    const result = await createCustomPicture(db, req.body || {});
    res.status(201).json({
      id: result.id,
      title: result.title,
      script: result.script,
      custom: true,
      specUrl: `/pictures/${encodeURIComponent(result.id)}/spec.js`,
      zipUrl: `/pictures/${encodeURIComponent(result.id)}/spec-files.zip`
    });
  } catch (err) {
    errorResponse(req, res, err);
  } finally {
    db.close();
  }
});

app.get("/pictures/:id/spec.js", async (req, res) => {
  const db = openDb();
  try {
    await ensureMigrated(db);
    res.type("application/javascript; charset=utf-8").send(await customPictureSpecJs(db, req.params.id));
  } catch (err) {
    errorResponse(req, res, err);
  } finally {
    db.close();
  }
});

app.get("/pictures/:id/spec-files.zip", async (req, res) => {
  const db = openDb();
  try {
    await ensureMigrated(db);
    const { title, artifacts } = await customPictureArtifacts(db, req.params.id);
    const filename = `${String(title).replace(/[^a-z0-9_-]+/gi, "_") || "custom"}_spec_files.zip`;
    res.setHeader("content-type", "application/zip");
    res.setHeader("content-disposition", `attachment; filename="${filename}"`);
    res.send(zipFiles(artifacts));
  } catch (err) {
    errorResponse(req, res, err);
  } finally {
    db.close();
  }
});

app.post("/instance/create", async (req, res) => {
  const db = openDb();
  try {
    await ensureMigrated(db);
    const result = await createInstance(db, req.body, config);
    res.status(201).json({ ...result, ...buildUrls(result.instanceCode, result.adminCode, result.accessKey, result.teacherKey) });
  } catch (err) {
    errorResponse(req, res, err);
  } finally {
    db.close();
  }
});

app.get("/instance/:code/status", async (req, res) => {
  const db = openDb();
  try {
    await ensureMigrated(db);
    if (!validateCheckDigit(req.params.code)) {
      return res.status(400).json({ valid: false, error: "Invalid check digit" });
    }
    const row = await getInstance(db, req.params.code);
    if (!row) return res.status(404).json({ valid: false, error: "Instance not found" });
    if (!row.ACTIVE) return res.status(404).json({ valid: false, error: "Instance not found" });
    await requireInstanceAccess(db, req, row);
    const expired = new Date(row.EXPIRES_AT).getTime() <= Date.now();
    if (expired) return res.status(410).json({ valid: false, error: "Instance expired", ...(await publicInstanceWithPicture(db, row)) });
    res.json({ valid: true, ...(await publicInstanceWithPicture(db, row)), ...buildStudentUrls(row.INSTANCE_CODE, row.ACCESS_KEY) });
  } catch (err) {
    errorResponse(req, res, err);
  } finally {
    db.close();
  }
});

app.post("/instance/:code/insert", async (req, res) => {
  const db = openDb();
  try {
    await ensureMigrated(db);
    const row = await requireActiveInstance(db, req.params.code);
    await requireInstanceAccess(db, req, row);
    const data = req.body.data === undefined ? null : String(req.body.data);
    await run(db, "INSERT INTO DATA (INSTANCE_CODE, NAME, DATA) VALUES (?, ?, ?)", [
      req.params.code,
      req.params.code,
      data
    ]);
    res.status(201).json({ status: "created" });
  } catch (err) {
    errorResponse(req, res, err);
  } finally {
    db.close();
  }
});

app.get("/instance/:code/retrieve", async (req, res) => {
  const db = openDb();
  try {
    await ensureMigrated(db);
    const row = await requireActiveInstance(db, req.params.code);
    await requireInstanceAccess(db, req, row);
    const rows = await all(db, "SELECT * FROM DATA WHERE INSTANCE_CODE = ? ORDER BY TIMESTAMP ASC, ID ASC", [req.params.code]);
    res.json(rows);
  } catch (err) {
    errorResponse(req, res, err);
  } finally {
    db.close();
  }
});

app.post("/instance/:code/reset", async (req, res) => {
  const db = openDb();
  try {
    await ensureMigrated(db);
    const adminCode = req.body.adminCode || req.query.admin;
    await requireAdminPassword(db, req);
    const row = await requireAdminInstance(db, req.params.code, adminCode, req);
    await requireTeacherAccess(db, req, row);
    const result = await resetInstance(db, req.params.code, adminCode);
    await clearAuthFailures(db, req);
    res.json({ status: "reset", ...result });
  } catch (err) {
    errorResponse(req, res, err);
  } finally {
    db.close();
  }
});

app.get("/instance/:code/admin", async (req, res) => {
  const db = openDb();
  try {
    await ensureMigrated(db);
    await requireAdminPassword(db, req);
    const row = await requireAdminInstance(db, req.params.code, req.query.admin, req);
    await requireTeacherAccess(db, req, row);
    await clearAuthFailures(db, req);
    const rows = await all(db, "SELECT * FROM DATA WHERE INSTANCE_CODE = ? ORDER BY TIMESTAMP ASC, ID ASC", [req.params.code]);
    res.json({ ...(await publicInstanceWithPicture(db, row)), accessKey: row.ACCESS_KEY, ...buildUrls(row.INSTANCE_CODE, row.ADMIN_CODE, row.ACCESS_KEY, row.TEACHER_KEY), rows });
  } catch (err) {
    errorResponse(req, res, err);
  } finally {
    db.close();
  }
});

async function deactivateInstance(req, res) {
  const db = openDb();
  try {
    await ensureMigrated(db);
    if (isTetrisDemoCode(req.params.code)) {
      return res.status(403).json({ error: "The public Tetris demo cannot be deactivated" });
    }
    await requireAdminPassword(db, req);
    const row = await requireAdminInstance(db, req.params.code, req.body.adminCode || req.query.admin, req);
    await requireTeacherAccess(db, req, row);
    await clearAuthFailures(db, req);
    const result = await run(db, "UPDATE INSTANCES SET ACTIVE = 0 WHERE INSTANCE_CODE = ?", [req.params.code]);
    res.json({ status: "deactivated", deactivatedInstances: result.changes || 0 });
  } catch (err) {
    errorResponse(req, res, err);
  } finally {
    db.close();
  }
}

app.post("/instance/:code/deactivate", deactivateInstance);
app.post("/instance/:code/delete", deactivateInstance);

app.post("/instance/:code/rotate-key", async (req, res) => {
  const db = openDb();
  try {
    await ensureMigrated(db);
    if (isTetrisDemoCode(req.params.code)) {
      return res.status(403).json({ error: "The public Tetris demo does not use keys" });
    }
    await requireAdminPassword(db, req);
    const row = await requireAdminInstance(db, req.params.code, req.body.adminCode || req.query.admin, req);
    await requireTeacherAccess(db, req, row);
    const keyType = String(req.body.keyType || req.query.keyType || "").trim();
    if (!["student", "teacher"].includes(keyType)) {
      return res.status(400).json({ error: "keyType must be student or teacher" });
    }
    const newKey = generateUrlKey();
    const column = keyType === "student" ? "ACCESS_KEY" : "TEACHER_KEY";
    await run(db, `UPDATE INSTANCES SET ${column} = ? WHERE INSTANCE_CODE = ?`, [newKey, req.params.code]);
    const updated = await getInstance(db, req.params.code);
    await clearAuthFailures(db, req);
    res.json({
      status: "rotated",
      keyType,
      accessKey: updated.ACCESS_KEY,
      teacherKey: updated.TEACHER_KEY,
      ...buildUrls(updated.INSTANCE_CODE, updated.ADMIN_CODE, updated.ACCESS_KEY, updated.TEACHER_KEY)
    });
  } catch (err) {
    errorResponse(req, res, err);
  } finally {
    db.close();
  }
});

app.post("/instance/:code/event/:id/update", async (req, res) => {
  const db = openDb();
  try {
    await ensureMigrated(db);
    await requireAdminPassword(db, req);
    const row = await requireAdminInstance(db, req.params.code, req.body.adminCode || req.query.admin, req);
    await requireTeacherAccess(db, req, row);
    await clearAuthFailures(db, req);
    const data = req.body.data === undefined ? "" : String(req.body.data);
    const result = await run(db, "UPDATE DATA SET DATA = ? WHERE ID = ? AND INSTANCE_CODE = ?", [
      data,
      req.params.id,
      req.params.code
    ]);
    if (!result.changes) return res.status(404).json({ error: "Event not found" });
    res.json({ status: "updated", updatedRows: result.changes });
  } catch (err) {
    errorResponse(req, res, err);
  } finally {
    db.close();
  }
});

app.post("/instance/:code/event/:id/delete", async (req, res) => {
  const db = openDb();
  try {
    await ensureMigrated(db);
    await requireAdminPassword(db, req);
    const row = await requireAdminInstance(db, req.params.code, req.body.adminCode || req.query.admin, req);
    await requireTeacherAccess(db, req, row);
    await clearAuthFailures(db, req);
    const result = await run(db, "DELETE FROM DATA WHERE ID = ? AND INSTANCE_CODE = ?", [req.params.id, req.params.code]);
    if (!result.changes) return res.status(404).json({ error: "Event not found" });
    res.json({ status: "deleted", deletedRows: result.changes });
  } catch (err) {
    errorResponse(req, res, err);
  } finally {
    db.close();
  }
});

if (config.legacy_routes_enabled) {
  app.post("/insert", async (req, res) => {
    const db = openDb();
    try {
      await ensureMigrated(db);
      const name = req.query.name || null;
      const data = req.body.data === undefined ? null : String(req.body.data);
      await run(db, "INSERT INTO DATA (NAME, DATA) VALUES (?, ?)", [name, data]);
      res.status(201).json({ status: "created" });
    } catch (err) {
      errorResponse(req, res, err);
    } finally {
      db.close();
    }
  });

  app.get("/retrieve", async (req, res) => {
    const db = openDb();
    try {
      await ensureMigrated(db);
      const name = req.query.name;
      const rows = name
        ? await all(db, "SELECT * FROM DATA WHERE NAME = ? ORDER BY TIMESTAMP ASC, ID ASC", [name])
        : await all(db, "SELECT * FROM DATA ORDER BY TIMESTAMP ASC, ID ASC");
      res.json(rows);
    } catch (err) {
      errorResponse(req, res, err);
    } finally {
      db.close();
    }
  });
}

app.get("/download", async (req, res) => {
  const token = (req.get("authorization") || "").replace(/^Bearer\s+/i, "") || req.query.token;
  if (!config.download_token || token !== config.download_token) {
    return res.status(403).json({ error: "Forbidden" });
  }
  const db = openDb();
  try {
    await ensureMigrated(db);
    const rows = await all(db, "SELECT * FROM DATA ORDER BY TIMESTAMP ASC, ID ASC");
    res.setHeader("content-disposition", "attachment; filename=\"data-export.json\"");
    res.json(rows);
  } catch (err) {
    errorResponse(req, res, err);
  } finally {
    db.close();
  }
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  errorResponse(req, res, err);
});

const server = http.createServer(app);
const bayeux = new faye.NodeAdapter({ mount: "/faye" });
bayeux.addExtension({
  incoming(message, callback) {
    if (message.channel === "/meta/handshake") {
      const origin = message.ext && message.ext.origin;
      if (origin && !originAllowed(origin)) {
        message.error = "Forbidden: Invalid origin";
      }
    }
    callback(message);
  }
});
bayeux.attach(server);

async function start() {
  await ensureServerEnv();
  const db = openDb();
  await ensureMigrated(db);
  db.close();

  const cleanupMs = Number(config.cleanup_interval_minutes || 60) * 60 * 1000;
  setInterval(async () => {
    const cleanupDb = openDb();
    try {
      await cleanupExpired(cleanupDb);
    } catch (err) {
      log("error", "Cleanup failed", { error: err.message, stack: err.stack });
    } finally {
      cleanupDb.close();
    }
  }, cleanupMs).unref();

  const port = process.env.PORT || config.port;
  server.listen(port, () => {
    log("info", "Pixel Pandemonium server listening", {
      port: Number(port),
      databasePath: config.database_path,
      sqliteBusyTimeoutMs: Number(config.sqlite_busy_timeout_ms || 5000),
      rateLimitMaxPerMinute: Number(config.rate_limit_max_per_minute || 180)
    });
  });
}

if (require.main === module) {
  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { app, server, start };
