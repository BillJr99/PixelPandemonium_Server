const fs = require("fs");
const path = require("path");

const DEFAULTS = {
  port: 8000,
  database_path: "./main.db",
  allowed_origins: ["http://localhost:4000", "http://127.0.0.1:4000"],
  client_base_url: "http://localhost:4000",
  default_expiration_hours: 72,
  cleanup_interval_minutes: 60,
  download_token: "change-me-before-deploying",
  legacy_routes_enabled: true
};

function parseScalar(value) {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed.replace(/^["']|["']$/g, "");
}

function parseSimpleYaml(text) {
  const result = {};
  const lines = text.split(/\r?\n/);
  let currentKey = null;
  let currentObject = null;

  for (const rawLine of lines) {
    if (!rawLine.trim() || rawLine.trim().startsWith("#")) continue;
    const indent = rawLine.match(/^\s*/)[0].length;
    const line = rawLine.trim();

    if (line.startsWith("- ") && currentKey) {
      if (!Array.isArray(result[currentKey])) result[currentKey] = [];
      result[currentKey].push(parseScalar(line.slice(2)));
      continue;
    }

    const match = line.match(/^([^:]+):(.*)$/);
    if (!match) continue;
    const key = match[1].trim();
    const value = match[2].trim();

    if (indent === 0) {
      currentObject = null;
      if (value === "") {
        result[key] = {};
        currentKey = key;
        currentObject = result[key];
      } else {
        result[key] = parseScalar(value);
        currentKey = key;
      }
    } else if (currentObject) {
      currentObject[key] = parseScalar(value);
    }
  }

  return result;
}

function loadConfig(configPath = path.join(process.cwd(), "config.yaml")) {
  if (!fs.existsSync(configPath)) return { ...DEFAULTS };
  const parsed = parseSimpleYaml(fs.readFileSync(configPath, "utf8"));
  return {
    ...DEFAULTS,
    ...parsed,
    allowed_origins: parsed.allowed_origins || DEFAULTS.allowed_origins
  };
}

module.exports = { loadConfig, parseSimpleYaml };
