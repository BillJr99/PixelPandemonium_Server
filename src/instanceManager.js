const crypto = require("crypto");
const { PICTURES } = require("./pictures");

const CREATE_INSTANCES_TABLE = `
CREATE TABLE IF NOT EXISTS INSTANCES (
  ID INTEGER PRIMARY KEY AUTOINCREMENT,
  INSTANCE_CODE TEXT UNIQUE NOT NULL,
  ADMIN_CODE TEXT UNIQUE NOT NULL,
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
  ENABLED INTEGER DEFAULT 1 NOT NULL
);
`;

const CREATE_INDEXES = [
  "CREATE INDEX IF NOT EXISTS IDX_DATA_NAME_TIMESTAMP ON DATA (NAME, TIMESTAMP)",
  "CREATE INDEX IF NOT EXISTS IDX_DATA_INSTANCE_TIMESTAMP ON DATA (INSTANCE_CODE, TIMESTAMP, ID)",
  "CREATE INDEX IF NOT EXISTS IDX_INSTANCES_CODE ON INSTANCES (INSTANCE_CODE)",
  "CREATE INDEX IF NOT EXISTS IDX_INSTANCES_ADMIN_CODE ON INSTANCES (ADMIN_CODE)",
  "CREATE INDEX IF NOT EXISTS IDX_PICTURES_ENABLED ON PICTURES (ENABLED, ID)"
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
  const digits = digitsOnly(code);
  if (digits.length < 2) return false;
  return luhnCheckDigit(digits.slice(0, -1)) === digits.slice(-1);
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
  await run(db, "ALTER TABLE DATA ADD COLUMN INSTANCE_CODE TEXT").catch((err) => {
    if (!/duplicate column/i.test(err.message)) throw err;
  });
  await run(db, "ALTER TABLE INSTANCES ADD COLUMN ACTIVE INTEGER DEFAULT 1 NOT NULL").catch((err) => {
    if (!/duplicate column/i.test(err.message)) throw err;
  });
  for (const sql of CREATE_INDEXES) await run(db, sql);
  await seedPictures(db);
}

async function seedPictures(db) {
  for (const picture of PICTURES) {
    await run(
      db,
      `INSERT INTO PICTURES (ID, TITLE, SCRIPT, ENABLED)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(ID) DO UPDATE SET
         TITLE = excluded.TITLE,
         SCRIPT = excluded.SCRIPT,
         ENABLED = 1`,
      [picture.id, picture.title, picture.script]
    );
  }
}

async function listPictures(db) {
  return all(db, "SELECT ID as id, TITLE as title, SCRIPT as script FROM PICTURES WHERE ENABLED = 1 ORDER BY TITLE ASC");
}

async function createInstance(db, input, config) {
  const pictureId = String(input.pictureId || "").trim();
  const teacherName = String(input.teacherName || "").trim();
  const dateTime = String(input.dateTime || "").trim();
  const expirationHours = Number(input.expirationHours || config.default_expiration_hours || 72);

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
  for (let i = 0; i < 5; i++) {
    instanceCode = generateInstanceCode(pictureId, teacherName, dateTime);
    const existing = await get(db, "SELECT ID FROM INSTANCES WHERE INSTANCE_CODE = ?", [instanceCode]);
    if (!existing) break;
  }

  const expiresAt = new Date(Date.now() + expirationHours * 60 * 60 * 1000).toISOString();
  const adminCode = generateAdminCode();
  await run(
    db,
    `INSERT INTO INSTANCES
      (INSTANCE_CODE, ADMIN_CODE, PICTURE_ID, TEACHER_NAME, REQUESTED_DATETIME, EXPIRES_AT)
      VALUES (?, ?, ?, ?, ?, ?)`,
    [instanceCode, adminCode, pictureId, teacherName, dateTime, expiresAt]
  );

  return { instanceCode, adminCode, pictureId, teacherName, requestedDateTime: dateTime, expiresAt };
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
  if (instance.ADMIN_CODE !== adminCode) {
    const err = new Error("Invalid admin code");
    err.status = 403;
    throw err;
  }
  const result = await run(db, "DELETE FROM DATA WHERE INSTANCE_CODE = ?", [code]);
  return { deletedRows: result.changes || 0 };
}

async function cleanupExpired(db) {
  const expired = await all(db, "SELECT INSTANCE_CODE FROM INSTANCES WHERE EXPIRES_AT <= ?", [new Date().toISOString()]);
  for (const row of expired) {
    await run(db, "DELETE FROM DATA WHERE INSTANCE_CODE = ?", [row.INSTANCE_CODE]);
  }
  return { expiredInstances: expired.length };
}

module.exports = {
  CREATE_DATA_TABLE,
  CREATE_INSTANCES_TABLE,
  CREATE_PICTURES_TABLE,
  CREATE_INDEXES,
  migrate,
  seedPictures,
  listPictures,
  createInstance,
  getInstance,
  requireActiveInstance,
  resetInstance,
  cleanupExpired,
  validateCheckDigit,
  luhnCheckDigit,
  generateInstanceCode,
  run,
  get,
  all
};
