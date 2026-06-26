// Predefined picture catalog for the Node server. The seed data (id, title,
// server spec.js path, and the full normalized spec) is generated from the
// bundled composites by scripts/extract-picture-specs.js into data/pictureSeeds.json.
// Do not hand-edit the seed file; regenerate it (and migrations/0003_seed_picture_specs.sql)
// together via that script. seedPictures() in instanceManager.js loads these into
// the PICTURES table as protected (CUSTOM=0) rows.
const PICTURES = require("./data/pictureSeeds.json");

module.exports = { PICTURES };
