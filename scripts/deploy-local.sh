#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

START=1
REPORT_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --no-start)
      START=0
      ;;
    --report-only)
      REPORT_ONLY=1
      ;;
    -h|--help)
      cat <<'USAGE'
Usage: ./scripts/deploy-local.sh [--no-start] [--report-only]

Configures and runs the local (Node + Faye) server:
  1. Checks local tools and installs npm dependencies if needed.
  2. Prompts for the default admin password, global teacher key, and the allowed
     browser origins (CORS). Advanced tuning (port, rate limits,
     auth-ban thresholds) is offered behind a single y/N (default N) menu.
  3. Writes them to .env (which is gitignored, never committed).
  4. Prints a summary including the local URL and the values entered.
  5. Starts the server (unless --no-start is passed).

With --report-only the script does no configuration and does not write .env or
start the server: it reads the current values from .env (or the defaults) and
prints the same summary (including secrets) to the screen, then quits.

The same protections as the Cloudflare Worker apply locally: per-IP request rate
limiting, temporary auth banning on repeated credential failures, and realtime
(Faye) per-IP message rate limiting.
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

ENV_FILE=".env"

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
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

# Reads a key's current value from an existing .env, for use as a prompt default.
env_default() {
  local key="$1"
  local fallback="$2"
  local line
  if [ -f "$ENV_FILE" ]; then
    line="$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1 || true)"
    if [ -n "$line" ]; then
      printf '%s' "${line#*=}"
      return 0
    fi
  fi
  printf '%s' "$fallback"
}

prompt_with_default() {
  local prompt="$1"
  local default="$2"
  local value
  printf '%s' "$prompt [$default]: " >&2
  read -r value
  printf '%s' "${value:-$default}"
}

read_secret() {
  local prompt="$1"
  local default="$2"
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

DEFAULT_ALLOWED_ORIGINS="http://localhost:4000,http://127.0.0.1:4000,https://billmongan.com,https://www.billmongan.com,https://billjr99.github.io"

# Print the local server summary (URL, secrets, protections, and the full effective
# config). Reads the ADMIN_PASSWORD/.../RATE_LIMIT_* globals set by the caller.
print_local_summary() {
  echo "================ Local server summary ================"
  echo "Local URL:           http://localhost:$PORT"
  echo "ALLOWED_ORIGINS:     $ALLOWED_ORIGINS"
  echo "ADMIN_PASSWORD:      $ADMIN_PASSWORD"
  echo "DEFAULT_TEACHER_KEY: $DEFAULT_TEACHER_KEY"
  echo "AUTH_FAILURE_LIMIT / WINDOW_MINUTES: $AUTH_FAILURE_LIMIT / $AUTH_FAILURE_WINDOW_MINUTES"
  echo "AUTH bans (admin days / teacher min / student min): $AUTH_ADMIN_BAN_DAYS / $AUTH_TEACHER_BAN_MINUTES / $AUTH_STUDENT_BAN_MINUTES"
  echo "RATE_LIMIT per second / minute / day: $RATE_LIMIT_MAX_PER_SECOND / $RATE_LIMIT_MAX_PER_MINUTE / $RATE_LIMIT_MAX_PER_DAY"
  echo "--- full effective config (config.yaml merged with .env) ---"
  node -e "
const { loadConfig } = require('./src/config.js');
const c = loadConfig();
for (const key of Object.keys(c)) {
  const v = c[key];
  console.log('  ' + key + ': ' + (typeof v === 'object' ? JSON.stringify(v) : v));
}
"
  echo "(Values are stored in $ENV_FILE, which is gitignored. Treat this output as sensitive.)"
  echo "====================================================="
}

require_command node
require_command npm

# Report-only: do no configuration, do not write .env, do not start the server.
# Read the current values from .env (or defaults) and print the summary + secrets.
if [ "$REPORT_ONLY" -eq 1 ]; then
  ADMIN_PASSWORD="$(env_default ADMIN_PASSWORD "")"
  DEFAULT_TEACHER_KEY="$(env_default DEFAULT_TEACHER_KEY "")"
  ALLOWED_ORIGINS="$(env_default ALLOWED_ORIGINS "$DEFAULT_ALLOWED_ORIGINS")"
  PORT="$(env_default PORT 8000)"
  AUTH_FAILURE_LIMIT="$(env_default AUTH_FAILURE_LIMIT 5)"
  AUTH_FAILURE_WINDOW_MINUTES="$(env_default AUTH_FAILURE_WINDOW_MINUTES 10)"
  AUTH_ADMIN_BAN_DAYS="$(env_default AUTH_ADMIN_BAN_DAYS 1)"
  AUTH_TEACHER_BAN_MINUTES="$(env_default AUTH_TEACHER_BAN_MINUTES 10)"
  AUTH_STUDENT_BAN_MINUTES="$(env_default AUTH_STUDENT_BAN_MINUTES 10)"
  RATE_LIMIT_MAX_PER_SECOND="$(env_default RATE_LIMIT_MAX_PER_SECOND 10)"
  RATE_LIMIT_MAX_PER_MINUTE="$(env_default RATE_LIMIT_MAX_PER_MINUTE 60)"
  RATE_LIMIT_MAX_PER_DAY="$(env_default RATE_LIMIT_MAX_PER_DAY 10000)"
  echo
  echo "Report-only mode: no configuration written and the server was not started."
  echo "Showing current values from $ENV_FILE (or defaults)."
  echo
  print_local_summary
  exit 0
fi

if [ ! -d node_modules ]; then
  echo "node_modules is missing."
  if confirm "Run npm install now?"; then
    npm install
  else
    echo "Install dependencies before running: npm install" >&2
    exit 1
  fi
fi

echo "This configures the local server and writes $ENV_FILE (gitignored)."
echo

ADMIN_PASSWORD="$(read_secret "ADMIN_PASSWORD (teacher dashboard / admin / data export)" "$(env_default ADMIN_PASSWORD "")")"
DEFAULT_TEACHER_KEY="$(read_secret "DEFAULT_TEACHER_KEY (global teacher portal key)" "$(env_default DEFAULT_TEACHER_KEY "")")"

echo
echo "Allowed browser origins (CORS). Comma-separated; press Enter to accept the default."
echo "Include every origin the client is served from. For a custom-domain GitHub Pages"
echo "site, list both the custom domain (with and without www) and the *.github.io host."
ALLOWED_ORIGINS="$(prompt_with_default "ALLOWED_ORIGINS" "$(env_default ALLOWED_ORIGINS "$DEFAULT_ALLOWED_ORIGINS")")"

echo
# Advanced tuning (port, rate limits, auth-ban thresholds) has sensible defaults
# and rarely changes, so it is hidden behind a single y/N (default N) prompt instead
# of asking about each value every run. Saying no keeps the current .env / default
# values. Start from the existing .env value (or the default) for each.
PORT="$(env_default PORT 8000)"
AUTH_FAILURE_LIMIT="$(env_default AUTH_FAILURE_LIMIT 5)"
AUTH_FAILURE_WINDOW_MINUTES="$(env_default AUTH_FAILURE_WINDOW_MINUTES 10)"
AUTH_ADMIN_BAN_DAYS="$(env_default AUTH_ADMIN_BAN_DAYS 1)"
AUTH_TEACHER_BAN_MINUTES="$(env_default AUTH_TEACHER_BAN_MINUTES 10)"
AUTH_STUDENT_BAN_MINUTES="$(env_default AUTH_STUDENT_BAN_MINUTES 10)"
RATE_LIMIT_MAX_PER_SECOND="$(env_default RATE_LIMIT_MAX_PER_SECOND 10)"
RATE_LIMIT_MAX_PER_MINUTE="$(env_default RATE_LIMIT_MAX_PER_MINUTE 60)"
RATE_LIMIT_MAX_PER_DAY="$(env_default RATE_LIMIT_MAX_PER_DAY 10000)"

if confirm "See and edit advanced tuning (port, rate limits, auth-ban thresholds)?"; then
  PORT="$(prompt_with_default "PORT" "$PORT")"
  AUTH_FAILURE_LIMIT="$(prompt_with_default "AUTH_FAILURE_LIMIT (failures before a temporary ban)" "$AUTH_FAILURE_LIMIT")"
  AUTH_FAILURE_WINDOW_MINUTES="$(prompt_with_default "AUTH_FAILURE_WINDOW_MINUTES (window for counting failures)" "$AUTH_FAILURE_WINDOW_MINUTES")"
  AUTH_ADMIN_BAN_DAYS="$(prompt_with_default "AUTH_ADMIN_BAN_DAYS" "$AUTH_ADMIN_BAN_DAYS")"
  AUTH_TEACHER_BAN_MINUTES="$(prompt_with_default "AUTH_TEACHER_BAN_MINUTES" "$AUTH_TEACHER_BAN_MINUTES")"
  AUTH_STUDENT_BAN_MINUTES="$(prompt_with_default "AUTH_STUDENT_BAN_MINUTES" "$AUTH_STUDENT_BAN_MINUTES")"
  RATE_LIMIT_MAX_PER_SECOND="$(prompt_with_default "RATE_LIMIT_MAX_PER_SECOND" "$RATE_LIMIT_MAX_PER_SECOND")"
  RATE_LIMIT_MAX_PER_MINUTE="$(prompt_with_default "RATE_LIMIT_MAX_PER_MINUTE" "$RATE_LIMIT_MAX_PER_MINUTE")"
  RATE_LIMIT_MAX_PER_DAY="$(prompt_with_default "RATE_LIMIT_MAX_PER_DAY" "$RATE_LIMIT_MAX_PER_DAY")"
else
  echo "Keeping current tuning (rate limits per s/m/d: $RATE_LIMIT_MAX_PER_SECOND/$RATE_LIMIT_MAX_PER_MINUTE/$RATE_LIMIT_MAX_PER_DAY; PORT $PORT)."
fi

umask 077
cat > "$ENV_FILE" <<ENV
ADMIN_PASSWORD=$ADMIN_PASSWORD
DEFAULT_TEACHER_KEY=$DEFAULT_TEACHER_KEY
ALLOWED_ORIGINS=$ALLOWED_ORIGINS
PORT=$PORT
AUTH_FAILURE_LIMIT=$AUTH_FAILURE_LIMIT
AUTH_FAILURE_WINDOW_MINUTES=$AUTH_FAILURE_WINDOW_MINUTES
AUTH_ADMIN_BAN_DAYS=$AUTH_ADMIN_BAN_DAYS
AUTH_TEACHER_BAN_MINUTES=$AUTH_TEACHER_BAN_MINUTES
AUTH_STUDENT_BAN_MINUTES=$AUTH_STUDENT_BAN_MINUTES
RATE_LIMIT_MAX_PER_SECOND=$RATE_LIMIT_MAX_PER_SECOND
RATE_LIMIT_MAX_PER_MINUTE=$RATE_LIMIT_MAX_PER_MINUTE
RATE_LIMIT_MAX_PER_DAY=$RATE_LIMIT_MAX_PER_DAY
ENV
chmod 600 "$ENV_FILE"

echo
echo "Wrote $ENV_FILE."
echo
print_local_summary
echo

if [ "$START" -eq 1 ]; then
  echo "Starting the server (Ctrl+C to stop)..."
  exec npm start
else
  echo "Skipping start (--no-start). Run 'npm start' when ready."
fi
