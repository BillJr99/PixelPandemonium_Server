#!/usr/bin/env node
"use strict";

// One-time migration tool: read the original posterizer composite .js files and
// emit the server-side seed data so the predefined catalog can live entirely in
// the server database.
//
// This was used to perform the client->server picture-catalog migration. The
// client `files/drawingcanvas-*` composites it reads have since been removed from
// the client repo, so re-running it requires restoring those composites from git
// history (or pointing it at another copy via the path argument). The SOURCE
// mapping below is self-contained so the script does not depend on pictures.js
// (which now simply loads the generated seeds).
//
// To change the predefined catalog going forward, edit src/data/pictureSeeds.json
// and regenerate migrations/0003_seed_picture_specs.sql so Node and D1 stay in
// sync — never hand-edit only one of the two outputs.
//
// Outputs (both generated from the SAME in-memory specs):
//   - src/data/pictureSeeds.json          (runtime seed source for the Node server)
//   - migrations/0003_seed_picture_specs.sql (D1/Worker seed via wrangler migrations)
//
// Usage:  node scripts/extract-picture-specs.js [path-to-PixelPandemonium_Client]

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const { validateSpec } = require("../src/customPictures");

// Original predefined catalog: id, display title, and the composite path relative
// to the client repo. Self-contained so the script is independent of pictures.js.
const SOURCE = [
  { id: "tetris", title: "Demo (Tetris)", script: "files/drawingcanvas-tetris/Post-It_tetris_composite.js" },
  { id: "cs4allpa2022", title: "CS4AllPA-2022", script: "files/drawingcanvas-cs4allpa2022/Post-It_CSforALLinPA_RWB_bk_v6x_composite.js" },
  { id: "cs4philly2021", title: "CS4Philly-2021", script: "files/drawingcanvas-cs4philly2021/Post-It_CS4Philly_2021_v0_composite.js" },
  { id: "cs4philly2022", title: "CS4Philly-2022", script: "files/drawingcanvas-cs4philly2022/Post-It_CS4Philly_2022_composite.js" },
  { id: "eagles", title: "Eagles", script: "files/drawingcanvas-eagles/Post-It_Eagles_Logo_composite.js" },
  { id: "eagles2", title: "Eagles2", script: "files/drawingcanvas-eagles2/Post-It_Eagles_Logo2_composite.js" },
  { id: "ghopper", title: "GHopper", script: "files/drawingcanvas-ghopper/Post-It_CS4Philly_GHopper_composite.js" },
  { id: "lovestatue", title: "LoveStatue", script: "files/drawingcanvas-lovestatue/Post-It_LOVE_Statue_composite.js" },
  { id: "mikewazowski", title: "MikeWazowski", script: "files/drawingcanvas-mikewazowski/Post-It_MikeWazowski2_composite.js" },
  { id: "phillyscifest", title: "PhillySciFest-2022", script: "files/drawingcanvas-phillyscifest/Post-It_Banner_PhillySciFest_v4_composite.js" },
  { id: "pixar2022", title: "Pixar-2022", script: "files/drawingcanvas-pixar2022/Post-It_CS4Philly_Pixar_2022_composite.js" },
  { id: "robotspringboard", title: "RobotSpringboard", script: "files/drawingcanvas-robotspringboard/Post-It_RobotSpringboard_2018_v2a_composite.js" },
  { id: "robotspringboard2022", title: "RobotSpringboard-2022", script: "files/drawingcanvas-robotspringboard2022/Post-It_RobotSpringboard_2022_composite.js" },
  { id: "rocky2022", title: "Rocky-2022", script: "files/drawingcanvas-rocky2022/Post-It_Rocky_ArtMuseum_2022_composite.js" },
  { id: "yellowsubmarine", title: "YellowSubmarine", script: "files/drawingcanvas-yellowsubmarine/Post-It_YellowSubmarine_composite.js" },
  { id: "yellowsubmarine2022", title: "YellowSubmarine-2022", script: "files/drawingcanvas-yellowsubmarine2022/Post-It_YellowSubmarine_2022_composite.js" }
];

const SERVER_DIR = path.resolve(__dirname, "..");
const CLIENT_DIR = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(SERVER_DIR, "..", "PixelPandemonium_Client");

const DATA_DIR = path.join(SERVER_DIR, "src", "data");
const SEEDS_JSON = path.join(DATA_DIR, "pictureSeeds.json");
const MIGRATION_SQL = path.join(SERVER_DIR, "migrations", "0003_seed_picture_specs.sql");

// Evaluate a composite .js file (which declares `var palette/numRows/numCols/pages`)
// in an isolated context and capture those globals.
function loadComposite(filePath) {
  const code = fs.readFileSync(filePath, "utf8");
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: filePath, timeout: 5000 });
  const { palette, numRows, numCols, pages } = sandbox;
  if (palette === undefined || pages === undefined || numRows === undefined || numCols === undefined) {
    throw new Error(`Composite did not define palette/numRows/numCols/pages: ${filePath}`);
  }
  return { palette, numRows: Number(numRows), numCols: Number(numCols), pages };
}

function sqlString(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function main() {
  if (!fs.existsSync(CLIENT_DIR)) {
    console.error(`Client repo not found at: ${CLIENT_DIR}`);
    console.error("Pass the path explicitly: node scripts/extract-picture-specs.js <client-dir>");
    process.exit(1);
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const seeds = [];
  for (const picture of SOURCE) {
    const compositePath = path.join(CLIENT_DIR, picture.script);
    let raw;
    try {
      raw = loadComposite(compositePath);
    } catch (err) {
      console.error(`FAILED ${picture.id}: ${err.message}`);
      process.exit(1);
    }
    const spec = validateSpec(raw); // normalize + validate (15px/page, palette, dims)
    // Store only the spec. Downloadable artifacts (composite.js/csv/txt/html) are
    // fully derivable from the spec and are generated on demand by the zip route,
    // so we don't bloat the DB / migration with them.
    seeds.push({
      id: picture.id,
      title: picture.title,
      script: `/pictures/${encodeURIComponent(picture.id)}/spec.js`,
      spec
    });
    console.log(`OK   ${picture.id.padEnd(22)} ${spec.numCols}x${spec.numRows} tiles, ${spec.palette.length} colors`);
  }

  fs.writeFileSync(SEEDS_JSON, JSON.stringify(seeds, null, 2) + "\n");

  const sqlLines = [
    "-- Generated by scripts/extract-picture-specs.js — do not hand-edit.",
    "-- Seeds the predefined (CUSTOM=0) picture catalog, including full spec content,",
    "-- into the PICTURES table for D1/Cloudflare. Idempotent; safe to re-apply.",
    ""
  ];
  for (const seed of seeds) {
    sqlLines.push(
      "INSERT INTO PICTURES (ID, TITLE, SCRIPT, ENABLED, CUSTOM, SPEC_JSON, ARTIFACTS_JSON) VALUES (",
      `  ${sqlString(seed.id)}, ${sqlString(seed.title)}, ${sqlString(seed.script)}, 1, 0,`,
      `  ${sqlString(JSON.stringify(seed.spec))}, NULL`,
      ") ON CONFLICT(ID) DO UPDATE SET",
      "  TITLE = excluded.TITLE, SCRIPT = excluded.SCRIPT, ENABLED = 1, CUSTOM = 0,",
      "  SPEC_JSON = excluded.SPEC_JSON;",
      ""
    );
  }
  fs.writeFileSync(MIGRATION_SQL, sqlLines.join("\n"));

  console.log(`\nWrote ${seeds.length} pictures:`);
  console.log(`  ${path.relative(SERVER_DIR, SEEDS_JSON)}`);
  console.log(`  ${path.relative(SERVER_DIR, MIGRATION_SQL)}`);
}

main();
