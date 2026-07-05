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
const { APP_VERSION } = require("./version");
const { isTetrisDemoCode, tetrisInsertError } = require("./tetrisDemo");
const {
  migrate,
  createInstance,
  getInstance,
  requireActiveInstance,
  resetInstance,
  deleteExpiredInstance,
  cleanupExpired,
  validateCheckDigit,
  listPictures,
  getPicture,
  createCustomPicture,
  pictureSpecJs,
  pictureArtifacts,
  ensureTeacherKey,
  listTeacherKeys,
  createTeacherKey,
  teacherKeyExists,
  run,
  get,
  all
} = require("./instanceManager");
const { zipFiles } = require("./customPictures");
const { resolveExpiresAt } = require("./expiration");

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
    `DEFAULT_TEACHER_KEY=${String(config.default_teacher_key || "teacher")}`,
    `AUTH_FAILURE_LIMIT=${String(config.auth_failure_limit || 5)}`,
    `AUTH_FAILURE_WINDOW_MINUTES=${String(config.auth_failure_window_minutes || 10)}`,
    "AUTH_ADMIN_BAN_DAYS=1",
    "AUTH_TEACHER_BAN_MINUTES=10",
    "AUTH_STUDENT_BAN_MINUTES=10",
    "RATE_LIMIT_MAX_PER_SECOND=10",
    "RATE_LIMIT_MAX_PER_MINUTE=60",
    "RATE_LIMIT_MAX_PER_DAY=10000",
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
  const required = ["ADMIN_PASSWORD", "DEFAULT_TEACHER_KEY", "AUTH_FAILURE_LIMIT", "AUTH_FAILURE_WINDOW_MINUTES"];
  const defaulted = {
    AUTH_ADMIN_BAN_DAYS: "1",
    AUTH_TEACHER_BAN_MINUTES: "10",
    AUTH_STUDENT_BAN_MINUTES: "10",
    RATE_LIMIT_MAX_PER_SECOND: "10",
    RATE_LIMIT_MAX_PER_MINUTE: "60",
    RATE_LIMIT_MAX_PER_DAY: "10000"
  };
  const file = envPath();
  const existingText = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const parsed = parseEnvText(existingText);
  const missing = required.filter((key) => !parsed[key]);

  if (missing.length && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error(`Server .env is missing required key(s): ${missing.join(", ")}. Create ${file} before starting the server.`);
  }

  const next = { ...parsed };
  let rl = null;
  if (missing.length) {
    const readline = require("readline");
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (question, fallback) => new Promise((resolve) => {
      rl.question(`${question} [${fallback}]: `, (answer) => resolve(answer.trim() || fallback));
    });

    for (const key of missing) {
      const fallback = key === "ADMIN_PASSWORD"
        ? String(config.admin_password || "admin")
        : key === "DEFAULT_TEACHER_KEY"
          ? String(config.default_teacher_key || "teacher")
          : key === "AUTH_FAILURE_LIMIT"
            ? String(config.auth_failure_limit || 5)
            : String(config.auth_failure_window_minutes || 10);
      next[key] = await ask(key, fallback);
    }
    rl.close();
  }
  for (const [key, value] of Object.entries(defaulted)) {
    if (!next[key]) next[key] = value;
  }

  const writableKeys = required.concat(Object.keys(defaulted));
  const changed = missing.length || Object.keys(defaulted).some((key) => !parsed[key]);
  if (!changed) return;

  const preserved = existingText.split(/\r?\n/).filter((line) => {
    const key = line.split("=")[0].trim();
    return key && !writableKeys.includes(key);
  });
  const content = preserved.concat(writableKeys.map((key) => `${key}=${next[key]}`), "").join("\n");
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
    if (key === "DEFAULT_TEACHER_KEY") config.default_teacher_key = value;
    if (key === "AUTH_FAILURE_LIMIT") config.auth_failure_limit = Number(value);
    if (key === "AUTH_FAILURE_WINDOW_MINUTES") config.auth_failure_window_minutes = Number(value);
    if (key === "AUTH_ADMIN_BAN_DAYS") config.auth_admin_ban_days = Number(value);
    if (key === "AUTH_TEACHER_BAN_MINUTES") config.auth_teacher_ban_minutes = Number(value);
    if (key === "AUTH_STUDENT_BAN_MINUTES") config.auth_student_ban_minutes = Number(value);
    if (key === "RATE_LIMIT_MAX_PER_SECOND") config.rate_limit_max_per_second = Number(value);
    if (key === "RATE_LIMIT_MAX_PER_MINUTE") config.rate_limit_max_per_minute = Number(value);
    if (key === "RATE_LIMIT_MAX_PER_DAY") config.rate_limit_max_per_day = Number(value);
    if (key === "WRITE_RATE_BURST_PER_SECOND") config.rate_limit_max_per_second = Number(value);
    if (key === "WRITE_RATE_MAX_PER_MINUTE") config.rate_limit_max_per_minute = Number(value);
    if (key === "WRITE_RATE_MAX_PER_DAY") config.rate_limit_max_per_day = Number(value);
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
      await ensureTeacherKey(db, config.default_teacher_key || "teacher", "Default Teacher");
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
  const candidate = String(origin).toLowerCase();
  return (config.allowed_origins || []).some((entry) => {
    const allowed = String(entry).toLowerCase();
    return candidate === allowed || candidate.endsWith(allowed);
  });
}

function buildUrls(instanceCode, adminCode, accessKey, teacherKey) {
  const base = String(config.client_base_url).replace(/\/$/, "");
  if (isTetrisDemoCode(instanceCode)) {
    return {
      studentUrl: `${base}/instructions.html?instance=tetris`,
      replayUrl: `${base}/replay.html?instance=tetris`,
      teacherUrl: `${base}/teacher-dashboard.html?instance=tetris`,
      adminUrl: `${base}/admin.html?instance=tetris`
    };
  }
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
  if (isTetrisDemoCode(instanceCode)) {
    return {
      studentUrl: `${base}/instructions.html?instance=tetris`,
      replayUrl: `${base}/replay.html?instance=tetris`
    };
  }
  const key = encodeURIComponent(accessKey || "");
  return {
    studentUrl: `${base}/instructions.html?instance=${encodeURIComponent(instanceCode)}&key=${key}`,
    replayUrl: `${base}/replay.html?instance=${encodeURIComponent(instanceCode)}&key=${key}`
  };
}

function generateUrlKey() {
  return crypto.randomBytes(8).toString("hex").toUpperCase();
}

function isTetrisDemo(row) {
  // "tetris" is a reserved instance code that can never be assigned to a real
  // class (it is rejected at creation and cannot be generated), so the code
  // alone identifies the public demo. Do not also require PICTURE_ID === "tetris":
  // a stale/drifted demo row would otherwise start demanding an access key.
  return !!row && isTetrisDemoCode(row.INSTANCE_CODE);
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
    // Both predefined and custom pictures are served from the server spec.js
    // endpoint, so expose pictureSpecUrl uniformly. The downloadable zip link is
    // only surfaced for custom uploads (no client UI offers it for predefined).
    data.pictureSpecUrl = `/pictures/${encodeURIComponent(picture.id)}/spec.js`;
    if (picture.custom) {
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
    windowMs: Math.max(1, Number(config.auth_failure_window_minutes || 10)) * 60 * 1000
  };
}

function authFailureCategory(reason) {
  if (String(reason || "").startsWith("student") || reason === "instance-access-key") return "student";
  if (String(reason || "").startsWith("teacher")) return "teacher";
  if (String(reason || "").startsWith("admin")) return "admin";
  return "admin";
}

function authBanMs(category) {
  if (category === "teacher") return Math.max(1, Number(config.auth_teacher_ban_minutes || 10)) * 60 * 1000;
  if (category === "student") return Math.max(1, Number(config.auth_student_ban_minutes || 10)) * 60 * 1000;
  return Math.max(1, Number(config.auth_admin_ban_days || 1)) * 24 * 60 * 60 * 1000;
}

function authFailureKey(ip, category) {
  return `${category}:${ip}`;
}

async function requireNotAuthBanned(db, req, category = "admin") {
  const ip = clientIp(req);
  const key = authFailureKey(ip, category);
  const row = await get(db, "SELECT * FROM AUTH_FAILURES WHERE IP = ?", [key]);
  if (!row || !row.BANNED_UNTIL) return;
  if (new Date(row.BANNED_UNTIL).getTime() <= Date.now()) {
    await run(db, "DELETE FROM AUTH_FAILURES WHERE IP = ?", [key]);
    return;
  }
  const err = new Error(`Too many failed ${category} authentication attempts. Try again later.`);
  err.status = 429;
  throw err;
}

async function recordAuthFailure(db, req, reason) {
  const ip = clientIp(req);
  const category = authFailureCategory(reason);
  const key = authFailureKey(ip, category);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const { limit, windowMs } = authConfig();
  const row = await get(db, "SELECT * FROM AUTH_FAILURES WHERE IP = ?", [key]);
  let count = 1;
  let firstAt = nowIso;
  if (row && !row.BANNED_UNTIL && now - new Date(row.FIRST_FAILURE_AT).getTime() <= windowMs) {
    count = Number(row.FAILURE_COUNT || 0) + 1;
    firstAt = row.FIRST_FAILURE_AT;
  }
  const bannedUntil = count >= limit ? new Date(now + authBanMs(category)).toISOString() : null;
  await run(
    db,
    `INSERT INTO AUTH_FAILURES (IP, FAILURE_COUNT, FIRST_FAILURE_AT, BANNED_UNTIL)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(IP) DO UPDATE SET
       FAILURE_COUNT = excluded.FAILURE_COUNT,
       FIRST_FAILURE_AT = excluded.FIRST_FAILURE_AT,
       BANNED_UNTIL = excluded.BANNED_UNTIL`,
    [key, count, firstAt, bannedUntil]
  );
  log("warn", "Authentication failure recorded", { ip, category, reason, count, bannedUntil });
}

async function clearAuthFailures(db, req, category) {
  const ip = clientIp(req);
  if (category) {
    await run(db, "DELETE FROM AUTH_FAILURES WHERE IP = ?", [authFailureKey(ip, category)]);
    return;
  }
  await run(db, "DELETE FROM AUTH_FAILURES WHERE IP IN (?, ?, ?, ?)", [
    ip,
    authFailureKey(ip, "admin"),
    authFailureKey(ip, "teacher"),
    authFailureKey(ip, "student")
  ]);
}

async function authError(db, req, message, reason) {
  await recordAuthFailure(db, req, reason);
  const err = new Error(message);
  err.status = 403;
  throw err;
}

async function requireAdminPassword(db, req) {
  if (isTetrisDemoCode(req.params && req.params.code)) return;
  await requireNotAuthBanned(db, req, "admin");
  const expected = String(config.admin_password || "");
  if (!expected) return;
  if (String(adminPasswordFromRequest(req)) === expected) {
    await clearAuthFailures(db, req, "admin");
    return;
  }
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
  if (req) await requireNotAuthBanned(db, req, "admin");
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

function teacherAccessKeyFromRequest(req) {
  return req.get("x-teacher-access-key") || (req.body && req.body.teacherAccessKey) || req.query.teacherAccessKey || "";
}

async function requireInstanceAccess(db, req, row) {
  if (isTetrisDemo(row)) return;
  await requireNotAuthBanned(db, req, "student");
  if (String(accessKeyFromRequest(req)) === String(row.ACCESS_KEY || "")) {
    await clearAuthFailures(db, req, "student");
    return;
  }
  await authError(db, req, "Invalid instance access key", "instance-access-key");
}

async function requireTeacherAccess(db, req, row) {
  if (isTetrisDemo(row)) return;
  await requireNotAuthBanned(db, req, "teacher");
  if (String(teacherKeyFromRequest(req)) === String(row.TEACHER_KEY || "")) {
    await clearAuthFailures(db, req, "teacher");
    return;
  }
  await authError(db, req, "Invalid teacher key", "teacher-key");
}

async function requireTeacherPortalAccess(db, req) {
  await requireNotAuthBanned(db, req, "teacher");
  const teacherAccessKey = teacherAccessKeyFromRequest(req);
  if (await teacherKeyExists(db, teacherAccessKey)) {
    await clearAuthFailures(db, req, "teacher");
    return teacherAccessKey;
  }
  await authError(db, req, "Invalid teacher access key", "teacher-access-key");
}

async function requireTeacherOwnsInstance(db, req, row) {
  if (isTetrisDemo(row) || adminPasswordFromRequest(req)) return;
  await requireNotAuthBanned(db, req, "teacher");
  const teacherAccessKey = teacherAccessKeyFromRequest(req);
  if (teacherAccessKey && String(row.TEACHER_ACCESS_KEY || "") === String(teacherAccessKey)) return;
  await authError(db, req, "Teacher key does not own this instance", "teacher-instance-owner");
}

const corsOptions = {
  origin(origin, callback) {
    if (originAllowed(origin)) callback(null, true);
    else callback(new Error(`Not allowed by CORS: ${origin}`));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "X-Instance-Key", "X-Teacher-Key", "X-Teacher-Access-Key", "X-Admin-Password"],
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

function ipRateLimit(windowMs, max, label) {
  return rateLimit({
    windowMs,
    max: Math.max(1, Number(max || 1)),
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.method === "OPTIONS",
    message: { error: "Too many requests from this IP. Please slow down and try again later.", limit: label }
  });
}

app.use(ipRateLimit(1000, config.rate_limit_max_per_second || 3, "per-second"));
app.use(ipRateLimit(60 * 1000, config.rate_limit_max_per_minute || 20, "per-minute"));
app.use(ipRateLimit(24 * 60 * 60 * 1000, config.rate_limit_max_per_day || 10000, "per-day"));

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    version: APP_VERSION,
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

async function requireAdminOrTeacherPortalAccess(db, req) {
  if (isTetrisDemoCode(req.params && req.params.code)) return { mode: "demo", teacherAccessKey: "" };
  if (adminPasswordFromRequest(req)) {
    await requireAdminPassword(db, req);
    return { mode: "admin", teacherAccessKey: "" };
  }
  return { mode: "teacher", teacherAccessKey: await requireTeacherPortalAccess(db, req) };
}

app.get("/teacher/validate", async (req, res) => {
  const db = openDb();
  try {
    await ensureMigrated(db);
    await requireTeacherPortalAccess(db, req);
    res.json({ valid: true });
  } catch (err) {
    errorResponse(req, res, err);
  } finally {
    db.close();
  }
});

app.get("/teacher-keys", async (req, res) => {
  const db = openDb();
  try {
    await ensureMigrated(db);
    await requireAdminPassword(db, req);
    res.json({ teacherKeys: await listTeacherKeys(db) });
  } catch (err) {
    errorResponse(req, res, err);
  } finally {
    db.close();
  }
});

app.post("/teacher-keys", async (req, res) => {
  const db = openDb();
  try {
    await ensureMigrated(db);
    await requireAdminPassword(db, req);
    const created = await createTeacherKey(db, req.body.teacherKey, req.body.label);
    await clearAuthFailures(db, req);
    res.status(201).json(created);
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
    await requireAdminOrTeacherPortalAccess(db, req);
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
    res.type("application/javascript; charset=utf-8").send(await pictureSpecJs(db, req.params.id));
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
    const { title, artifacts } = await pictureArtifacts(db, req.params.id);
    const filename = `${String(title).replace(/[^a-z0-9_-]+/gi, "_") || "custom"}_spec_files.zip`;
    res.setHeader("content-type", "application/zip");
    res.setHeader("content-disposition", `attachment; filename="${filename}"`);
    res.send(Buffer.from(zipFiles(artifacts)));
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
    const access = await requireAdminOrTeacherPortalAccess(db, req);
    if (access.mode === "teacher") req.body.teacherAccessKey = access.teacherAccessKey;
    const result = await createInstance(db, req.body, config);
    res.status(201).json({ ...result, ...buildUrls(result.instanceCode, result.adminCode, result.accessKey, result.teacherKey) });
  } catch (err) {
    errorResponse(req, res, err);
  } finally {
    db.close();
  }
});

app.get("/instances", async (req, res) => {
  const db = openDb();
  try {
    await ensureMigrated(db);
    const access = await requireAdminOrTeacherPortalAccess(db, req);
    // Admins also see soft-deleted (expired/cleaned-up) instances so they can
    // restore them with a new expiration date.
    const rows = access.mode === "admin"
      ? await all(db, "SELECT * FROM INSTANCES ORDER BY CREATED_AT DESC, ID DESC")
      : await all(db, "SELECT * FROM INSTANCES WHERE ACTIVE = 1 ORDER BY CREATED_AT DESC, ID DESC");
    const instances = [];
    for (const row of rows) {
      instances.push({
        ...(await publicInstanceWithPicture(db, row)),
        active: !!row.ACTIVE,
        adminCode: row.ADMIN_CODE,
        accessKey: row.ACCESS_KEY,
        teacherKey: row.TEACHER_KEY,
        ...buildUrls(row.INSTANCE_CODE, row.ADMIN_CODE, row.ACCESS_KEY, row.TEACHER_KEY)
      });
    }
    await clearAuthFailures(db, req);
    res.json({ instances });
  } catch (err) {
    errorResponse(req, res, err);
  } finally {
    db.close();
  }
});

app.get("/teacher/instances", async (req, res) => {
  const db = openDb();
  try {
    await ensureMigrated(db);
    const teacherAccessKey = await requireTeacherPortalAccess(db, req);
    const rows = await all(db, "SELECT * FROM INSTANCES WHERE ACTIVE = 1 AND TEACHER_ACCESS_KEY = ? ORDER BY CREATED_AT DESC, ID DESC", [teacherAccessKey]);
    const instances = [];
    for (const row of rows) {
      instances.push({
        ...(await publicInstanceWithPicture(db, row)),
        active: true,
        adminCode: row.ADMIN_CODE,
        accessKey: row.ACCESS_KEY,
        teacherKey: row.TEACHER_KEY,
        ...buildUrls(row.INSTANCE_CODE, row.ADMIN_CODE, row.ACCESS_KEY, row.TEACHER_KEY)
      });
    }
    await clearAuthFailures(db, req);
    res.json({ instances });
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
    if (isTetrisDemo(row)) {
      const picture = await getPicture(db, row.PICTURE_ID);
      const spec = picture && picture.specJson ? JSON.parse(picture.specJson) : null;
      const demoError = tetrisInsertError(spec, data);
      if (demoError) return res.status(400).json({ error: demoError });
    }
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
    await requireAdminOrTeacherPortalAccess(db, req);
    const row = await requireAdminInstance(db, req.params.code, adminCode, req);
    await requireTeacherOwnsInstance(db, req, row);
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
    await requireAdminOrTeacherPortalAccess(db, req);
    const row = await requireAdminInstance(db, req.params.code, req.query.admin, req);
    await requireTeacherOwnsInstance(db, req, row);
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
  res.status(403).json({ error: "Instances cannot be deactivated or deleted" });
}

app.post("/instance/:code/deactivate", deactivateInstance);

// Expired instances only: authorized by the admin password or the owning
// teacher key. Active (non-expired) instances still cannot be deleted.
app.post("/instance/:code/delete", async (req, res) => {
  const db = openDb();
  try {
    await ensureMigrated(db);
    if (isTetrisDemoCode(req.params.code)) {
      const err = new Error("The public Tetris demo cannot be deleted");
      err.status = 403;
      throw err;
    }
    if (!validateCheckDigit(req.params.code)) {
      const err = new Error("Invalid instance code");
      err.status = 400;
      throw err;
    }
    const access = await requireAdminOrTeacherPortalAccess(db, req);
    const row = await getInstance(db, req.params.code);
    if (!row || !row.ACTIVE) {
      const err = new Error("Instance not found");
      err.status = 404;
      throw err;
    }
    if (access.mode === "teacher") await requireTeacherOwnsInstance(db, req, row);
    const result = await deleteExpiredInstance(db, req.params.code);
    await clearAuthFailures(db, req);
    res.json({ status: "deleted", instanceCode: req.params.code, ...result });
  } catch (err) {
    errorResponse(req, res, err);
  } finally {
    db.close();
  }
});

// Change an instance's expiration date. Admin password: any instance, including
// soft-deleted ones (setting a new expiration restores them to ACTIVE). Teacher
// key: only that teacher's own still-active instances.
app.post("/instance/:code/expiration", async (req, res) => {
  const db = openDb();
  try {
    await ensureMigrated(db);
    if (isTetrisDemoCode(req.params.code)) {
      const err = new Error("The public Tetris demo never expires");
      err.status = 403;
      throw err;
    }
    if (!validateCheckDigit(req.params.code)) {
      const err = new Error("Invalid instance code");
      err.status = 400;
      throw err;
    }
    const access = await requireAdminOrTeacherPortalAccess(db, req);
    const row = await getInstance(db, req.params.code);
    if (!row || (access.mode === "teacher" && !row.ACTIVE)) {
      const err = new Error("Instance not found");
      err.status = 404;
      throw err;
    }
    if (access.mode === "teacher") await requireTeacherOwnsInstance(db, req, row);
    const expiresAt = resolveExpiresAt(req.body || {});
    await run(db, "UPDATE INSTANCES SET EXPIRES_AT = ?, ACTIVE = 1 WHERE INSTANCE_CODE = ?", [expiresAt, req.params.code]);
    await clearAuthFailures(db, req);
    res.json({ status: "updated", instanceCode: req.params.code, expiresAt, active: true });
  } catch (err) {
    errorResponse(req, res, err);
  } finally {
    db.close();
  }
});

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
  const db = openDb();
  try {
    await ensureMigrated(db);
    // The full export is gated on the admin password (same credential as the admin
    // dashboard); supply it via X-Admin-Password header or ?adminPassword=. It
    // includes instances (with their class/admin/teacher keys), replay data, global
    // teacher keys, and custom pictures (seeded pictures are reproducible).
    await requireAdminPassword(db, req);
    const [instances, data, teacherKeys, customPictures] = await Promise.all([
      all(db, "SELECT * FROM INSTANCES ORDER BY ID ASC"),
      all(db, "SELECT * FROM DATA ORDER BY TIMESTAMP ASC, ID ASC"),
      all(db, "SELECT * FROM TEACHER_KEYS ORDER BY ID ASC"),
      all(db, "SELECT * FROM PICTURES WHERE CUSTOM = 1 ORDER BY ID ASC")
    ]);
    res.setHeader("content-disposition", "attachment; filename=\"data-export.json\"");
    res.json({
      exportedAt: new Date().toISOString(),
      version: APP_VERSION,
      instances,
      data,
      teacherKeys,
      customPictures
    });
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

// Realtime (Faye) protection. Faye attaches to the raw HTTP server and bypasses
// the Express IP rate-limit middleware, so we guard it here instead. Every Faye
// message (handshake/connect/subscribe/publish) over BOTH transports (long-poll
// and WebSocket) flows through the incoming extension, so this is the single
// place that covers all realtime traffic. We use a generous per-IP per-second
// cap (matching the Worker's per-connection WebSocket cap) so active drawing is
// not throttled, plus a max message size.
const FAYE_MAX_MESSAGES_PER_SECOND = 50;
const FAYE_MAX_MESSAGE_BYTES = 64 * 1024;
const fayeRateState = new Map();

function fayeClientIp(request) {
  if (!request) return "unknown";
  const xff = request.headers && request.headers["x-forwarded-for"];
  const remote = request.socket && request.socket.remoteAddress;
  return String(xff || remote || "unknown").split(",")[0].trim();
}

function fayeMessageRateLimited(ip) {
  const win = Math.floor(Date.now() / 1000);
  const bucket = fayeRateState.get(ip) || { win, count: 0 };
  if (bucket.win !== win) {
    bucket.win = win;
    bucket.count = 0;
  }
  bucket.count += 1;
  fayeRateState.set(ip, bucket);
  if (fayeRateState.size > 10000) {
    for (const [key, value] of fayeRateState) {
      if (value.win !== win) fayeRateState.delete(key);
    }
  }
  return bucket.count > FAYE_MAX_MESSAGES_PER_SECOND;
}

// Realtime channel authorization. A channel "/faye/messages/<code>" may only be
// subscribed to or published on by a client presenting that instance's class
// access key or teacher key (the Tetris demo is exempt). Instance keys are
// cached briefly so this does not hit the database on every realtime message.
const realtimeKeyCache = new Map();

function realtimeChannelInstanceCode(channel) {
  const match = String(channel || "").match(/^\/faye\/messages\/(.+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

async function realtimeKeyOk(code, key) {
  if (!code) return false;
  if (isTetrisDemoCode(code)) return true;
  const now = Date.now();
  let entry = realtimeKeyCache.get(code);
  if (!entry || entry.exp <= now) {
    const db = openDb();
    try {
      const row = await getInstance(db, code);
      entry = row
        ? { found: true, accessKey: String(row.ACCESS_KEY || ""), teacherKey: String(row.TEACHER_KEY || ""), exp: now + 30000 }
        : { found: false, exp: now + 5000 };
    } finally {
      db.close();
    }
    realtimeKeyCache.set(code, entry);
  }
  if (!entry.found) return false;
  const provided = String(key || "");
  return provided !== "" && (provided === entry.accessKey || provided === entry.teacherKey);
}

// Returns the channel a message needs authorization for (subscribe target or a
// publish channel), or null for protocol/meta messages that need no key.
function realtimeAuthChannel(message) {
  if (message.channel === "/meta/subscribe") return message.subscription || null;
  if (typeof message.channel === "string" && message.channel.indexOf("/faye/messages/") === 0) return message.channel;
  return null;
}

const server = http.createServer(app);
const bayeux = new faye.NodeAdapter({ mount: "/faye" });
bayeux.addExtension({
  incoming(message, request, callback) {
    if (message.channel === "/meta/handshake") {
      const origin = message.ext && message.ext.origin;
      if (origin && !originAllowed(origin)) {
        message.error = "Forbidden: Invalid origin";
        return callback(message);
      }
    }
    if (message.data !== undefined) {
      let size = 0;
      try {
        size = JSON.stringify(message.data).length;
      } catch (err) {
        size = 0;
      }
      if (size > FAYE_MAX_MESSAGE_BYTES) {
        message.error = "Message too large.";
        return callback(message);
      }
    }
    if (fayeMessageRateLimited(fayeClientIp(request))) {
      message.error = "Too many realtime messages. Please slow down.";
      return callback(message);
    }
    const authChannel = realtimeAuthChannel(message);
    if (!authChannel) return callback(message);
    const key = message.ext && message.ext.key;
    realtimeKeyOk(realtimeChannelInstanceCode(authChannel), key).then((ok) => {
      if (!ok) message.error = "Invalid realtime channel key";
      callback(message);
    }).catch(() => {
      message.error = "Realtime authorization error";
      callback(message);
    });
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
      rateLimitMaxPerSecond: Number(config.rate_limit_max_per_second || 3),
      rateLimitMaxPerMinute: Number(config.rate_limit_max_per_minute || 20),
      rateLimitMaxPerDay: Number(config.rate_limit_max_per_day || 10000)
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
