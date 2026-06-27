#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

SKIP_LOGIN=0
DESTROY=0
REPORT_ONLY=0

for arg in "$@"; do
  case "$arg" in
    --skip-login)
      SKIP_LOGIN=1
      ;;
    --destroy)
      DESTROY=1
      ;;
    --report-only)
      REPORT_ONLY=1
      ;;
    -h|--help)
      cat <<'USAGE'
Usage: ./scripts/deploy-cloudflare.sh [--skip-login] [--destroy] [--report-only]

Guides a Cloudflare deployment:
  1. Checks local tools and installs npm dependencies if needed.
  2. Reuses an existing Cloudflare login if one is cached (offering a menu to keep
     it or re-login), otherwise runs `wrangler login`. --skip-login trusts the
     cached credentials without prompting.
  3. If the Worker and/or D1 database already exist, prompts whether to destroy
     and recreate each before deploying.
  4. Prompts for Worker client URL and allowed origins, then offers an optional
     (default no) menu to review and edit advanced tuning vars (expiration, rate
     limits, auth-ban thresholds, legacy routes) stored in wrangler.jsonc.
  5. Creates/configures the D1 database if wrangler.jsonc has no database id.
  6. Sets ADMIN_PASSWORD and DEFAULT_TEACHER_KEY as Cloudflare Worker secrets, and
     caches them in a gitignored .cloudflare-secrets.env so they can be shown on
     every deploy (press Enter to keep the cached value).
  7. Applies remote D1 migrations.
  8. Deploys the Worker.
  9. Prints the Worker URL and the resolved environment values, including the
     ADMIN_PASSWORD / DEFAULT_TEACHER_KEY values.

With --destroy, the script logs in, asks for explicit confirmation, then deletes
the Worker and D1 database named in wrangler.jsonc instead of deploying.

With --report-only, the script logs in (or keeps/selects an existing login and
account) exactly as usual, then does no deployment or configuration: it skips
straight to printing the report (Worker name, vars, D1 database, and the cached
secrets) and quits.

Secret values are cached in a gitignored .cloudflare-secrets.env (never committed)
and printed in the terminal summary, so run it somewhere private. Cloudflare Worker
secrets cannot be read back from the API, which is why the local cache is used.
USAGE
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      echo "Run with --help for usage." >&2
      exit 1
      ;;
  esac
done

WRANGLER_CONFIG="wrangler.jsonc"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

confirm() {
  local prompt="$1"
  local answer
  read -r -p "$prompt [y/N] " answer
  case "$answer" in
    y|Y|yes|YES)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

prompt_with_default() {
  local prompt="$1"
  local default="$2"
  local value
  if [ -n "$default" ]; then
    printf '%s' "$prompt [$default]: " >&2
    read -r value
    printf '%s' "${value:-$default}"
  else
    printf '%s' "$prompt: " >&2
    read -r value
    printf '%s' "$value"
  fi
}

read_secret() {
  local prompt="$1"
  local default="${2:-}"
  local first
  local second
  while true; do
    if [ -n "$default" ]; then
      printf '%s' "$prompt [keep current]: " >&2
    else
      printf '%s' "$prompt: " >&2
    fi
    read -r -s first
    echo >&2
    if [ -z "$first" ] && [ -n "$default" ]; then
      printf '%s' "$default"
      return 0
    fi
    printf '%s' "Confirm $prompt: " >&2
    read -r -s second
    echo >&2
    if [ -z "$first" ]; then
      echo "Value cannot be empty." >&2
    elif [ "$first" != "$second" ]; then
      echo "Values did not match. Try again." >&2
    else
      printf '%s' "$first"
      return 0
    fi
  done
}

# Cloudflare Worker secrets are write-only (they cannot be read back via the API),
# so to print them in the deployment summary on every run we cache the values we
# set in a gitignored local file. Reads the cached value for a key, or "".
SECRETS_CACHE=".cloudflare-secrets.env"
cache_get() {
  local key="$1"
  [ -f "$SECRETS_CACHE" ] || { printf ''; return 0; }
  local line
  line="$(grep -E "^${key}=" "$SECRETS_CACHE" | tail -n 1 || true)"
  printf '%s' "${line#*=}"
}

wrangler() {
  if [ -x "node_modules/.bin/wrangler" ]; then
    node_modules/.bin/wrangler "$@"
  else
    npx wrangler "$@"
  fi
}

# Parse `wrangler whoami` output into "id<TAB>name" lines, one per account the
# current login can reach. Wrangler prints a box-drawing table with an
# "Account Name | Account ID" header; account ids are 32 hex characters.
parse_whoami_accounts() {
  local file="$1"
  node - "$file" <<'NODE'
const fs = require("fs");
const text = fs.readFileSync(process.argv[2], "utf8");
const out = [];
const seen = new Set();
for (const line of text.split("\n")) {
  const id = line.match(/[0-9a-fA-F]{32}/);
  if (!id) continue;
  // Split the box-drawing row into cells and drop the id cell to recover the name.
  const cells = line
    .split(/[│|]/)
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0);
  const name = cells.find((cell) => cell !== id[0]) || "(unnamed account)";
  if (name === "Account Name") continue; // header row
  if (seen.has(id[0])) continue;
  seen.add(id[0]);
  out.push(`${id[0]}\t${name}`);
}
process.stdout.write(out.join("\n"));
NODE
}

# After login, figure out which Cloudflare account the deploy should target. A
# login invited onto another account (e.g. as a Workers Platform Admin / back-up
# admin) can reach more than one account, and Wrangler will otherwise prompt
# mid-run, which breaks the piped commands below. When several accounts are
# reachable we present a menu and export CLOUDFLARE_ACCOUNT_ID for the rest of the
# script. An account id already set in the environment is respected as-is.
select_cloudflare_account() {
  if [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
    echo "Using CLOUDFLARE_ACCOUNT_ID from the environment: $CLOUDFLARE_ACCOUNT_ID"
    return
  fi

  echo
  echo "Listing Cloudflare accounts your login can access (wrangler whoami)..."
  local whoami_output
  whoami_output="$(mktemp)"
  if ! wrangler whoami >"$whoami_output" 2>&1; then
    echo "Could not run 'wrangler whoami'; continuing with Wrangler's default account selection." >&2
    rm -f "$whoami_output"
    return
  fi

  local accounts
  accounts="$(parse_whoami_accounts "$whoami_output")"
  rm -f "$whoami_output"

  if [ -z "$accounts" ]; then
    echo "Could not read an account list from 'wrangler whoami'; continuing with Wrangler's default." >&2
    return
  fi

  local ids=()
  local names=()
  while IFS=$'\t' read -r id name; do
    [ -n "$id" ] || continue
    ids+=("$id")
    names+=("$name")
  done <<< "$accounts"

  if [ "${#ids[@]}" -eq 1 ]; then
    echo "One Cloudflare account is accessible: ${names[0]} (${ids[0]}). Using it."
    return
  fi

  echo
  echo "Multiple Cloudflare accounts are accessible:"
  local i
  for i in "${!ids[@]}"; do
    echo "  $((i + 1))) ${names[$i]} (${ids[$i]})"
  done

  local choice
  while true; do
    printf '%s' "Select account to deploy to [1]: " >&2
    read -r choice
    choice="${choice:-1}"
    if [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le "${#ids[@]}" ]; then
      break
    fi
    echo "Enter a number between 1 and ${#ids[@]}." >&2
  done

  local selected_index=$((choice - 1))
  export CLOUDFLARE_ACCOUNT_ID="${ids[$selected_index]}"
  echo "Deploying to: ${names[$selected_index]} ($CLOUDFLARE_ACCOUNT_ID)"
}

# Decide how to authenticate with Cloudflare. Wrangler caches OAuth credentials in
# ~/.config/.wrangler (outside this repo), so a previous login usually still works.
# With --skip-login we trust that cache silently. Otherwise we probe `wrangler whoami`:
# if a login already exists, a menu offers keeping it or doing a manual re-login; if
# none exists (or the user chooses re-login), we fall back to `wrangler login`.
ensure_cloudflare_login() {
  if [ "$SKIP_LOGIN" -eq 1 ]; then
    echo
    echo "Skipping Wrangler login because --skip-login was provided (using any cached credentials)."
    return
  fi

  echo
  echo "Checking for an existing Cloudflare login (wrangler whoami)..."
  local whoami_file
  whoami_file="$(mktemp)"
  if wrangler whoami >"$whoami_file" 2>&1 \
      && grep -qiE "You are logged in|associated with the email|Account Name|Account ID" "$whoami_file"; then
    echo "An existing Cloudflare login was found:"
    local email_line
    email_line="$(grep -iE "associated with the email" "$whoami_file" | head -n 1 || true)"
    if [ -n "$email_line" ]; then
      echo "  ${email_line#*]}"
    fi
    rm -f "$whoami_file"
    echo "  1) Keep this login (default)"
    echo "  2) Log out and re-login manually"
    local choice
    while true; do
      printf '%s' "Select [1]: " >&2
      read -r choice
      choice="${choice:-1}"
      case "$choice" in
        1)
          echo "Keeping the existing Cloudflare login."
          return
          ;;
        2)
          echo "Re-authenticating with Cloudflare. Complete the browser login if prompted."
          wrangler logout >/dev/null 2>&1 || true
          wrangler login
          return
          ;;
        *)
          echo "Enter 1 or 2." >&2
          ;;
      esac
    done
  fi

  rm -f "$whoami_file"
  echo "No existing Cloudflare login found."
  echo "Opening Cloudflare login with Wrangler. Complete the browser login if prompted."
  wrangler login
}

json_value() {
  local expression="$1"
  node -e "
const fs = require('fs');
const config = JSON.parse(fs.readFileSync('$WRANGLER_CONFIG', 'utf8'));
const value = $expression;
if (Array.isArray(value)) console.log(value.join(','));
else if (value === undefined || value === null) console.log('');
else console.log(String(value));
"
}

# Print every non-secret var that will be deployed to the Worker, so the final
# installation can be audited. Secrets (ADMIN_PASSWORD/DEFAULT_TEACHER_KEY) are
# stored as Cloudflare secrets and removed from vars, so they never appear here;
# they are summarized separately below.
print_worker_vars() {
  node -e "
const fs = require('fs');
const config = JSON.parse(fs.readFileSync('$WRANGLER_CONFIG', 'utf8'));
const vars = config.vars || {};
for (const key of Object.keys(vars)) {
  console.log('  ' + key + ': ' + vars[key]);
}
"
}

update_wrangler_config() {
  local client_base_url="$1"
  local allowed_origins="$2"
  local database_id="$3"
  node - "$client_base_url" "$allowed_origins" "$database_id" <<'NODE'
const fs = require("fs");
const path = "wrangler.jsonc";
const [clientBaseUrl, allowedOrigins, databaseId] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(path, "utf8"));

config.vars = config.vars || {};
config.vars.ALLOWED_ORIGINS = allowedOrigins;
config.vars.CLIENT_BASE_URL = clientBaseUrl;
delete config.vars.ADMIN_PASSWORD;
delete config.vars.DEFAULT_TEACHER_KEY;

if (databaseId) {
  const databases = config.d1_databases || [];
  if (!databases.length) {
    throw new Error("wrangler.jsonc has no d1_databases entry");
  }
  databases[0].database_id = databaseId;
}

fs.writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
NODE
}

# Write KEY=VALUE pairs into wrangler.jsonc's vars block, preserving everything else.
set_worker_vars() {
  node - "$@" <<'NODE'
const fs = require("fs");
const path = "wrangler.jsonc";
const config = JSON.parse(fs.readFileSync(path, "utf8"));
config.vars = config.vars || {};
for (const pair of process.argv.slice(2)) {
  const idx = pair.indexOf("=");
  if (idx === -1) continue;
  config.vars[pair.slice(0, idx)] = pair.slice(idx + 1);
}
fs.writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
NODE
}

# These tuning vars (expiration, rate limits, auth-ban thresholds, legacy routes)
# have sensible defaults and rarely change, so we don't ask about each one every
# deploy. A single y/N (default N) prompt offers to review and edit them; saying no
# keeps whatever is already in wrangler.jsonc.
prompt_advanced_worker_vars() {
  echo
  if ! confirm "See and edit advanced Worker tuning (expiration, rate limits, auth bans, legacy routes)?"; then
    echo "Keeping current advanced Worker vars from $WRANGLER_CONFIG (rate limits per s/m/d: $(json_value 'config.vars && config.vars.RATE_LIMIT_MAX_PER_SECOND')/$(json_value 'config.vars && config.vars.RATE_LIMIT_MAX_PER_MINUTE')/$(json_value 'config.vars && config.vars.RATE_LIMIT_MAX_PER_DAY'))."
    return
  fi
  local default_expiration_hours rate_per_second rate_per_minute rate_per_day
  local auth_failure_limit auth_failure_window admin_ban teacher_ban student_ban legacy_routes
  default_expiration_hours="$(prompt_with_default "DEFAULT_EXPIRATION_HOURS" "$(json_value 'config.vars && config.vars.DEFAULT_EXPIRATION_HOURS')")"
  rate_per_second="$(prompt_with_default "RATE_LIMIT_MAX_PER_SECOND" "$(json_value 'config.vars && config.vars.RATE_LIMIT_MAX_PER_SECOND')")"
  rate_per_minute="$(prompt_with_default "RATE_LIMIT_MAX_PER_MINUTE" "$(json_value 'config.vars && config.vars.RATE_LIMIT_MAX_PER_MINUTE')")"
  rate_per_day="$(prompt_with_default "RATE_LIMIT_MAX_PER_DAY" "$(json_value 'config.vars && config.vars.RATE_LIMIT_MAX_PER_DAY')")"
  auth_failure_limit="$(prompt_with_default "AUTH_FAILURE_LIMIT" "$(json_value 'config.vars && config.vars.AUTH_FAILURE_LIMIT')")"
  auth_failure_window="$(prompt_with_default "AUTH_FAILURE_WINDOW_MINUTES" "$(json_value 'config.vars && config.vars.AUTH_FAILURE_WINDOW_MINUTES')")"
  admin_ban="$(prompt_with_default "AUTH_ADMIN_BAN_DAYS" "$(json_value 'config.vars && config.vars.AUTH_ADMIN_BAN_DAYS')")"
  teacher_ban="$(prompt_with_default "AUTH_TEACHER_BAN_MINUTES" "$(json_value 'config.vars && config.vars.AUTH_TEACHER_BAN_MINUTES')")"
  student_ban="$(prompt_with_default "AUTH_STUDENT_BAN_MINUTES" "$(json_value 'config.vars && config.vars.AUTH_STUDENT_BAN_MINUTES')")"
  legacy_routes="$(prompt_with_default "LEGACY_ROUTES_ENABLED (true/false)" "$(json_value 'config.vars && config.vars.LEGACY_ROUTES_ENABLED')")"
  set_worker_vars \
    "DEFAULT_EXPIRATION_HOURS=$default_expiration_hours" \
    "RATE_LIMIT_MAX_PER_SECOND=$rate_per_second" \
    "RATE_LIMIT_MAX_PER_MINUTE=$rate_per_minute" \
    "RATE_LIMIT_MAX_PER_DAY=$rate_per_day" \
    "AUTH_FAILURE_LIMIT=$auth_failure_limit" \
    "AUTH_FAILURE_WINDOW_MINUTES=$auth_failure_window" \
    "AUTH_ADMIN_BAN_DAYS=$admin_ban" \
    "AUTH_TEACHER_BAN_MINUTES=$teacher_ban" \
    "AUTH_STUDENT_BAN_MINUTES=$student_ban" \
    "LEGACY_ROUTES_ENABLED=$legacy_routes"
  echo "Updated advanced Worker vars in $WRANGLER_CONFIG."
}

extract_database_id() {
  local file="$1"
  node - "$file" <<'NODE'
const fs = require("fs");
const text = fs.readFileSync(process.argv[2], "utf8");
const explicit = text.match(/database_id\s*[:=]\s*["']?([0-9a-fA-F-]{36})["']?/);
const anyUuid = text.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
console.log((explicit && explicit[1]) || (anyUuid && anyUuid[0]) || "");
NODE
}

worker_exists() {
  local worker_name="$1"
  [ -n "$worker_name" ] || return 1
  wrangler deployments list --name "$worker_name" >/dev/null 2>&1
}

database_exists() {
  local database_name="$1"
  [ -n "$database_name" ] || return 1
  wrangler d1 list 2>/dev/null | grep -Fq "$database_name"
}

# Resolve the real Cloudflare database id for a name by querying the account with
# `wrangler d1 list --json`. The local wrangler.jsonc binding can still hold the
# REPLACE_WITH_D1_DATABASE_ID placeholder, which makes a name-based delete fail with
# "Invalid uuid"; resolving the id from Cloudflare avoids that. Prints the id on
# stdout (or "" if none). If several databases share the name, a menu is shown on
# the terminal and the chosen id is printed.
resolve_remote_database_id() {
  local database_name="$1"
  [ -n "$database_name" ] || { printf ''; return 0; }

  local list_file
  list_file="$(mktemp)"
  if ! wrangler d1 list --json >"$list_file" 2>/dev/null; then
    rm -f "$list_file"
    printf ''
    return 0
  fi

  local matches
  matches="$(node - "$list_file" "$database_name" <<'NODE'
const fs = require("fs");
let data;
try {
  data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
} catch (err) {
  process.exit(0);
}
const target = process.argv[3];
const list = Array.isArray(data) ? data : (data.result || data.databases || []);
for (const db of list) {
  const name = db.name || db.database_name;
  const id = db.uuid || db.id || db.database_id;
  if (name === target && id) console.log(`${id}\t${name}`);
}
NODE
)" || true
  rm -f "$list_file"

  [ -n "$matches" ] || { printf ''; return 0; }

  local ids=()
  local names=()
  while IFS=$'\t' read -r id name; do
    [ -n "$id" ] || continue
    ids+=("$id")
    names+=("$name")
  done <<< "$matches"

  if [ "${#ids[@]}" -eq 1 ]; then
    printf '%s' "${ids[0]}"
    return 0
  fi

  echo >&2
  echo "Multiple D1 databases named '$database_name' were found:" >&2
  local i
  for i in "${!ids[@]}"; do
    echo "  $((i + 1))) ${names[$i]} (${ids[$i]})" >&2
  done
  local choice
  while true; do
    printf '%s' "Select which D1 database to delete [1]: " >&2
    read -r choice
    choice="${choice:-1}"
    if [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le "${#ids[@]}" ]; then
      break
    fi
    echo "Enter a number between 1 and ${#ids[@]}." >&2
  done
  printf '%s' "${ids[$((choice - 1))]}"
}

# Write a database id into the first d1_databases entry of wrangler.jsonc, so a
# subsequent name-based delete resolves the binding to the real id instead of the
# placeholder.
set_database_id_in_config() {
  local database_id="$1"
  [ -n "$database_id" ] || return 0
  node - "$database_id" <<'NODE'
const fs = require("fs");
const path = "wrangler.jsonc";
const [databaseId] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(path, "utf8"));
const databases = config.d1_databases || [];
if (databases.length) {
  databases[0].database_id = databaseId;
  fs.writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}
NODE
}

# Delete a remote D1 database by name, first pointing the wrangler.jsonc binding at
# the resolved real id so wrangler does not try to use the placeholder. Uses the
# only confirmation-skipping flag wrangler 4.x supports (-y/--skip-confirmation).
delete_remote_database() {
  local database_name="$1"
  local resolved_id="$2"
  [ -n "$database_name" ] || return 1
  if [ -n "$resolved_id" ]; then
    set_database_id_in_config "$resolved_id"
  fi
  wrangler d1 delete "$database_name" -y >&2
}

# List every D1 database in the account (wrangler d1 list --json) and let the user
# pick one from a menu, with a final "Other" choice to type an id manually. Prints
# the chosen id on stdout (or "" if none was chosen). Used when the user declines to
# create a new database so they can attach an existing one without hunting for its id.
choose_existing_database_id() {
  local list_file
  list_file="$(mktemp)"
  local entries=""
  if wrangler d1 list --json >"$list_file" 2>/dev/null; then
    entries="$(node - "$list_file" <<'NODE'
const fs = require("fs");
let data;
try {
  data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
} catch (err) {
  process.exit(0);
}
const list = Array.isArray(data) ? data : (data.result || data.databases || []);
for (const db of list) {
  const name = db.name || db.database_name;
  const id = db.uuid || db.id || db.database_id;
  if (id) console.log(`${id}\t${name || "(unnamed)"}`);
}
NODE
)" || true
  fi
  rm -f "$list_file"

  local ids=()
  local names=()
  if [ -n "$entries" ]; then
    while IFS=$'\t' read -r id name; do
      [ -n "$id" ] || continue
      ids+=("$id")
      names+=("$name")
    done <<< "$entries"
  fi

  echo >&2
  local i
  if [ "${#ids[@]}" -gt 0 ]; then
    echo "Existing D1 databases in your Cloudflare account:" >&2
    for i in "${!ids[@]}"; do
      echo "  $((i + 1))) ${names[$i]} (${ids[$i]})" >&2
    done
  else
    echo "No existing D1 databases were found (or the account could not be listed)." >&2
  fi
  local other_choice=$(( ${#ids[@]} + 1 ))
  echo "  ${other_choice}) Other (enter a database id manually)" >&2

  local choice
  while true; do
    printf '%s' "Select a D1 database [1]: " >&2
    read -r choice
    choice="${choice:-1}"
    if [[ "$choice" =~ ^[0-9]+$ ]]; then
      if [ "${#ids[@]}" -gt 0 ] && [ "$choice" -ge 1 ] && [ "$choice" -le "${#ids[@]}" ]; then
        printf '%s' "${ids[$((choice - 1))]}"
        return 0
      fi
      if [ "$choice" -eq "$other_choice" ]; then
        prompt_with_default "Existing D1 database id" ""
        return 0
      fi
    fi
    echo "Enter a number from the menu." >&2
  done
}

# On re-deploy, offer to destroy and recreate the existing Worker and/or D1
# database. Echoes the (possibly cleared) database id on stdout so the caller can
# fall through to the normal "create database" path when the DB was destroyed.
prompt_recreate_resources() {
  local worker_name="$1"
  local database_name="$2"
  local database_id="$3"

  if worker_exists "$worker_name"; then
    echo "Worker '$worker_name' already exists." >&2
    if confirm "Destroy and recreate the Worker?"; then
      # `wrangler delete` takes the worker name as a positional and has no
      # skip-confirmation flag, so it may prompt; --force lets it proceed even if
      # other Workers depend on this one.
      if wrangler delete "$worker_name" --force >&2; then
        echo "Worker deleted; it will be recreated by the deploy step." >&2
      else
        echo "Worker delete failed; the deploy step will redeploy over it." >&2
      fi
    fi
  fi

  if database_exists "$database_name"; then
    echo "D1 database '$database_name' already exists." >&2
    echo "Recreating it DELETES ALL class instances and drawing data." >&2
    if confirm "Destroy and recreate the D1 database?"; then
      local resolved_id
      resolved_id="$(resolve_remote_database_id "$database_name")"
      if [ -z "$resolved_id" ] && [ -n "$database_id" ] \
          && [ "$database_id" != "REPLACE_WITH_D1_DATABASE_ID" ]; then
        resolved_id="$database_id"
      fi
      if delete_remote_database "$database_name" "$resolved_id"; then
        database_id=""
        echo "D1 database deleted; a new one will be created below." >&2
      else
        echo "D1 database delete failed; keeping existing database." >&2
      fi
    fi
  fi

  printf '%s' "$database_id"
}

destroy_cloudflare_resources() {
  local worker_name="$1"
  local database_name="$2"
  local database_id="$3"
  local typed

  echo
  echo "Destroy mode will delete Cloudflare resources named in $WRANGLER_CONFIG."
  echo "Worker: ${worker_name:-missing}"
  echo "D1 database: ${database_name:-missing}"
  if [ -n "$database_id" ] && [ "$database_id" != "REPLACE_WITH_D1_DATABASE_ID" ]; then
    echo "D1 database id: $database_id"
  fi
  echo
  echo "This removes the deployed Worker and deletes the D1 database data."
  read -r -p "Type DESTROY to continue: " typed
  if [ "$typed" != "DESTROY" ]; then
    echo "Destroy cancelled."
    exit 0
  fi

  if [ -n "$worker_name" ]; then
    echo
    echo "Deleting Worker '$worker_name'."
    # `wrangler delete` takes the worker name as a positional; --force lets it
    # proceed even if other Workers depend on this one.
    if ! wrangler delete "$worker_name" --force; then
      echo "Worker delete failed." >&2
    fi
  fi

  if [ -n "$database_name" ]; then
    echo
    echo "Deleting D1 database '$database_name'."
    local resolved_id
    resolved_id="$(resolve_remote_database_id "$database_name")"
    if [ -z "$resolved_id" ] && [ -n "$database_id" ] \
        && [ "$database_id" != "REPLACE_WITH_D1_DATABASE_ID" ]; then
      resolved_id="$database_id"
    fi
    if delete_remote_database "$database_name" "$resolved_id"; then
      echo "D1 database '$database_name' deleted."
    else
      echo "D1 database delete failed." >&2
    fi
  fi

  echo
  echo "Cloudflare destroy flow complete."
}

require_command node
require_command npm

if [ ! -f "$WRANGLER_CONFIG" ]; then
  echo "Missing $WRANGLER_CONFIG. Run this script from PixelPandemonium_Server." >&2
  exit 1
fi

if [ "$REPORT_ONLY" -eq 0 ] && [ ! -d node_modules ]; then
  echo "node_modules is missing."
  if confirm "Run npm install now?"; then
    npm install
  else
    echo "Install dependencies before deploying: npm install" >&2
    exit 1
  fi
fi

if [ "$REPORT_ONLY" -eq 1 ]; then
  echo "Report-only mode: logging in to read the current configuration; nothing will be deployed or changed."
else
  echo "This script will configure Cloudflare, apply remote D1 migrations, and deploy the Worker."
  echo "It will update $WRANGLER_CONFIG, but it will not write secret values to repo files."
fi

ensure_cloudflare_login

select_cloudflare_account

current_worker_name="$(json_value 'config.name')"
current_client_base_url="$(json_value 'config.vars && config.vars.CLIENT_BASE_URL')"
current_allowed_origins="$(json_value 'config.vars && config.vars.ALLOWED_ORIGINS')"
current_database_name="$(json_value 'config.d1_databases && config.d1_databases[0] && config.d1_databases[0].database_name')"
if [ -z "$current_database_name" ]; then
  current_database_name="pixel-pandemonium"
fi
current_database_id="$(json_value 'config.d1_databases && config.d1_databases[0] && config.d1_databases[0].database_id')"

if [ "$REPORT_ONLY" -eq 1 ]; then
  report_admin_password="$(cache_get ADMIN_PASSWORD)"
  report_teacher_key="$(cache_get DEFAULT_TEACHER_KEY)"
  echo
  echo "================ Cloudflare report (report-only) ================"
  echo "Worker name:         $current_worker_name"
  echo "--- Worker vars (all values from $WRANGLER_CONFIG) ---"
  print_worker_vars
  echo "--- D1 database ---"
  echo "  D1 database name:  $current_database_name"
  echo "  D1 database id:    $current_database_id"
  echo "--- secrets (cached locally in $SECRETS_CACHE, gitignored) ---"
  if [ -n "$report_admin_password$report_teacher_key" ]; then
    echo "ADMIN_PASSWORD:      $report_admin_password"
    echo "DEFAULT_TEACHER_KEY: $report_teacher_key"
    echo "(Treat this terminal output as sensitive.)"
  else
    echo "ADMIN_PASSWORD / DEFAULT_TEACHER_KEY: no local cache."
    echo "(Cloudflare secrets cannot be read back from the API; run a full deploy and set them once to populate $SECRETS_CACHE.)"
  fi
  echo "================================================================"
  exit 0
fi

if [ "$DESTROY" -eq 1 ]; then
  destroy_cloudflare_resources "$current_worker_name" "$current_database_name" "$current_database_id"
  exit 0
fi

echo
echo "Checking for existing Cloudflare resources..."
current_database_id="$(prompt_recreate_resources "$current_worker_name" "$current_database_name" "$current_database_id")"

echo
client_base_url="$(prompt_with_default "Public client base URL" "$current_client_base_url")"
allowed_origins="$(prompt_with_default "Comma-separated allowed browser origins" "$current_allowed_origins")"

if [ -z "$client_base_url" ] || [ -z "$allowed_origins" ]; then
  echo "Client base URL and allowed origins are required." >&2
  exit 1
fi

prompt_advanced_worker_vars

database_id="$current_database_id"
# If wrangler.jsonc has a real database id but the database no longer exists in
# Cloudflare (e.g. it was deleted), clear the id so the creation flow below
# handles it instead of failing at migration time with error 7404.
if [ -n "$database_id" ] && [ "$database_id" != "REPLACE_WITH_D1_DATABASE_ID" ] \
    && ! database_exists "$current_database_name"; then
  echo
  echo "Warning: $WRANGLER_CONFIG has database id '$database_id'" >&2
  echo "but database '$current_database_name' was not found in your Cloudflare account." >&2
  echo "The database may have been deleted. A new one will be created." >&2
  database_id=""
fi

if [ -z "$database_id" ] || [ "$database_id" = "REPLACE_WITH_D1_DATABASE_ID" ]; then
  echo
  echo "$WRANGLER_CONFIG does not have a D1 database id."
  if confirm "Create Cloudflare D1 database '$current_database_name' now?"; then
    create_output="$(mktemp)"
    if wrangler d1 create "$current_database_name" 2>&1 | tee "$create_output"; then
      database_id="$(extract_database_id "$create_output")"
      rm -f "$create_output"
    else
      rm -f "$create_output"
      echo "D1 database creation failed." >&2
      exit 1
    fi
    if [ -z "$database_id" ]; then
      echo "Could not find a database id in Wrangler output." >&2
      echo "Copy the database id into $WRANGLER_CONFIG and run this script again." >&2
      exit 1
    fi
  else
    database_id="$(choose_existing_database_id)"
    if [ -z "$database_id" ]; then
      echo "D1 database id is required." >&2
      exit 1
    fi
  fi
else
  echo
  echo "Using existing D1 database id from $WRANGLER_CONFIG."
fi

update_wrangler_config "$client_base_url" "$allowed_origins" "$database_id"
echo "Updated $WRANGLER_CONFIG with Worker vars and D1 database id."

echo
echo "Cloudflare Worker secrets (printed in the summary below; cached in $SECRETS_CACHE, gitignored)."
admin_password="$(cache_get ADMIN_PASSWORD)"
default_teacher_key="$(cache_get DEFAULT_TEACHER_KEY)"
secrets_set=0
if confirm "Set/change ADMIN_PASSWORD and DEFAULT_TEACHER_KEY now? (No keeps the existing or default values)"; then
  admin_password="$(read_secret "ADMIN_PASSWORD (teacher dashboard / admin / data export)" "$admin_password")"
  default_teacher_key="$(read_secret "DEFAULT_TEACHER_KEY (global teacher portal key)" "$default_teacher_key")"
  printf '%s' "$admin_password" | wrangler secret put ADMIN_PASSWORD
  printf '%s' "$default_teacher_key" | wrangler secret put DEFAULT_TEACHER_KEY
  umask 077
  {
    printf 'ADMIN_PASSWORD=%s\n' "$admin_password"
    printf 'DEFAULT_TEACHER_KEY=%s\n' "$default_teacher_key"
  } > "$SECRETS_CACHE"
  chmod 600 "$SECRETS_CACHE"
  secrets_set=1
else
  echo "Skipping secret setup; existing Cloudflare secrets are left unchanged."
  # If we have cached values from a previous run, still show them in the summary.
  [ -n "$admin_password$default_teacher_key" ] && secrets_set=1
fi

echo
echo "Applying remote D1 migrations."
npm run cloudflare:db:migrate:remote

echo
echo "Deploying Cloudflare Worker."
deploy_output="$(mktemp)"
if npm run cloudflare:deploy 2>&1 | tee "$deploy_output"; then
  worker_url="$(node - "$deploy_output" <<'NODE'
const fs = require("fs");
const text = fs.readFileSync(process.argv[2], "utf8");
const matches = text.match(/https:\/\/[^\s]+\.workers\.dev[^\s]*/g) || [];
console.log(matches[matches.length - 1] || "");
NODE
)"
  rm -f "$deploy_output"
else
  rm -f "$deploy_output"
  echo "Cloudflare Worker deploy failed." >&2
  exit 1
fi

echo
echo "Cloudflare deployment complete."
echo
echo "================ Deployment summary ================"
if [ -n "$worker_url" ]; then
  echo "Worker URL:          $worker_url"
else
  echo "Worker URL:          (not detected in deploy output)"
fi
echo "Worker name:         $current_worker_name"
echo "--- Worker vars (all non-secret values from $WRANGLER_CONFIG) ---"
print_worker_vars
echo "--- D1 database ---"
echo "  D1 database name:  $current_database_name"
echo "  D1 database id:    $database_id"
echo "--- secrets (stored as Cloudflare Worker secrets; cached locally in $SECRETS_CACHE, gitignored) ---"
if [ "$secrets_set" -eq 1 ]; then
  echo "ADMIN_PASSWORD:      $admin_password"
  echo "DEFAULT_TEACHER_KEY: $default_teacher_key"
  echo "(Treat this terminal output as sensitive.)"
else
  echo "ADMIN_PASSWORD / DEFAULT_TEACHER_KEY: not set this run and no local cache."
  echo "(Cloudflare secrets cannot be read back from the API; set them once to populate the local cache, then they print on every deploy.)"
fi
echo "==================================================="
unset admin_password
unset default_teacher_key
echo
echo "Update the static client config so server_url and realtime_url point to the Worker URL or custom Worker domain."
