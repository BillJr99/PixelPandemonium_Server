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
     Worker secrets.
  7. Applies remote D1 migrations.
  8. Deploys the Worker.
  9. Prints the Worker URL and the resolved environment values (including the
     secret values entered this run).

With --destroy, the script logs in, asks for explicit confirmation, then deletes
the Worker and D1 database named in wrangler.jsonc instead of deploying.

The script does not write secret values to repo files. It DOES print secret
values to the terminal in the final summary, so run it somewhere private.
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
  local first
  local second
  while true; do
    printf '%s' "$prompt: " >&2
    read -r -s first
    echo >&2
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

wrangler() {
  if [ -x "node_modules/.bin/wrangler" ]; then
    node_modules/.bin/wrangler "$@"
  else
    npx wrangler "$@"
  fi
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
      if ! wrangler delete "$worker_name" --force >&2; then
        wrangler delete --name "$worker_name" --force >&2 || true
      fi
      echo "Worker deleted; it will be recreated by the deploy step." >&2
    fi
  fi

  if database_exists "$database_name"; then
    echo "D1 database '$database_name' already exists." >&2
    echo "Recreating it DELETES ALL class instances and drawing data." >&2
    if confirm "Destroy and recreate the D1 database?"; then
      if wrangler d1 delete "$database_name" --yes >&2 \
        || wrangler d1 delete "$database_name" --force >&2 \
        || wrangler d1 delete "$database_name" --skip-confirmation >&2 \
        || wrangler d1 delete "$database_name" >&2; then
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
    if ! wrangler delete "$worker_name" --force; then
      echo "Direct Worker delete failed; trying named delete form."
      wrangler delete --name "$worker_name" --force
    fi
  fi

  if [ -n "$database_name" ]; then
    echo
    echo "Deleting D1 database '$database_name'."
    if wrangler d1 delete "$database_name" --yes; then
      :
    elif wrangler d1 delete "$database_name" --force; then
      :
    elif wrangler d1 delete "$database_name" --skip-confirmation; then
      :
    else
      echo "Automatic D1 delete flags were not accepted; falling back to Wrangler's interactive prompt."
      wrangler d1 delete "$database_name"
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
echo "Cloudflare Worker secrets are required for production."
admin_password=""
default_teacher_key=""
download_token=""
secrets_set=0
if confirm "Set or overwrite ADMIN_PASSWORD, DEFAULT_TEACHER_KEY and DOWNLOAD_TOKEN now?"; then
  admin_password="$(read_secret "ADMIN_PASSWORD (teacher dashboard / admin)")"
  default_teacher_key="$(read_secret "DEFAULT_TEACHER_KEY (global teacher portal key)")"
  download_token="$(read_secret "DOWNLOAD_TOKEN")"
  printf '%s' "$admin_password" | wrangler secret put ADMIN_PASSWORD
  printf '%s' "$default_teacher_key" | wrangler secret put DEFAULT_TEACHER_KEY
  printf '%s' "$download_token" | wrangler secret put DOWNLOAD_TOKEN
  secrets_set=1
else
  echo "Skipping secret setup. Deployment may fail or use existing configured secrets."
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
echo "CLIENT_BASE_URL:     $(json_value 'config.vars && config.vars.CLIENT_BASE_URL')"
echo "ALLOWED_ORIGINS:     $(json_value 'config.vars && config.vars.ALLOWED_ORIGINS')"
echo "DEFAULT_EXPIRATION_HOURS: $(json_value 'config.vars && config.vars.DEFAULT_EXPIRATION_HOURS')"
echo "D1 database name:    $current_database_name"
echo "D1 database id:      $database_id"
echo "--- secrets (stored as Cloudflare Worker secrets, not in repo) ---"
if [ "$secrets_set" -eq 1 ]; then
  echo "ADMIN_PASSWORD:      $admin_password"
  echo "DEFAULT_TEACHER_KEY: $default_teacher_key"
  echo "DOWNLOAD_TOKEN:      $download_token"
  echo "(These were set this run. Treat this terminal output as sensitive.)"
else
  echo "ADMIN_PASSWORD / DEFAULT_TEACHER_KEY / DOWNLOAD_TOKEN: unchanged this run"
  echo "(Secret values cannot be read back from Cloudflare; re-run and set them to view.)"
fi
echo "==================================================="
unset admin_password
unset default_teacher_key
unset download_token
echo
echo "Update the static client config so server_url and realtime_url point to the Worker URL or custom Worker domain."
