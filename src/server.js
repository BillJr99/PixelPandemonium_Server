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

function openDb() {
  return new sqlite3.Database(config.database_path);
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
    adminUrl: `${base}/teacher-dashboard.html?instance=${encodeURIComponent(instanceCode)}&admin=${encodeURIComponent(adminCode)}`
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

function errorResponse(res, err) {
  const status = err.status || 500;
  res.status(status).json({ valid: false, error: err.message || "Server error" });
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

app.use(cors(corsOptions));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 180,
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
    await migrate(db);
    res.json(await listPictures(db));
  } catch (err) {
    errorResponse(res, err);
  } finally {
    db.close();
  }
});

app.post("/instance/create", async (req, res) => {
  const db = openDb();
  try {
    await migrate(db);
    const result = await createInstance(db, req.body, config);
    res.status(201).json({ ...result, ...buildUrls(result.instanceCode, result.adminCode) });
  } catch (err) {
    errorResponse(res, err);
  } finally {
    db.close();
  }
});

app.get("/instance/:code/status", async (req, res) => {
  const db = openDb();
  try {
    await migrate(db);
    if (!validateCheckDigit(req.params.code)) {
      return res.status(400).json({ valid: false, error: "Invalid check digit" });
    }
    const row = await getInstance(db, req.params.code);
    if (!row) return res.status(404).json({ valid: false, error: "Instance not found" });
    const expired = new Date(row.EXPIRES_AT).getTime() <= Date.now();
    if (expired) return res.status(410).json({ valid: false, error: "Instance expired", ...publicInstance(row) });
    res.json({ valid: true, ...publicInstance(row), ...buildUrls(row.INSTANCE_CODE, row.ADMIN_CODE) });
  } catch (err) {
    errorResponse(res, err);
  } finally {
    db.close();
  }
});

app.post("/instance/:code/insert", async (req, res) => {
  const db = openDb();
  try {
    await migrate(db);
    await requireActiveInstance(db, req.params.code);
    const data = req.body.data === undefined ? null : String(req.body.data);
    await run(db, "INSERT INTO DATA (INSTANCE_CODE, NAME, DATA) VALUES (?, ?, ?)", [
      req.params.code,
      req.params.code,
      data
    ]);
    res.status(201).json({ status: "created" });
  } catch (err) {
    errorResponse(res, err);
  } finally {
    db.close();
  }
});

app.get("/instance/:code/retrieve", async (req, res) => {
  const db = openDb();
  try {
    await migrate(db);
    await requireActiveInstance(db, req.params.code);
    const rows = await all(db, "SELECT * FROM DATA WHERE INSTANCE_CODE = ? ORDER BY TIMESTAMP ASC, ID ASC", [req.params.code]);
    res.json(rows);
  } catch (err) {
    errorResponse(res, err);
  } finally {
    db.close();
  }
});

app.post("/instance/:code/reset", async (req, res) => {
  const db = openDb();
  try {
    await migrate(db);
    const adminCode = req.body.adminCode || req.query.admin;
    const result = await resetInstance(db, req.params.code, adminCode);
    res.json({ status: "reset", ...result });
  } catch (err) {
    errorResponse(res, err);
  } finally {
    db.close();
  }
});

if (config.legacy_routes_enabled) {
  app.post("/insert", async (req, res) => {
    const db = openDb();
    try {
      await migrate(db);
      const name = req.query.name || null;
      const data = req.body.data === undefined ? null : String(req.body.data);
      await run(db, "INSERT INTO DATA (NAME, DATA) VALUES (?, ?)", [name, data]);
      res.status(201).json({ status: "created" });
    } catch (err) {
      errorResponse(res, err);
    } finally {
      db.close();
    }
  });

  app.get("/retrieve", async (req, res) => {
    const db = openDb();
    try {
      await migrate(db);
      const name = req.query.name;
      const rows = name
        ? await all(db, "SELECT * FROM DATA WHERE NAME = ? ORDER BY TIMESTAMP ASC, ID ASC", [name])
        : await all(db, "SELECT * FROM DATA ORDER BY TIMESTAMP ASC, ID ASC");
      res.json(rows);
    } catch (err) {
      errorResponse(res, err);
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
    await migrate(db);
    const rows = await all(db, "SELECT * FROM DATA ORDER BY TIMESTAMP ASC, ID ASC");
    res.setHeader("content-disposition", "attachment; filename=\"data-export.json\"");
    res.json(rows);
  } catch (err) {
    errorResponse(res, err);
  } finally {
    db.close();
  }
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
  await migrate(db);
  db.close();

  const cleanupMs = Number(config.cleanup_interval_minutes || 60) * 60 * 1000;
  setInterval(async () => {
    const cleanupDb = openDb();
    try {
      await cleanupExpired(cleanupDb);
    } catch (err) {
      console.error("Cleanup failed:", err.message);
    } finally {
      cleanupDb.close();
    }
  }, cleanupMs).unref();

  server.listen(config.port, () => {
    console.log(`Pixel Pandemonium server listening on port ${config.port}`);
  });
}

if (require.main === module) {
  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { app, server, start };
