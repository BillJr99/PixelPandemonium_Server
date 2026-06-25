#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

START=1
for arg in "$@"; do
  case "$arg" in
    --no-start)
      START=0
      ;;
    -h|--help)
      cat <<'USAGE'
Usage: ./scripts/deploy-local.sh [--no-start]

Configures and runs the local (Node + Faye) server:
  1. Checks local tools and installs npm dependencies if needed.
  2. Prompts for the default admin password, global teacher key, download token,
     and the rate-limit / auth-ban protection settings.
  3. Writes them to .env (which is gitignored, never committed).
  4. Prints a summary including the local URL and the values entered.
  5. Starts the server (unless --no-start is passed).

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

require_command node
require_command npm

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

ADMIN_PASSWORD="$(read_secret "ADMIN_PASSWORD (teacher dashboard / admin)" "$(env_default ADMIN_PASSWORD "")")"
DEFAULT_TEACHER_KEY="$(read_secret "DEFAULT_TEACHER_KEY (global teacher portal key)" "$(env_default DEFAULT_TEACHER_KEY "")")"
DOWNLOAD_TOKEN="$(read_secret "DOWNLOAD_TOKEN" "$(env_default DOWNLOAD_TOKEN "")")"

echo
echo "Protection settings (press Enter to accept defaults):"
PORT="$(prompt_with_default "PORT" "$(env_default PORT 8000)")"
AUTH_FAILURE_LIMIT="$(prompt_with_default "AUTH_FAILURE_LIMIT (failures before a temporary ban)" "$(env_default AUTH_FAILURE_LIMIT 5)")"
AUTH_FAILURE_WINDOW_MINUTES="$(prompt_with_default "AUTH_FAILURE_WINDOW_MINUTES (window for counting failures)" "$(env_default AUTH_FAILURE_WINDOW_MINUTES 10)")"
AUTH_ADMIN_BAN_DAYS="$(prompt_with_default "AUTH_ADMIN_BAN_DAYS" "$(env_default AUTH_ADMIN_BAN_DAYS 1)")"
AUTH_TEACHER_BAN_MINUTES="$(prompt_with_default "AUTH_TEACHER_BAN_MINUTES" "$(env_default AUTH_TEACHER_BAN_MINUTES 10)")"
AUTH_STUDENT_BAN_MINUTES="$(prompt_with_default "AUTH_STUDENT_BAN_MINUTES" "$(env_default AUTH_STUDENT_BAN_MINUTES 10)")"
RATE_LIMIT_MAX_PER_SECOND="$(prompt_with_default "RATE_LIMIT_MAX_PER_SECOND" "$(env_default RATE_LIMIT_MAX_PER_SECOND 3)")"
RATE_LIMIT_MAX_PER_MINUTE="$(prompt_with_default "RATE_LIMIT_MAX_PER_MINUTE" "$(env_default RATE_LIMIT_MAX_PER_MINUTE 20)")"
RATE_LIMIT_MAX_PER_DAY="$(prompt_with_default "RATE_LIMIT_MAX_PER_DAY" "$(env_default RATE_LIMIT_MAX_PER_DAY 10000)")"

umask 077
cat > "$ENV_FILE" <<ENV
ADMIN_PASSWORD=$ADMIN_PASSWORD
DEFAULT_TEACHER_KEY=$DEFAULT_TEACHER_KEY
DOWNLOAD_TOKEN=$DOWNLOAD_TOKEN
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
echo "================ Local server summary ================"
echo "Local URL:           http://localhost:$PORT"
echo "ADMIN_PASSWORD:      $ADMIN_PASSWORD"
echo "DEFAULT_TEACHER_KEY: $DEFAULT_TEACHER_KEY"
echo "DOWNLOAD_TOKEN:      $DOWNLOAD_TOKEN"
echo "AUTH_FAILURE_LIMIT / WINDOW_MINUTES: $AUTH_FAILURE_LIMIT / $AUTH_FAILURE_WINDOW_MINUTES"
echo "AUTH bans (admin days / teacher min / student min): $AUTH_ADMIN_BAN_DAYS / $AUTH_TEACHER_BAN_MINUTES / $AUTH_STUDENT_BAN_MINUTES"
echo "RATE_LIMIT per second / minute / day: $RATE_LIMIT_MAX_PER_SECOND / $RATE_LIMIT_MAX_PER_MINUTE / $RATE_LIMIT_MAX_PER_DAY"
echo "(Values are stored in $ENV_FILE, which is gitignored. Treat this output as sensitive.)"
echo "====================================================="
echo

if [ "$START" -eq 1 ]; then
  echo "Starting the server (Ctrl+C to stop)..."
  exec npm start
else
  echo "Skipping start (--no-start). Run 'npm start' when ready."
fi
