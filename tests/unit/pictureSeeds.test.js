const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { validateSpec, specToJs } = require("../../src/customPictures");
const { PICTURES } = require("../../src/pictures");

// Pure unit tests for the predefined picture seed data and spec helpers. These do
// not require a database or the server, so they run with `node --test` directly.

test("predefined seed catalog is present and well-formed", () => {
  assert.ok(Array.isArray(PICTURES) && PICTURES.length >= 16, "expected at least 16 seeded pictures");
  const ids = PICTURES.map((p) => p.id);
  assert.ok(ids.includes("tetris"), "tetris must be seeded");
  assert.equal(new Set(ids).size, ids.length, "picture ids must be unique");
});

test("every seeded picture has a server spec.js script and a valid spec", () => {
  for (const picture of PICTURES) {
    assert.ok(picture.id && picture.title, `picture missing id/title: ${JSON.stringify(picture)}`);
    assert.equal(
      picture.script,
      `/pictures/${encodeURIComponent(picture.id)}/spec.js`,
      `picture ${picture.id} script must point at the server spec.js endpoint`
    );
    // validateSpec is the same gate used for custom uploads: palette of [r,g,b],
    // positive dims, pages === numRows*numCols, each page exactly 15 pixels.
    const normalized = validateSpec(picture.spec);
    assert.equal(normalized.pages.length, normalized.numRows * normalized.numCols, `${picture.id}: page count mismatch`);
    for (const page of normalized.pages) {
      assert.equal(page.uncompressed.length, 15, `${picture.id}: page ${page.col}-${page.row} must have 15 pixels`);
    }
  }
});

test("specToJs emits the globals the client renderer expects", () => {
  const tetris = PICTURES.find((p) => p.id === "tetris");
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(specToJs(tetris.spec), sandbox);
  assert.ok(Array.isArray(sandbox.palette) && sandbox.palette.length > 0, "palette global");
  assert.ok(Array.isArray(sandbox.pages) && sandbox.pages.length > 0, "pages global");
  assert.equal(Number(sandbox.numRows), tetris.spec.numRows, "numRows global");
  assert.equal(Number(sandbox.numCols), tetris.spec.numCols, "numCols global");
});

test("seeded picture ids cannot collide with the custom-picture id namespace", () => {
  // createCustomPicture() requires ids to match ^custom-...; predefined ids must
  // not, so a teacher's custom upload can never overwrite a seeded picture.
  for (const picture of PICTURES) {
    assert.ok(!/^custom-/i.test(picture.id), `seeded id ${picture.id} must not use the custom- prefix`);
  }
});
