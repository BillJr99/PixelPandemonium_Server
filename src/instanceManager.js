const crypto = require("crypto");
const { PICTURES } = require("./pictures");
const { customPictureId, validateSpec, specToJs, generateArtifacts } = require("./customPictures");
const RESERVED_INSTANCE_NAMES = new Set(["tetris"]);
const TETRIS_DEMO_CODE = "tetris";
const TETRIS_DEMO_ADMIN_CODE = "tetris-demo";

const CREATE_INSTANCES_TABLE = `
CREATE TABLE IF NOT EXISTS INSTANCES (
  ID INTEGER PRIMARY KEY AUTOINCREMENT,
  INSTANCE_CODE TEXT UNIQUE NOT NULL,
  ADMIN_CODE TEXT UNIQUE NOT NULL,
  INSTANCE_NAME TEXT UNIQUE NOT NULL,
  ACCESS_KEY TEXT NOT NULL,
  TEACHER_KEY TEXT NOT NULL,
  TEACHER_ACCESS_KEY TEXT,
  PICTURE_ID TEXT NOT NULL,
  TEACHER_NAME TEXT NOT NULL,
  REQUESTED_DATETIME TEXT NOT NULL,
  CREATED_AT TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
  EXPIRES_AT TEXT NOT NULL,
  ACTIVE INTEGER DEFAULT 1 NOT NULL
);
`;

const CREATE_DATA_TABLE = `
CREATE TABLE IF NOT EXISTS DATA (
  ID INTEGER PRIMARY KEY AUTOINCREMENT,
  TIMESTAMP TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
  DATA TEXT,
  NAME TEXT,
  INSTANCE_CODE TEXT
);
`;

const CREATE_PICTURES_TABLE = `
CREATE TABLE IF NOT EXISTS PICTURES (
  ID TEXT PRIMARY KEY NOT NULL,
  TITLE TEXT NOT NULL,
  SCRIPT TEXT NOT NULL,
  ENABLED INTEGER DEFAULT 1 NOT NULL,
  CUSTOM INTEGER DEFAULT 0 NOT NULL,
  SPEC_JSON TEXT,
  ARTIFACTS_JSON TEXT,
  CREATED_AT TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
`;

const CREATE_AUTH_FAILURES_TABLE = `
CREATE TABLE IF NOT EXISTS AUTH_FAILURES (
  IP TEXT PRIMARY KEY NOT NULL,
  FAILURE_COUNT INTEGER DEFAULT 0 NOT NULL,
  FIRST_FAILURE_AT TEXT NOT NULL,
  BANNED_UNTIL TEXT
);
`;

const CREATE_TEACHER_KEYS_TABLE = `
CREATE TABLE IF NOT EXISTS TEACHER_KEYS (
  ID INTEGER PRIMARY KEY AUTOINCREMENT,
  TEACHER_KEY TEXT UNIQUE NOT NULL,
  LABEL TEXT,
  CREATED_AT TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
`;

const CREATE_INDEXES = [
  "CREATE INDEX IF NOT EXISTS IDX_DATA_NAME_TIMESTAMP ON DATA (NAME, TIMESTAMP)",
  "CREATE INDEX IF NOT EXISTS IDX_DATA_INSTANCE_TIMESTAMP ON DATA (INSTANCE_CODE, TIMESTAMP, ID)",
  "CREATE INDEX IF NOT EXISTS IDX_INSTANCES_CODE ON INSTANCES (INSTANCE_CODE)",
  "CREATE INDEX IF NOT EXISTS IDX_INSTANCES_ADMIN_CODE ON INSTANCES (ADMIN_CODE)",
  "CREATE INDEX IF NOT EXISTS IDX_INSTANCES_TEACHER_ACCESS_KEY ON INSTANCES (TEACHER_ACCESS_KEY)",
  "CREATE UNIQUE INDEX IF NOT EXISTS IDX_INSTANCES_NAME_UNIQUE ON INSTANCES (INSTANCE_NAME)",
  "CREATE INDEX IF NOT EXISTS IDX_AUTH_FAILURES_BANNED_UNTIL ON AUTH_FAILURES (BANNED_UNTIL)",
  "CREATE INDEX IF NOT EXISTS IDX_PICTURES_ENABLED ON PICTURES (ENABLED, ID)",
  "CREATE UNIQUE INDEX IF NOT EXISTS IDX_TEACHER_KEYS_KEY_UNIQUE ON TEACHER_KEYS (TEACHER_KEY)"
];

function normalizeToken(value, fallback, length) {
  const token = String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return (token || fallback).slice(0, length).padEnd(length, fallback[0]);
}

function digitsOnly(value) {
  return String(value || "").replace(/\D/g, "");
}

function luhnCheckDigit(payloadDigits) {
  const digits = digitsOnly(payloadDigits);
  let sum = 0;
  let alternate = true;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return String((10 - (sum % 10)) % 10);
}

function validateCheckDigit(code) {
  if (String(code || "").toLowerCase() === TETRIS_DEMO_CODE) return true;
  const digits = digitsOnly(code);
  if (digits.length < 11) return false;
  const suffix = digits.slice(-11);
  return luhnCheckDigit(suffix.slice(0, -1)) === suffix.slice(-1);
}

function dateToken(dateTime) {
  const date = new Date(dateTime);
  if (Number.isNaN(date.getTime())) {
    return normalizeToken(dateTime, "00000000", 8).replace(/\D/g, "").padEnd(8, "0").slice(0, 8);
  }
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${mm}${dd}${hh}${min}`;
}

function generateInstanceCode(pictureId, teacherName, dateTime) {
  const picture = normalizeToken(pictureId, "PIC", 3);
  const teacher = normalizeToken(teacherName, "TCH", 4);
  const when = dateToken(dateTime);
  const random = String(crypto.randomInt(0, 100)).padStart(2, "0");
  const payload = `${picture}${teacher}${when}${random}`;
  const check = luhnCheckDigit(when + random);
  return `${picture}-${teacher}-${when.slice(0, 4)}-${when.slice(4, 6)}${when.slice(6, 8)}-${random}-${check}`;
}

function generateAdminCode() {
  return crypto.randomBytes(12).toString("hex").toUpperCase();
}

function generateAccessKey() {
  return crypto.randomBytes(8).toString("hex").toUpperCase();
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row || null);
    });
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function migrate(db) {
  await run(db, CREATE_DATA_TABLE);
  await run(db, CREATE_INSTANCES_TABLE);
  await run(db, CREATE_PICTURES_TABLE);
  await run(db, CREATE_AUTH_FAILURES_TABLE);
  await run(db, CREATE_TEACHER_KEYS_TABLE);
  await run(db, "ALTER TABLE DATA ADD COLUMN INSTANCE_CODE TEXT").catch((err) => {
    if (!/duplicate column/i.test(err.message)) throw err;
  });
  await run(db, "ALTER TABLE INSTANCES ADD COLUMN ACTIVE INTEGER DEFAULT 1 NOT NULL").catch((err) => {
    if (!/duplicate column/i.test(err.message)) throw err;
  });
  await run(db, "ALTER TABLE INSTANCES ADD COLUMN INSTANCE_NAME TEXT").catch((err) => {
    if (!/duplicate column/i.test(err.message)) throw err;
  });
  await run(db, "UPDATE INSTANCES SET INSTANCE_NAME = INSTANCE_CODE WHERE INSTANCE_NAME IS NULL OR INSTANCE_NAME = ''");
  await run(db, "ALTER TABLE INSTANCES ADD COLUMN ACCESS_KEY TEXT").catch((err) => {
    if (!/duplicate column/i.test(err.message)) throw err;
  });
  await run(db, "UPDATE INSTANCES SET ACCESS_KEY = ADMIN_CODE WHERE ACCESS_KEY IS NULL OR ACCESS_KEY = ''");
  await run(db, "ALTER TABLE INSTANCES ADD COLUMN TEACHER_KEY TEXT").catch((err) => {
    if (!/duplicate column/i.test(err.message)) throw err;
  });
  await run(db, "UPDATE INSTANCES SET TEACHER_KEY = ADMIN_CODE WHERE TEACHER_KEY IS NULL OR TEACHER_KEY = ''");
  await run(db, "ALTER TABLE INSTANCES ADD COLUMN TEACHER_ACCESS_KEY TEXT").catch((err) => {
    if (!/duplicate column/i.test(err.message)) throw err;
  });
  for (const sql of [
    "ALTER TABLE PICTURES ADD COLUMN CUSTOM INTEGER DEFAULT 0 NOT NULL",
    "ALTER TABLE PICTURES ADD COLUMN SPEC_JSON TEXT",
    "ALTER TABLE PICTURES ADD COLUMN ARTIFACTS_JSON TEXT",
    "ALTER TABLE PICTURES ADD COLUMN CREATED_AT TEXT"
  ]) {
    await run(db, sql).catch((err) => {
      if (!/duplicate column/i.test(err.message)) throw err;
    });
  }
  for (const sql of CREATE_INDEXES) await run(db, sql);
  await seedPictures(db);
  await seedDemoInstances(db);
}

async function ensureTeacherKey(db, teacherKey, label = "Default Teacher") {
  const key = String(teacherKey || "").trim();
  if (!key) return null;
  await run(
    db,
    `INSERT INTO TEACHER_KEYS (TEACHER_KEY, LABEL)
     VALUES (?, ?)
     ON CONFLICT(TEACHER_KEY) DO UPDATE SET LABEL = COALESCE(TEACHER_KEYS.LABEL, excluded.LABEL)`,
    [key, label]
  );
  return get(db, "SELECT ID as id, TEACHER_KEY as teacherKey, LABEL as label, CREATED_AT as createdAt FROM TEACHER_KEYS WHERE TEACHER_KEY = ?", [key]);
}

async function listTeacherKeys(db) {
  return all(db, "SELECT ID as id, TEACHER_KEY as teacherKey, LABEL as label, CREATED_AT as createdAt FROM TEACHER_KEYS ORDER BY CREATED_AT ASC, ID ASC");
}

async function createTeacherKey(db, teacherKey, label = "") {
  const key = String(teacherKey || "").trim();
  if (!key) {
    const err = new Error("teacherKey is required");
    err.status = 400;
    throw err;
  }
  const existing = await get(db, "SELECT ID FROM TEACHER_KEYS WHERE TEACHER_KEY = ?", [key]);
  if (existing) {
    const err = new Error("Teacher key already exists");
    err.status = 409;
    throw err;
  }
  await run(db, "INSERT INTO TEACHER_KEYS (TEACHER_KEY, LABEL) VALUES (?, ?)", [key, String(label || "").trim()]);
  return get(db, "SELECT ID as id, TEACHER_KEY as teacherKey, LABEL as label, CREATED_AT as createdAt FROM TEACHER_KEYS WHERE TEACHER_KEY = ?", [key]);
}

async function teacherKeyExists(db, teacherKey) {
  const key = String(teacherKey || "").trim();
  if (!key) return false;
  return !!(await get(db, "SELECT ID FROM TEACHER_KEYS WHERE TEACHER_KEY = ?", [key]));
}

async function seedPictures(db) {
  // Seed the predefined catalog as protected (CUSTOM=0) rows that carry their full
  // spec, so the Node DB self-seeds identically to the D1 migration
  // (migrations/0003_seed_picture_specs.sql). SCRIPT points at the server spec.js
  // endpoint; the client loads predefined and custom pictures the same way.
  for (const picture of PICTURES) {
    await run(
      db,
      `INSERT INTO PICTURES (ID, TITLE, SCRIPT, ENABLED, CUSTOM, SPEC_JSON)
       VALUES (?, ?, ?, 1, 0, ?)
       ON CONFLICT(ID) DO UPDATE SET
         TITLE = excluded.TITLE,
         SCRIPT = excluded.SCRIPT,
         ENABLED = 1,
         CUSTOM = 0,
         SPEC_JSON = excluded.SPEC_JSON`,
      [picture.id, picture.title, picture.script, JSON.stringify(picture.spec)]
    );
  }
}

async function seedDemoInstances(db) {
  await run(db, "UPDATE INSTANCES SET INSTANCE_NAME = INSTANCE_CODE WHERE LOWER(INSTANCE_NAME) = 'tetris' AND INSTANCE_CODE <> 'tetris'");
  await run(
    db,
    `INSERT INTO INSTANCES
      (INSTANCE_CODE, ADMIN_CODE, INSTANCE_NAME, ACCESS_KEY, TEACHER_KEY, PICTURE_ID, TEACHER_NAME, REQUESTED_DATETIME, EXPIRES_AT, ACTIVE)
      VALUES (?, ?, ?, '', '', 'tetris', 'Public Demo', '2026-01-01T00:00:00', '9999-12-31T23:59:59.999Z', 1)
      ON CONFLICT(INSTANCE_CODE) DO UPDATE SET
        ADMIN_CODE = excluded.ADMIN_CODE,
        INSTANCE_NAME = excluded.INSTANCE_NAME,
        ACCESS_KEY = '',
        TEACHER_KEY = '',
        PICTURE_ID = 'tetris',
        TEACHER_NAME = 'Public Demo',
        EXPIRES_AT = excluded.EXPIRES_AT,
        ACTIVE = 1`,
    [TETRIS_DEMO_CODE, TETRIS_DEMO_ADMIN_CODE, TETRIS_DEMO_CODE]
  );
}

async function listPictures(db) {
  // Include grid dimensions (parsed in JS for node-sqlite/D1 portability) so the
  // client's create/admin menus can show sizes without fetching each spec.
  const rows = await all(db, "SELECT ID as id, TITLE as title, SCRIPT as script, CUSTOM as custom, SPEC_JSON as specJson FROM PICTURES WHERE ENABLED = 1 ORDER BY TITLE ASC");
  return rows.map((row) => {
    const result = { id: row.id, title: row.title, script: row.script, custom: row.custom };
    if (row.specJson) {
      try {
        const spec = JSON.parse(row.specJson);
        result.numRows = Number(spec.numRows) || 0;
        result.numCols = Number(spec.numCols) || 0;
      } catch (err) {
        // Leave dims unset if SPEC_JSON is somehow malformed.
      }
    }
    return result;
  });
}

async function getPicture(db, pictureId) {
  return get(db, "SELECT ID as id, TITLE as title, SCRIPT as script, CUSTOM as custom, SPEC_JSON as specJson, ARTIFACTS_JSON as artifactsJson FROM PICTURES WHERE ID = ? AND ENABLED = 1", [pictureId]);
}

async function createCustomPicture(db, input) {
  const title = String(input.title || "Custom Picture").trim().slice(0, 120) || "Custom Picture";
  const spec = validateSpec(input.spec);
  const id = input.id ? String(input.id).trim() : customPictureId(title);
  if (!/^custom-[a-z0-9-]+$/i.test(id)) {
    const err = new Error("Custom picture id must start with custom- and contain only letters, numbers, and hyphens");
    err.status = 400;
    throw err;
  }
  const script = `/pictures/${encodeURIComponent(id)}/spec.js`;
  const artifacts = input.artifacts && typeof input.artifacts === "object" ? input.artifacts : generateArtifacts(title, spec);
  await run(
    db,
    `INSERT INTO PICTURES (ID, TITLE, SCRIPT, ENABLED, CUSTOM, SPEC_JSON, ARTIFACTS_JSON)
     VALUES (?, ?, ?, 1, 1, ?, ?)
     ON CONFLICT(ID) DO UPDATE SET
       TITLE = excluded.TITLE,
       SCRIPT = excluded.SCRIPT,
       ENABLED = 1,
       CUSTOM = 1,
       SPEC_JSON = excluded.SPEC_JSON,
       ARTIFACTS_JSON = excluded.ARTIFACTS_JSON`,
    [id, title, script, JSON.stringify(spec), JSON.stringify(artifacts)]
  );
  return { id, title, script, custom: 1, spec, artifacts };
}

// Serve spec.js for ANY enabled picture that has a stored spec — predefined
// (CUSTOM=0) and custom (CUSTOM=1) alike. Predefined pictures are seeded with
// SPEC_JSON and no ARTIFACTS_JSON; artifacts for them are generated on demand below.
async function pictureSpecJs(db, pictureId) {
  const picture = await getPicture(db, pictureId);
  if (!picture || !picture.specJson) {
    const err = new Error("Picture not found");
    err.status = 404;
    throw err;
  }
  return specToJs(JSON.parse(picture.specJson));
}

async function pictureArtifacts(db, pictureId) {
  const picture = await getPicture(db, pictureId);
  if (!picture || (!picture.artifactsJson && !picture.specJson)) {
    const err = new Error("Picture not found");
    err.status = 404;
    throw err;
  }
  const artifacts = picture.artifactsJson
    ? JSON.parse(picture.artifactsJson)
    : generateArtifacts(picture.title, JSON.parse(picture.specJson));
  return { title: picture.title, artifacts };
}

async function createInstance(db, input, config) {
  const pictureId = String(input.pictureId || "").trim();
  const teacherName = String(input.teacherName || "").trim();
  const dateTime = String(input.dateTime || "").trim();
  const expirationHours = Number(input.expirationHours || config.default_expiration_hours || 8760);
  const requestedInstanceName = String(input.instanceName || "").trim();
  const teacherAccessKey = String(input.teacherAccessKey || "").trim() || null;

  if (!pictureId || !teacherName || !dateTime) {
    const err = new Error("Missing: pictureId, teacherName, dateTime");
    err.status = 400;
    throw err;
  }

  const picture = await get(db, "SELECT ID FROM PICTURES WHERE ID = ? AND ENABLED = 1", [pictureId]);
  if (!picture) {
    const err = new Error("Unknown pictureId");
    err.status = 400;
    throw err;
  }

  let instanceCode;
  for (let i = 0; i < 100; i++) {
    instanceCode = generateInstanceCode(pictureId, teacherName, dateTime);
    const existing = await get(db, "SELECT ID FROM INSTANCES WHERE INSTANCE_CODE = ?", [instanceCode]);
    if (!existing) break;
    instanceCode = null;
  }
  if (!instanceCode) {
    const err = new Error("Could not generate a unique instance code for that picture, teacher, and date/time");
    err.status = 409;
    throw err;
  }

  const instanceName = requestedInstanceName || instanceCode;
  if (RESERVED_INSTANCE_NAMES.has(instanceName.toLowerCase())) {
    const err = new Error("Instance name is reserved");
    err.status = 409;
    throw err;
  }
  const existingName = await get(db, "SELECT ID FROM INSTANCES WHERE INSTANCE_NAME = ?", [instanceName]);
  if (existingName) {
    const err = new Error("Instance name already exists");
    err.status = 409;
    throw err;
  }

  const expiresAt = new Date(Date.now() + expirationHours * 60 * 60 * 1000).toISOString();
  const adminCode = generateAdminCode();
  const accessKey = generateAccessKey();
  const teacherKey = generateAccessKey();
  await run(
    db,
    `INSERT INTO INSTANCES
      (INSTANCE_CODE, ADMIN_CODE, INSTANCE_NAME, ACCESS_KEY, TEACHER_KEY, TEACHER_ACCESS_KEY, PICTURE_ID, TEACHER_NAME, REQUESTED_DATETIME, EXPIRES_AT)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [instanceCode, adminCode, instanceName, accessKey, teacherKey, teacherAccessKey, pictureId, teacherName, dateTime, expiresAt]
  );

  return { instanceCode, adminCode, accessKey, teacherKey, instanceName, pictureId, teacherName, requestedDateTime: dateTime, expiresAt };
}

async function getInstance(db, instanceCode) {
  return get(db, "SELECT * FROM INSTANCES WHERE INSTANCE_CODE = ?", [instanceCode]);
}

function isExpired(instance) {
  return new Date(instance.EXPIRES_AT).getTime() <= Date.now();
}

async function requireActiveInstance(db, code) {
  if (!validateCheckDigit(code)) {
    const err = new Error("Invalid instance code");
    err.status = 400;
    throw err;
  }
  const instance = await getInstance(db, code);
  if (!instance) {
    const err = new Error("Instance not found");
    err.status = 404;
    throw err;
  }
  if (!instance.ACTIVE) {
    const err = new Error("Instance not found");
    err.status = 404;
    throw err;
  }
  if (isExpired(instance)) {
    const err = new Error("Instance expired");
    err.status = 410;
    throw err;
  }
  return instance;
}

async function resetInstance(db, code, adminCode) {
  const instance = await requireActiveInstance(db, code);
  if (instance.INSTANCE_CODE === TETRIS_DEMO_CODE) {
    const result = await run(db, "DELETE FROM DATA WHERE INSTANCE_CODE = ?", [code]);
    return { deletedRows: result.changes || 0 };
  }
  if (instance.ADMIN_CODE !== adminCode) {
    const err = new Error("Invalid admin code");
    err.status = 403;
    throw err;
  }
  const result = await run(db, "DELETE FROM DATA WHERE INSTANCE_CODE = ?", [code]);
  return { deletedRows: result.changes || 0 };
}

// Removal policy: an instance may only be removed once it has expired (live
// classes stay protected). Soft-deletes the instance (ACTIVE = 0, so it drops
// out of every listing and read path) and purges its replay data.
async function deleteExpiredInstance(db, code) {
  const instance = await getInstance(db, code);
  if (!instance || !instance.ACTIVE) {
    const err = new Error("Instance not found");
    err.status = 404;
    throw err;
  }
  if (!isExpired(instance)) {
    const err = new Error("Only expired instances can be deleted");
    err.status = 403;
    throw err;
  }
  await run(db, "UPDATE INSTANCES SET ACTIVE = 0 WHERE INSTANCE_CODE = ?", [code]);
  const result = await run(db, "DELETE FROM DATA WHERE INSTANCE_CODE = ?", [code]);
  return { deletedRows: result.changes || 0 };
}

async function cleanupExpired(db) {
  const now = new Date().toISOString();
  const expired = await all(db, "SELECT INSTANCE_CODE FROM INSTANCES WHERE EXPIRES_AT <= ?", [now]);
  for (const row of expired) {
    await run(db, "DELETE FROM DATA WHERE INSTANCE_CODE = ?", [row.INSTANCE_CODE]);
  }
  // Soft-delete expired instances: they disappear from teacher lists and read
  // paths but stay visible to admins, who can restore them with a new
  // expiration date via POST /instance/:code/expiration.
  await run(db, "UPDATE INSTANCES SET ACTIVE = 0 WHERE EXPIRES_AT <= ? AND ACTIVE = 1", [now]);
  return { expiredInstances: expired.length };
}

module.exports = {
  CREATE_DATA_TABLE,
  CREATE_INSTANCES_TABLE,
  CREATE_PICTURES_TABLE,
  CREATE_AUTH_FAILURES_TABLE,
  CREATE_TEACHER_KEYS_TABLE,
  CREATE_INDEXES,
  migrate,
  seedPictures,
  seedDemoInstances,
  listPictures,
  getPicture,
  createCustomPicture,
  pictureSpecJs,
  pictureArtifacts,
  ensureTeacherKey,
  listTeacherKeys,
  createTeacherKey,
  teacherKeyExists,
  createInstance,
  getInstance,
  requireActiveInstance,
  resetInstance,
  deleteExpiredInstance,
  cleanupExpired,
  validateCheckDigit,
  luhnCheckDigit,
  generateInstanceCode,
  run,
  get,
  all
};
