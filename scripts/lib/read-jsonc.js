"use strict";

// Minimal JSONC reader for the deploy tooling. wrangler.jsonc is JSONC (it may
// contain // and /* */ comments and trailing commas), which wrangler itself
// parses natively — but the plain JSON.parse calls in the deploy script do not.
// Reading the config through this helper keeps those snippets working when the
// file has comments (e.g. the cron trigger note), instead of crashing with
// "Expected double-quoted property name in JSON".
//
// Comment and trailing-comma stripping is string-aware so values that legitimately
// contain "//" (such as http:// origins in ALLOWED_ORIGINS) are left intact.

function stripJsonc(text) {
  let out = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        out += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") {
        // Preserve the escaped character verbatim so \" does not end the string.
        // Guard against a lone trailing backslash (invalid JSON) so we don't
        // append the literal "undefined" before JSON.parse throws.
        if (next !== undefined) {
          out += next;
          i++;
        }
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

// Remove trailing commas (",]" / ",}") outside of strings.
function stripTrailingCommas(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        // Guard against a lone trailing backslash (invalid JSON) so we don't
        // append the literal "undefined" before JSON.parse throws.
        const escaped = text[i + 1];
        if (escaped !== undefined) {
          out += escaped;
          i++;
        }
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === "}" || text[j] === "]") {
        // Skip the comma; the following whitespace/closer is emitted normally.
        continue;
      }
    }
    out += ch;
  }
  return out;
}

function parseJsonc(text) {
  return JSON.parse(stripTrailingCommas(stripJsonc(text)));
}

function readJsonc(path) {
  return parseJsonc(require("fs").readFileSync(path, "utf8"));
}

module.exports = { parseJsonc, readJsonc, stripJsonc };
