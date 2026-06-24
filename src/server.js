const http = require("http");
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
  run,
  all
} = require("./instanceManager");

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

function buildUrls(instanceCode, adminCode) {
  const base = String(config.client_base_url).replace(/\/$/, "");
  return {
    studentUrl: `${base}/instructions.html?instance=${encodeURIComponent(instanceCode)}`,
    replayUrl: `${base}/replay.html?instance=${encodeURIComponent(instanceCode)}`,
    adminUrl: `${base}/admin.html?instance=${encodeURIComponent(instanceCode)}&admin=${encodeURIComponent(adminCode)}`
  };
}

function publicInstance(row) {
  return {
    instanceCode: row.INSTANCE_CODE,
    pictureId: row.PICTURE_ID,
    teacherName: row.TEACHER_NAME,
    requestedDateTime: row.REQUESTED_DATETIME,
    createdAt: row.CREATED_AT,
    expiresAt: row.EXPIRES_AT
  };
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

async function requireAdminInstance(db, code, adminCode) {
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
  if (row.ADMIN_CODE !== adminCode) {
    const err = new Error("Invalid admin code");
    err.status = 403;
    throw err;
  }
  return row;
}

const corsOptions = {
  origin(origin, callback) {
    if (originAllowed(origin)) callback(null, true);
    else callback(new Error(`Not allowed by CORS: ${origin}`));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
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
app.use(express.json({ limit: "1mb" }));
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

app.post("/instance/create", async (req, res) => {
  const db = openDb();
  try {
    await ensureMigrated(db);
    const result = await createInstance(db, req.body, config);
    res.status(201).json({ ...result, ...buildUrls(result.instanceCode, result.adminCode) });
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
    const expired = new Date(row.EXPIRES_AT).getTime() <= Date.now();
    if (expired) return res.status(410).json({ valid: false, error: "Instance expired", ...publicInstance(row) });
    res.json({ valid: true, ...publicInstance(row), ...buildUrls(row.INSTANCE_CODE, row.ADMIN_CODE) });
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
    await requireActiveInstance(db, req.params.code);
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
    await requireActiveInstance(db, req.params.code);
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
    const result = await resetInstance(db, req.params.code, adminCode);
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
    const row = await requireAdminInstance(db, req.params.code, req.query.admin);
    const rows = await all(db, "SELECT * FROM DATA WHERE INSTANCE_CODE = ? ORDER BY TIMESTAMP ASC, ID ASC", [req.params.code]);
    res.json({ ...publicInstance(row), rows });
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
    await requireAdminInstance(db, req.params.code, req.body.adminCode || req.query.admin);
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

app.post("/instance/:code/event/:id/update", async (req, res) => {
  const db = openDb();
  try {
    await ensureMigrated(db);
    await requireAdminInstance(db, req.params.code, req.body.adminCode || req.query.admin);
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
    await requireAdminInstance(db, req.params.code, req.body.adminCode || req.query.admin);
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
