const test = require("node:test");
const assert = require("node:assert/strict");
const { customPictureId, validateSpec, specToJs, generateArtifacts, zipFiles } = require("../../src/customPictures");

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

function readU32(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function readU16(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

test("customPictureId slugs the title with a random hex suffix", () => {
  assert.match(customPictureId("My Title!"), /^custom-my-title-[0-9a-f]{8}$/);
  assert.match(customPictureId(""), /^custom-custom-[0-9a-f]{8}$/);
  assert.notEqual(customPictureId("Same"), customPictureId("Same"));
});

test("validateSpec accepts multi-letter column labels", () => {
  const pages = [];
  for (const col of ["Z", "AA"]) {
    pages.push({ col, row: "1", uncompressed: tinySpec.pages[0].uncompressed });
  }
  const spec = validateSpec({ palette: tinySpec.palette, numRows: 1, numCols: 2, pages });
  assert.deepEqual(spec.pages.map((page) => page.col), ["Z", "AA"]);
});

test("validateSpec rejects malformed input with status 400", () => {
  const cases = [
    null,
    { palette: [], numRows: 1, numCols: 1, pages: tinySpec.pages },
    { palette: tinySpec.palette, numRows: 0, numCols: 1, pages: tinySpec.pages },
    { palette: tinySpec.palette, numRows: 1, numCols: 2, pages: tinySpec.pages },
    { palette: tinySpec.palette, numRows: 1, numCols: 1, pages: [{ col: "A", row: "1", uncompressed: [0, 1] }] },
    { palette: [[255, 255, "x"]], numRows: 1, numCols: 1, pages: tinySpec.pages }
  ];
  for (const spec of cases) {
    try {
      validateSpec(spec);
      assert.fail("expected validateSpec to throw");
    } catch (err) {
      assert.equal(err.status, 400);
    }
  }
});

test("specToJs emits the client-facing globals", () => {
  const js = specToJs(validateSpec(tinySpec));
  assert.match(js, /var palette =/);
  assert.match(js, /var numRows = 1/);
  assert.match(js, /var numCols = 1/);
  assert.match(js, /var pages =/);
});

test("zipFiles builds a parseable store-only zip as a Uint8Array", () => {
  const spec = validateSpec(tinySpec);
  const files = generateArtifacts("Smoke Custom", spec);
  const names = Object.keys(files);
  assert.ok(names.some((name) => /^Post-It_.*_composite\.csv$/.test(name)));
  assert.ok(names.some((name) => /^ColorMap_.*\.txt$/.test(name)));

  const zip = zipFiles(files);
  assert.ok(zip instanceof Uint8Array);
  assert.ok(!Buffer.isBuffer(zip));
  assert.equal(readU32(zip, 0), 0x04034b50);

  // End-of-central-directory record: fixed 22-byte tail (no zip comment).
  const eocdOffset = zip.length - 22;
  assert.equal(readU32(zip, eocdOffset), 0x06054b50);
  assert.equal(readU16(zip, eocdOffset + 10), names.length);

  // First local header carries the first file name, uncompressed.
  const nameLength = readU16(zip, 26);
  const name = new TextDecoder().decode(zip.slice(30, 30 + nameLength));
  assert.equal(name, names[0]);
});
