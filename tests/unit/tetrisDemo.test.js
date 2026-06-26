const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isTetrisDemoCode,
  parseTetrisData,
  expectedTetrisColor,
  tetrisInsertError
} = require("../../src/tetrisDemo");

// These tests pin the rules of the public "tetris" demo without standing up a
// server, a database, or any network listener. They exercise the exact logic the
// Node server (src/server.js) and the Cloudflare Worker (src/cloudflare-worker.ts)
// both call: the insert routes run `tetrisInsertError` only when
// `isTetrisDemoCode` is true, and every reset/insert auth guard short-circuits on
// that same predicate. So the predicate + validator together capture the three
// behaviors we care about:
//   1. anyone can add a (correct) tile to tetris with no key,
//   2. an incorrect tile submitted to tetris is rejected, and that color check
//      applies to tetris only, and
//   3. anyone can reset tetris with no key.

// A 1-page (5x3) demo picture with a 3-color palette, laid out so every square
// has a distinct, known expected color.
const PALETTE = { white: [255, 255, 255], black: [0, 0, 0], red: [255, 0, 0] };
const HEX = { white: "#ffffff", black: "#000000", red: "#ff0000" };
const spec = {
  palette: [PALETTE.white, PALETTE.black, PALETTE.red],
  numRows: 1,
  numCols: 1,
  pages: [
    {
      col: "A",
      row: "1",
      // 5 wide x 3 tall, row-major palette indices.
      uncompressed: [
        0, 1, 2, 0, 1,
        1, 2, 0, 1, 2,
        2, 0, 1, 2, 0
      ]
    }
  ]
};

// Build the 7-field insert payload the client sends:
// "x,y,w,h,#rrggbb,xSquare,ySquare". Only the color and the two square
// coordinates affect validation; the first four fields just have to be integers.
function payload(colorHex, xSquare, ySquare) {
  return ["0", "0", "10", "10", colorHex, String(xSquare), String(ySquare)].join(",");
}

// Every in-range square and the color the demo expects there, derived from the
// spec so the test cannot drift from the layout above.
function eachSquare() {
  const squares = [];
  for (let y = 0; y < spec.numRows * 3; y++) {
    for (let x = 0; x < spec.numCols * 5; x++) {
      squares.push({ x, y, expected: expectedTetrisColor(spec, x, y) });
    }
  }
  return squares;
}

test("isTetrisDemoCode recognizes only the reserved public demo code", () => {
  // True here is what makes add + reset public and what turns on color checks.
  assert.equal(isTetrisDemoCode("tetris"), true);
  assert.equal(isTetrisDemoCode("TETRIS"), true);
  assert.equal(isTetrisDemoCode(" Tetris "), false); // exact code, not trimmed
  // Real instance codes are NOT the demo: they keep their access/teacher/admin
  // key requirements and are never color-validated.
  assert.equal(isTetrisDemoCode("A1-CAT-0007"), false);
  assert.equal(isTetrisDemoCode(""), false);
  assert.equal(isTetrisDemoCode(null), false);
  assert.equal(isTetrisDemoCode(undefined), false);
});

test("anyone can add a correct tile to tetris (no key, only the pixel matters)", () => {
  // tetrisInsertError takes no key argument at all: acceptance depends solely on
  // the submission matching the picture, which is exactly why the demo can be
  // public. A correct submission for every square is accepted.
  for (const { x, y, expected } of eachSquare()) {
    assert.notEqual(expected, null, `square (${x},${y}) should have an expected color`);
    assert.equal(
      tetrisInsertError(spec, payload(expected, x, y)),
      null,
      `correct color ${expected} at (${x},${y}) should be accepted`
    );
    // Case-insensitive: the client may send uppercase hex.
    assert.equal(tetrisInsertError(spec, payload(expected.toUpperCase(), x, y)), null);
  }
});

test("an incorrect tile submitted to tetris is rejected (exact per-pixel match)", () => {
  // Square (0,0) expects white; black and red are valid palette colors but wrong
  // for THIS square, and must still be rejected (per-pixel, not just in-palette).
  assert.equal(expectedTetrisColor(spec, 0, 0), HEX.white);
  assert.equal(
    tetrisInsertError(spec, payload(HEX.black, 0, 0)),
    "Color does not match the expected color for that tile"
  );
  assert.equal(
    tetrisInsertError(spec, payload(HEX.red, 0, 0)),
    "Color does not match the expected color for that tile"
  );
  // A well-formed color that is not in the palette at all is also rejected.
  assert.equal(
    tetrisInsertError(spec, payload("#abcdef", 0, 0)),
    "Color does not match the expected color for that tile"
  );

  // Every square rejects a deliberately-wrong color (pick any palette color that
  // differs from the expected one).
  for (const { x, y, expected } of eachSquare()) {
    const wrong = expected === HEX.white ? HEX.black : HEX.white;
    assert.equal(
      tetrisInsertError(spec, payload(wrong, x, y)),
      "Color does not match the expected color for that tile",
      `wrong color ${wrong} at (${x},${y}) should be rejected`
    );
  }
});

test("malformed tetris submissions are rejected before any color check", () => {
  const formatError = "Invalid data format: expected row,col,w,h,#rrggbb,pageRow,pageCol";
  assert.equal(tetrisInsertError(spec, null), formatError);
  assert.equal(tetrisInsertError(spec, undefined), formatError);
  assert.equal(tetrisInsertError(spec, ""), formatError);
  assert.equal(tetrisInsertError(spec, "0,0,10,10,#ffffff,0"), formatError); // 6 fields
  assert.equal(tetrisInsertError(spec, "0,0,10,10,#ffffff,0,0,0"), formatError); // 8 fields
  assert.equal(tetrisInsertError(spec, "0,0,10,10,#fff,0,0"), formatError); // short hex
  assert.equal(tetrisInsertError(spec, "0,0,10,10,white,0,0"), formatError); // not hex
  assert.equal(tetrisInsertError(spec, "0,0,10,10,#ffffff,x,0"), formatError); // non-numeric square
  assert.equal(tetrisInsertError(spec, "0,0,10,10,#gggggg,0,0"), formatError); // non-hex digits
});

test("parseTetrisData extracts color and square coordinates", () => {
  assert.deepEqual(parseTetrisData("0,0,10,10,#FF0000,3,2"), {
    colorHex: "#ff0000",
    xSquare: 3,
    ySquare: 2
  });
  assert.equal(parseTetrisData("nope"), null);
  assert.equal(parseTetrisData(null), null);
});

test("color validation never runs for non-tetris instances", () => {
  // The server only calls tetrisInsertError when isTetrisDemoCode(code) is true.
  // For any real instance code that gate is false, so a 'wrong' color is never
  // rejected on color grounds — those instances are protected by their key, not
  // by content. Guard the property directly so the invariant is documented.
  const realCodes = ["A1-CAT-0007", "classroom-42", "ABCD12"];
  for (const code of realCodes) {
    assert.equal(isTetrisDemoCode(code), false, `${code} must not be treated as the demo`);
  }
});
