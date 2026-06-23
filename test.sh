#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

PORT="$(awk -F': *' '/^port:/ { print $2 }' config.yaml | tr -d '"' | tr -d "'")"
PORT="${PORT:-8000}"
BASE_URL="http://127.0.0.1:${PORT}"
ORIGIN="http://localhost:4000"
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if ! command -v node >/dev/null 2>&1; then
  echo "node is required" >&2
  exit 1
fi

if ! curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
  if [ ! -d node_modules ]; then
    echo "node_modules is missing. Run npm install before ./test.sh." >&2
    exit 1
  fi
  npm start >/tmp/pixel-pandemonium-server-test.log 2>&1 &
  SERVER_PID="$!"
  for _ in $(seq 1 30); do
    if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then break; fi
    sleep 1
  done
fi

curl -fsS "$BASE_URL/health" >/dev/null

CREATE_A="$(curl -fsS -H "Origin: $ORIGIN" -H "Content-Type: application/json" \
  -d '{"pictureId":"tetris","teacherName":"Ada Lovelace","dateTime":"2026-06-23T10:30:00","expirationHours":2}' \
  "$BASE_URL/instance/create")"
CREATE_B="$(curl -fsS -H "Origin: $ORIGIN" -H "Content-Type: application/json" \
  -d '{"pictureId":"tetris","teacherName":"Grace Hopper","dateTime":"2026-06-23T11:30:00","expirationHours":2}' \
  "$BASE_URL/instance/create")"

CODE_A="$(node -e "const data=JSON.parse(process.argv[1]); console.log(data.instanceCode)" "$CREATE_A")"
ADMIN_A="$(node -e "const data=JSON.parse(process.argv[1]); console.log(data.adminCode)" "$CREATE_A")"
CODE_B="$(node -e "const data=JSON.parse(process.argv[1]); console.log(data.instanceCode)" "$CREATE_B")"

curl -fsS -H "Origin: $ORIGIN" "$BASE_URL/instance/$CODE_A/status" | node -e "const fs=require('fs'); const d=JSON.parse(fs.readFileSync(0,'utf8')); if(!d.valid) process.exit(1)"

INVALID_STATUS="$(curl -s -o /tmp/pixel-invalid.json -w "%{http_code}" -H "Origin: $ORIGIN" "$BASE_URL/instance/BAD-CODE/status")"
test "$INVALID_STATUS" = "400"

curl -fsS -H "Origin: $ORIGIN" -H "Content-Type: application/json" \
  -d '{"data":"0,0,10,10,#ff0000,0,0"}' \
  "$BASE_URL/instance/$CODE_A/insert" >/dev/null
curl -fsS -H "Origin: $ORIGIN" -H "Content-Type: application/json" \
  -d '{"data":"0,0,10,10,#0000ff,1,0"}' \
  "$BASE_URL/instance/$CODE_B/insert" >/dev/null

curl -fsS -H "Origin: $ORIGIN" "$BASE_URL/instance/$CODE_A/retrieve" \
  | node -e "const fs=require('fs'); const d=JSON.parse(fs.readFileSync(0,'utf8')); if(d.length!==1 || !d[0].DATA.includes('#ff0000')) process.exit(1)"
curl -fsS -H "Origin: $ORIGIN" "$BASE_URL/instance/$CODE_B/retrieve" \
  | node -e "const fs=require('fs'); const d=JSON.parse(fs.readFileSync(0,'utf8')); if(d.length!==1 || !d[0].DATA.includes('#0000ff')) process.exit(1)"

curl -fsS -H "Origin: $ORIGIN" -H "Content-Type: application/json" \
  -d "{\"adminCode\":\"$ADMIN_A\"}" \
  "$BASE_URL/instance/$CODE_A/reset" >/dev/null
curl -fsS -H "Origin: $ORIGIN" "$BASE_URL/instance/$CODE_A/retrieve" \
  | node -e "const fs=require('fs'); const d=JSON.parse(fs.readFileSync(0,'utf8')); if(d.length!==0) process.exit(1)"

curl -fsS -H "Origin: $ORIGIN" -H "Content-Type: application/json" \
  -d 'data=legacy' "$BASE_URL/insert?name=legacy-test" >/dev/null
curl -fsS -H "Origin: $ORIGIN" "$BASE_URL/retrieve?name=legacy-test" \
  | node -e "const fs=require('fs'); const d=JSON.parse(fs.readFileSync(0,'utf8')); if(d.length<1) process.exit(1)"

echo "Server tests passed."
