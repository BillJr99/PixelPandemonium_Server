// Single source of truth for the public Tetris demo rules, shared by the Node
// server (src/server.js) and the Cloudflare Worker (src/cloudflare-worker.ts).
//
// "tetris" is a reserved, public instance code that has NO class/teacher/admin
// key: anyone may insert tiles into it and anyone may reset it. Because there is
// no key to gate vandalism, the data content itself is the only guard — every
// submitted tile must exactly match the expected pixel of the demo picture, so
// only "correct" placements are accepted. These rules apply to the Tetris demo
// only; every other instance is gated by its access key and is never subject to
// color validation here.

const TETRIS_DEMO_CODE = "tetris";

// Each catalog "page" (major tile) is PAGE_W x PAGE_H sub-pixels.
const PAGE_W = 5;
const PAGE_H = 3;

function isTetrisDemoCode(code) {
  return String(code || "").toLowerCase() === TETRIS_DEMO_CODE;
}

// Parses the 7-field insert payload "x,y,w,h,#rrggbb,xSquare,ySquare" used by the
// client. Returns the color and the square coordinates, or null if the payload is
// missing or malformed.
function parseTetrisData(data) {
  if (data === null || data === undefined) return null;
  const parts = String(data).split(",");
  if (parts.length !== 7) return null;
  for (const i of [0, 1, 2, 3, 5, 6]) {
    if (!/^\s*\d+\s*$/.test(parts[i])) return null;
  }
  const colorHex = parts[4].trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(colorHex)) return null;
  return { colorHex, xSquare: parseInt(parts[5].trim(), 10), ySquare: parseInt(parts[6].trim(), 10) };
}

// Returns the lowercase #rrggbb color the demo picture expects at the given
// square, or null when the spec is missing/incomplete or the square is out of
// range (in which case the caller does not enforce a color).
function expectedTetrisColor(spec, xSquare, ySquare) {
  if (!spec || !spec.pages || !spec.palette) return null;
  if (xSquare < 0 || xSquare >= spec.numCols * PAGE_W) return null;
  if (ySquare < 0 || ySquare >= spec.numRows * PAGE_H) return null;
  const colLabel = String.fromCharCode(65 + Math.floor(xSquare / PAGE_W));
  const rowLabel = String(Math.floor(ySquare / PAGE_H) + 1);
  const page = spec.pages.find((p) => p.col === colLabel && p.row === rowLabel);
  if (!page) return null;
  const paletteIdx = page.uncompressed[(ySquare % PAGE_H) * PAGE_W + (xSquare % PAGE_W)];
  const rgb = spec.palette[paletteIdx];
  if (!rgb) return null;
  return `#${rgb[0].toString(16).padStart(2, "0")}${rgb[1].toString(16).padStart(2, "0")}${rgb[2].toString(16).padStart(2, "0")}`;
}

// Validates a Tetris demo insert against the picture spec. Returns an error
// message string if the submission must be rejected (HTTP 400), or null if it is
// acceptable. Consults no key — the demo is public; correctness is the only gate.
function tetrisInsertError(spec, data) {
  const parsed = parseTetrisData(data);
  if (!parsed) return "Invalid data format: expected x,y,w,h,#rrggbb,xSquare,ySquare";
  const expected = expectedTetrisColor(spec, parsed.xSquare, parsed.ySquare);
  if (expected !== null && parsed.colorHex !== expected) {
    return "Color does not match the expected color for that tile";
  }
  return null;
}

module.exports = {
  TETRIS_DEMO_CODE,
  isTetrisDemoCode,
  parseTetrisData,
  expectedTetrisColor,
  tetrisInsertError
};
