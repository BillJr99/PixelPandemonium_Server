const test = require("node:test");
const assert = require("node:assert/strict");
const sqlite3 = require("sqlite3").verbose();
const {
  migrate,
  createInstance,
  getInstance,
  requireActiveInstance,
  resetInstance,
  listPictures,
  createCustomPicture,
  customPictureSpecJs,
  customPictureArtifacts,
  validateCheckDigit,
  generateInstanceCode,
  run,
  all
} = require("../../src/instanceManager");

function memoryDb() {
  return new sqlite3.Database(":memory:");
}

const config = {
  default_expiration_hours: 72
};

const tinySpec = {
  palette: [[255, 255, 255], [0, 0, 0]],
  numRows: 1,
  numCols: 1,
  pages: [
    {
      col: "A",
      row: "1",
      uncompressed: [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0]
    }
  ]
};

test("migrate seeds original CS173 picture inventory", async () => {
  const db = memoryDb();
  await migrate(db);
  const pictures = await listPictures(db);
  assert.equal(pictures.length, 16);
  assert.ok(pictures.some((picture) => picture.id === "tetris"));
  assert.ok(pictures.some((picture) => picture.id === "yellowsubmarine2022"));
  db.close();
});

test("generated instance codes include a valid check digit", () => {
  const code = generateInstanceCode("tetris", "Ada Lovelace", "2026-06-23T10:30:00");
  assert.match(code, /^TET-ADAL-0623-1030-\d{2}-\d$/);
  assert.equal(validateCheckDigit(code), true);
});

test("createInstance rejects unknown picture ids", async () => {
  const db = memoryDb();
  await migrate(db);
  await assert.rejects(
    createInstance(db, {
      pictureId: "missing-picture",
      teacherName: "Ada Lovelace",
      dateTime: "2026-06-23T10:30:00"
    }, config),
    /Unknown pictureId/
  );
  db.close();
});

test("createInstance stores active instance metadata", async () => {
  const db = memoryDb();
  await migrate(db);
  const created = await createInstance(db, {
    pictureId: "tetris",
    teacherName: "Ada Lovelace",
    dateTime: "2026-06-23T10:30:00",
    expirationHours: 1
  }, config);

  const row = await getInstance(db, created.instanceCode);
  assert.equal(row.PICTURE_ID, "tetris");
  assert.equal(row.TEACHER_NAME, "Ada Lovelace");
  assert.deepEqual(await requireActiveInstance(db, created.instanceCode), row);
  db.close();
});

test("createCustomPicture stores normalized specs and generated artifacts", async () => {
  const db = memoryDb();
  await migrate(db);
  const picture = await createCustomPicture(db, {
    title: "Tiny Custom",
    spec: tinySpec
  });

  assert.match(picture.id, /^custom-tiny-custom-/);
  const pictures = await listPictures(db);
  assert.ok(pictures.some((item) => item.id === picture.id && item.custom === 1));

  const js = await customPictureSpecJs(db, picture.id);
  assert.match(js, /var palette =/);
  assert.match(js, /var numRows = 1/);
  assert.match(js, /var pages =/);

  const { artifacts } = await customPictureArtifacts(db, picture.id);
  assert.ok(artifacts["Post-It_tiny_custom_composite.js"]);
  assert.ok(artifacts["Post-It_tiny_custom_composite.csv"]);
  assert.ok(artifacts["Post-It_tiny_custom_uncompressed.txt"]);
  assert.ok(artifacts["Post-It_tiny_custom_compressed.txt"]);
  assert.ok(artifacts["ColorMap_tiny_custom.txt"]);
  assert.ok(artifacts["ColorMap_tiny_custom.html"]);
  db.close();
});

test("createInstance accepts stored custom picture ids", async () => {
  const db = memoryDb();
  await migrate(db);
  const picture = await createCustomPicture(db, {
    title: "Instance Custom",
    spec: tinySpec
  });
  const created = await createInstance(db, {
    pictureId: picture.id,
    teacherName: "Ada Lovelace",
    dateTime: "2026-06-23T10:30:00",
    expirationHours: 1
  }, config);

  const row = await getInstance(db, created.instanceCode);
  assert.equal(row.PICTURE_ID, picture.id);
  db.close();
});

test("createCustomPicture rejects incomplete specs", async () => {
  const db = memoryDb();
  await migrate(db);
  await assert.rejects(
    createCustomPicture(db, {
      title: "Broken Custom",
      spec: { palette: [[0, 0, 0]], numRows: 1, numCols: 1, pages: [] }
    }),
    /pages must match/
  );
  db.close();
});

test("requireActiveInstance rejects invalid check digit", async () => {
  const db = memoryDb();
  await migrate(db);
  await assert.rejects(requireActiveInstance(db, "TET-ADAL-0623-1030-22-0"), /Invalid instance code/);
  db.close();
});

test("requireActiveInstance rejects expired instances", async () => {
  const db = memoryDb();
  await migrate(db);
  const created = await createInstance(db, {
    pictureId: "tetris",
    teacherName: "Ada Lovelace",
    dateTime: "2026-06-23T10:30:00",
    expirationHours: 1
  }, config);
  await run(db, "UPDATE INSTANCES SET EXPIRES_AT = ? WHERE INSTANCE_CODE = ?", [
    new Date(Date.now() - 1000).toISOString(),
    created.instanceCode
  ]);
  await assert.rejects(requireActiveInstance(db, created.instanceCode), /Instance expired/);
  db.close();
});

test("requireActiveInstance treats inactive instances as not found", async () => {
  const db = memoryDb();
  await migrate(db);
  const created = await createInstance(db, {
    pictureId: "tetris",
    teacherName: "Ada Lovelace",
    dateTime: "2026-06-23T10:30:00",
    expirationHours: 1
  }, config);
  await run(db, "UPDATE INSTANCES SET ACTIVE = 0 WHERE INSTANCE_CODE = ?", [created.instanceCode]);
  await assert.rejects(requireActiveInstance(db, created.instanceCode), /Instance not found/);
  db.close();
});

test("resetInstance deletes only rows for the requested instance", async () => {
  const db = memoryDb();
  await migrate(db);
  const first = await createInstance(db, {
    pictureId: "tetris",
    teacherName: "Ada Lovelace",
    dateTime: "2026-06-23T10:30:00"
  }, config);
  const second = await createInstance(db, {
    pictureId: "tetris",
    teacherName: "Grace Hopper",
    dateTime: "2026-06-23T11:30:00"
  }, config);
  await run(db, "INSERT INTO DATA (INSTANCE_CODE, NAME, DATA) VALUES (?, ?, ?)", [first.instanceCode, first.instanceCode, "first"]);
  await run(db, "INSERT INTO DATA (INSTANCE_CODE, NAME, DATA) VALUES (?, ?, ?)", [second.instanceCode, second.instanceCode, "second"]);

  const result = await resetInstance(db, first.instanceCode, first.adminCode);
  assert.equal(result.deletedRows, 1);

  const firstRows = await all(db, "SELECT * FROM DATA WHERE INSTANCE_CODE = ?", [first.instanceCode]);
  const secondRows = await all(db, "SELECT * FROM DATA WHERE INSTANCE_CODE = ?", [second.instanceCode]);
  assert.equal(firstRows.length, 0);
  assert.equal(secondRows.length, 1);
  db.close();
});

test("resetInstance rejects wrong admin code", async () => {
  const db = memoryDb();
  await migrate(db);
  const created = await createInstance(db, {
    pictureId: "tetris",
    teacherName: "Ada Lovelace",
    dateTime: "2026-06-23T10:30:00"
  }, config);

  await assert.rejects(resetInstance(db, created.instanceCode, "wrong"), /Invalid admin code/);
  db.close();
});
