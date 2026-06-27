#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

SKIP_LOGIN=0
DESTROY=0

for arg in "$@"; do
  case "$arg" in
    --skip-login)
      SKIP_LOGIN=1
      ;;
    --destroy)
      DESTROY=1
      ;;
    -h|--help)
      cat <<'USAGE'
Usage: ./scripts/deploy-cloudflare.sh [--skip-login] [--destroy]

Guides a Cloudflare deployment:
  1. Checks local tools and installs npm dependencies if needed.
  2. Logs in to Cloudflare with Wrangler unless --skip-login is passed.
  3. If the Worker and/or D1 database already exist, prompts whether to destroy
     and recreate each before deploying.
  4. Prompts for Worker client URL and allowed origins.
  5. Creates/configures the D1 database if wrangler.jsonc has no database id.
  6. Sets ADMIN_PASSWORD, DEFAULT_TEACHER_KEY and DOWNLOAD_TOKEN as Cloudflare
     Worker secrets, and caches them in a gitignored .cloudflare-secrets.env so
     they can be shown on every deploy (press Enter to keep the cached value).
  7. Applies remote D1 migrations.
  8. Deploys the Worker.
  9. Prints the Worker URL and the resolved environment values, including the
     ADMIN_PASSWORD / DEFAULT_TEACHER_KEY / DOWNLOAD_TOKEN values.

With --destroy, the script logs in, asks for explicit confirmation, then deletes
the Worker and D1 database named in wrangler.jsonc instead of deploying.

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
# installation can be audited. Secrets (ADMIN_PASSWORD/DEFAULT_TEACHER_KEY/
# DOWNLOAD_TOKEN) are stored as Cloudflare secrets and removed from vars, so they
# never appear here; they are summarized separately below.
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
delete config.vars.DOWNLOAD_TOKEN;

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

if [ ! -d node_modules ]; then
  echo "node_modules is missing."
  if confirm "Run npm install now?"; then
    npm install
  else
    echo "Install dependencies before deploying: npm install" >&2
    exit 1
  fi
fi

echo "This script will configure Cloudflare, apply remote D1 migrations, and deploy the Worker."
echo "It will update $WRANGLER_CONFIG, but it will not write secret values to repo files."

if [ "$SKIP_LOGIN" -eq 0 ]; then
  echo
  echo "Opening Cloudflare login with Wrangler. Complete the browser login if prompted."
  wrangler login
else
  echo
  echo "Skipping Wrangler login because --skip-login was provided."
fi

select_cloudflare_account

current_worker_name="$(json_value 'config.name')"
current_client_base_url="$(json_value 'config.vars && config.vars.CLIENT_BASE_URL')"
current_allowed_origins="$(json_value 'config.vars && config.vars.ALLOWED_ORIGINS')"
current_database_name="$(json_value 'config.d1_databases && config.d1_databases[0] && config.d1_databases[0].database_name')"
if [ -z "$current_database_name" ]; then
  current_database_name="pixel-pandemonium"
fi
current_database_id="$(json_value 'config.d1_databases && config.d1_databases[0] && config.d1_databases[0].database_id')"

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
    database_id="$(prompt_with_default "Existing D1 database id" "")"
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
download_token="$(cache_get DOWNLOAD_TOKEN)"
secrets_set=0
if confirm "Set/keep ADMIN_PASSWORD, DEFAULT_TEACHER_KEY and DOWNLOAD_TOKEN now?"; then
  admin_password="$(read_secret "ADMIN_PASSWORD (teacher dashboard / admin)" "$admin_password")"
  default_teacher_key="$(read_secret "DEFAULT_TEACHER_KEY (global teacher portal key)" "$default_teacher_key")"
  download_token="$(read_secret "DOWNLOAD_TOKEN" "$download_token")"
  printf '%s' "$admin_password" | wrangler secret put ADMIN_PASSWORD
  printf '%s' "$default_teacher_key" | wrangler secret put DEFAULT_TEACHER_KEY
  printf '%s' "$download_token" | wrangler secret put DOWNLOAD_TOKEN
  umask 077
  {
    printf 'ADMIN_PASSWORD=%s\n' "$admin_password"
    printf 'DEFAULT_TEACHER_KEY=%s\n' "$default_teacher_key"
    printf 'DOWNLOAD_TOKEN=%s\n' "$download_token"
  } > "$SECRETS_CACHE"
  chmod 600 "$SECRETS_CACHE"
  secrets_set=1
else
  echo "Skipping secret setup; existing Cloudflare secrets are left unchanged."
  # If we have cached values from a previous run, still show them in the summary.
  [ -n "$admin_password$default_teacher_key$download_token" ] && secrets_set=1
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
  echo "DOWNLOAD_TOKEN:      $download_token"
  echo "(Treat this terminal output as sensitive.)"
else
  echo "ADMIN_PASSWORD / DEFAULT_TEACHER_KEY / DOWNLOAD_TOKEN: not set this run and no local cache."
  echo "(Cloudflare secrets cannot be read back from the API; set them once to populate the local cache, then they print on every deploy.)"
fi
echo "==================================================="
unset admin_password
unset default_teacher_key
unset download_token
echo
echo "Update the static client config so server_url and realtime_url point to the Worker URL or custom Worker domain."
