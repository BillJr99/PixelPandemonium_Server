const crypto = require("crypto");

function sanitizeIdPart(value) {
  return String(value || "custom")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "custom";
}

function customPictureId(title) {
  return `custom-${sanitizeIdPart(title)}-${crypto.randomBytes(4).toString("hex")}`;
}

function validateSpec(spec) {
  if (!spec || typeof spec !== "object") throw badSpec("Missing spec");
  const palette = spec.palette;
  const pages = spec.pages;
  const numRows = Number(spec.numRows);
  const numCols = Number(spec.numCols);
  if (!Array.isArray(palette) || palette.length === 0) throw badSpec("Spec requires a non-empty palette");
  if (!Number.isInteger(numRows) || numRows <= 0) throw badSpec("Spec requires a positive integer numRows");
  if (!Number.isInteger(numCols) || numCols <= 0) throw badSpec("Spec requires a positive integer numCols");
  if (!Array.isArray(pages) || pages.length !== numRows * numCols) throw badSpec("Spec pages must match numRows * numCols");

  const normalizedPalette = palette.map((color, index) => {
    if (!Array.isArray(color) || color.length !== 3) throw badSpec(`Palette color ${index} must be [r,g,b]`);
    return color.map((component) => {
      const n = Number(component);
      if (!Number.isInteger(n) || n < 0 || n > 255) throw badSpec(`Palette color ${index} has invalid RGB values`);
      return n;
    });
  });

  const normalizedPages = pages.map((page, index) => {
    const col = String(page && page.col ? page.col : "").trim().toUpperCase();
    const row = String(page && page.row ? page.row : "").trim();
    const uncompressed = page && page.uncompressed;
    if (!/^[A-Z]+$/.test(col) || !/^\d+$/.test(row)) throw badSpec(`Page ${index + 1} requires col and row`);
    if (!Array.isArray(uncompressed) || uncompressed.length !== 15) throw badSpec(`Page ${col}-${row} requires 15 uncompressed pixels`);
    const pixels = uncompressed.map((pixel) => {
      const n = Number(pixel);
      if (!Number.isInteger(n) || n < 0 || n >= normalizedPalette.length) throw badSpec(`Page ${col}-${row} references an invalid palette index`);
      return n;
    });
    const compressed = Array.isArray(page.compressed) && page.compressed.length ? page.compressed.map(Number) : compressPixels(pixels);
    return { col, row, uncompressed: pixels, compressed };
  });

  return {
    palette: normalizedPalette,
    numRows,
    numCols,
    pages: normalizedPages
  };
}

function badSpec(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function compressPixels(pixels) {
  const compressed = [];
  let prev = pixels[0];
  let count = 1;
  for (let i = 1; i < pixels.length; i++) {
    if (pixels[i] === prev) count++;
    else {
      compressed.push(count, prev);
      prev = pixels[i];
      count = 1;
    }
  }
  compressed.push(count, prev);
  return compressed;
}

function specToJs(spec) {
  return [
    `var palette = ${JSON.stringify(spec.palette, null, 2)};`,
    `var numRows = ${Number(spec.numRows)} ;`,
    `var numCols = ${Number(spec.numCols)} ;`,
    `var pages = ${JSON.stringify(spec.pages, null, 2)};`,
    ""
  ].join("\n");
}

function artifactBase(title) {
  return sanitizeIdPart(title).replace(/-/g, "_") || "custom";
}

function generateArtifacts(title, spec) {
  const base = artifactBase(title);
  const files = {};
  files[`Post-It_${base}_composite.js`] = specToJs(spec);
  files[`Post-It_${base}_composite.csv`] = compositeCsv(spec);
  files[`Post-It_${base}_uncompressed.txt`] = uncompressedTxt(spec);
  files[`Post-It_${base}_compressed.txt`] = compressedTxt(spec);
  files[`ColorMap_${base}.txt`] = colorMapTxt(spec);
  files[`ColorMap_${base}.html`] = colorMapHtml(title, spec);
  return files;
}

function compositeCsv(spec) {
  const header = ["PageRow", "PageColumn"];
  for (let i = 1; i <= 15; i++) header.push(`pixel${i}`);
  for (let i = 1; i <= 15; i++) header.push(`count${i}`, `color${i}`);
  const rows = [header.join(",")];
  spec.pages.forEach((page) => {
    const row = [page.col, page.row, ...page.uncompressed];
    const padded = page.compressed.slice();
    while (padded.length < 30) padded.push("");
    rows.push(row.concat(padded).join(","));
  });
  return rows.join("\n") + "\n";
}

function uncompressedTxt(spec) {
  return spec.pages.map((page) => `${page.col}\t${page.row}\t${page.uncompressed.join("\t")}`).join("\n") + "\n";
}

function compressedTxt(spec) {
  return spec.pages.map((page) => `${page.col}\t${page.row}\t${page.compressed.join("\t")}`).join("\n") + "\n";
}

function colorMapTxt(spec) {
  const lines = [`${spec.numCols * 5} ${spec.numRows * 3}`, String(spec.palette.length)];
  spec.palette.forEach((color, index) => lines.push(`${index}: ${color.join(" ")}`));
  lines.push("", "Color Count:");
  const counts = new Array(spec.palette.length).fill(0);
  spec.pages.forEach((page) => page.uncompressed.forEach((pixel) => { counts[pixel]++; }));
  counts.forEach((count, index) => lines.push(`${index}: ${count}`));
  return lines.join("\n") + "\n";
}

function colorMapHtml(title, spec) {
  const counts = new Array(spec.palette.length).fill(0);
  spec.pages.forEach((page) => page.uncompressed.forEach((pixel) => { counts[pixel]++; }));
  const rows = spec.palette.map((color, index) => {
    const rgb = color.join(",");
    return `<tr><td>${index}</td><td>${color.join(" ")}</td><td style="background-color:rgb(${rgb});">&nbsp;</td><td>${counts[index]}</td></tr>`;
  });
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)} Color Map</title></head>
<body><h1>${escapeHtml(title)}</h1><table border="1" cellspacing="0" cellpadding="6">
<tr><th>Index</th><th>RGB Values</th><th>Color</th><th>Count</th></tr>
${rows.join("\n")}
</table><h3>Total Count = ${counts.reduce((a, b) => a + b, 0)}</h3></body></html>
`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function crc32(buffer) {
  let crc = ~0;
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

function zipFiles(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  Object.entries(files).forEach(([name, content]) => {
    const nameBuf = Buffer.from(name);
    const data = Buffer.from(String(content), "utf8");
    const crc = crc32(data);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length),
      u16(nameBuf.length), u16(0), nameBuf, data
    ]);
    localParts.push(local);
    centralParts.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length),
      u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBuf
    ]));
    offset += local.length;
  });
  const central = Buffer.concat(centralParts);
  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(centralParts.length), u16(centralParts.length),
    u32(central.length), u32(offset), u16(0)
  ]);
  return Buffer.concat([...localParts, central, end]);
}

module.exports = {
  customPictureId,
  validateSpec,
  specToJs,
  generateArtifacts,
  zipFiles
};
