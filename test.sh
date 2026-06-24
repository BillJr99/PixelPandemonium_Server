#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

PORT="$(awk -F': *' '/^port:/ { print $2 }' config.yaml | tr -d '"' | tr -d "'")"
PORT="${PORT:-8000}"
BASE_URL="http://127.0.0.1:${PORT}"
ORIGIN="http://localhost:4000"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin}"
SERVER_PID=""

ensure_test_env() {
  touch .env
  grep -q '^ADMIN_PASSWORD=' .env || printf 'ADMIN_PASSWORD=%s\n' "$ADMIN_PASSWORD" >>.env
  grep -q '^DOWNLOAD_TOKEN=' .env || printf 'DOWNLOAD_TOKEN=change-me-before-deploying\n' >>.env
  grep -q '^AUTH_FAILURE_LIMIT=' .env || printf 'AUTH_FAILURE_LIMIT=5\n' >>.env
  grep -q '^AUTH_FAILURE_WINDOW_MINUTES=' .env || printf 'AUTH_FAILURE_WINDOW_MINUTES=10\n' >>.env
  grep -q '^AUTH_BAN_DAYS=' .env || printf 'AUTH_BAN_DAYS=1\n' >>.env
}

clear_test_auth_failures() {
  node -e "const sqlite3=require('sqlite3').verbose(); const db=new sqlite3.Database('./main.db'); db.run('DELETE FROM AUTH_FAILURES', () => db.close());" >/dev/null 2>&1 || true
}

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

node --test tests/unit/*.test.js
clear_test_auth_failures

if ! curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
  ensure_test_env
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
clear_test_auth_failures

curl -fsS "$BASE_URL/health" >/dev/null
curl -fsS -H "Origin: $ORIGIN" "$BASE_URL/pictures" \
  | node -e "const fs=require('fs'); const d=JSON.parse(fs.readFileSync(0,'utf8')); if(d.length < 16 || !d.some(p => p.id === 'tetris')) process.exit(1)"

CUSTOM_PAYLOAD="{\"title\":\"Smoke Custom\",\"adminPassword\":\"$ADMIN_PASSWORD\",\"spec\":{\"palette\":[[255,255,255],[0,0,0]],\"numRows\":1,\"numCols\":1,\"pages\":[{\"col\":\"A\",\"row\":\"1\",\"uncompressed\":[0,1,0,1,0,1,0,1,0,1,0,1,0,1,0]}]}}"
CUSTOM_PICTURE="$(curl -fsS -H "Origin: $ORIGIN" -H "Content-Type: application/json" \
  -d "$CUSTOM_PAYLOAD" \
  "$BASE_URL/pictures/custom")"
CUSTOM_ID="$(node -e "const data=JSON.parse(process.argv[1]); if(!data.id || !data.zipUrl) process.exit(1); console.log(data.id)" "$CUSTOM_PICTURE")"
curl -fsS -H "Origin: $ORIGIN" "$BASE_URL/pictures/$CUSTOM_ID/spec.js" \
  | node -e "const fs=require('fs'); const text=fs.readFileSync(0,'utf8'); if(!/var palette =/.test(text) || !/var pages =/.test(text)) process.exit(1)"
ZIP_STATUS="$(curl -s -o /tmp/pixel-custom-spec.zip -w "%{http_code}" -H "Origin: $ORIGIN" "$BASE_URL/pictures/$CUSTOM_ID/spec-files.zip")"
test "$ZIP_STATUS" = "200"

CREATE_A="$(curl -fsS -H "Origin: $ORIGIN" -H "Content-Type: application/json" \
  -d '{"pictureId":"tetris","teacherName":"Ada Lovelace","dateTime":"2026-06-23T10:30:00","expirationHours":2}' \
  "$BASE_URL/instance/create")"
CREATE_B="$(curl -fsS -H "Origin: $ORIGIN" -H "Content-Type: application/json" \
  -d '{"pictureId":"eagles","teacherName":"Grace Hopper","dateTime":"2026-06-23T11:30:00","expirationHours":2}' \
  "$BASE_URL/instance/create")"
CREATE_CUSTOM="$(curl -fsS -H "Origin: $ORIGIN" -H "Content-Type: application/json" \
  -d "{\"pictureId\":\"$CUSTOM_ID\",\"teacherName\":\"Custom Teacher\",\"dateTime\":\"2026-06-23T12:30:00\",\"expirationHours\":2}" \
  "$BASE_URL/instance/create")"

CODE_A="$(node -e "const data=JSON.parse(process.argv[1]); console.log(data.instanceCode)" "$CREATE_A")"
ADMIN_A="$(node -e "const data=JSON.parse(process.argv[1]); console.log(data.adminCode)" "$CREATE_A")"
KEY_A="$(node -e "const data=JSON.parse(process.argv[1]); console.log(data.accessKey)" "$CREATE_A")"
TEACHER_KEY_A="$(node -e "const data=JSON.parse(process.argv[1]); console.log(data.teacherKey)" "$CREATE_A")"
CODE_B="$(node -e "const data=JSON.parse(process.argv[1]); console.log(data.instanceCode)" "$CREATE_B")"
ADMIN_B="$(node -e "const data=JSON.parse(process.argv[1]); console.log(data.adminCode)" "$CREATE_B")"
KEY_B="$(node -e "const data=JSON.parse(process.argv[1]); console.log(data.accessKey)" "$CREATE_B")"
TEACHER_KEY_B="$(node -e "const data=JSON.parse(process.argv[1]); console.log(data.teacherKey)" "$CREATE_B")"
CODE_CUSTOM="$(node -e "const data=JSON.parse(process.argv[1]); console.log(data.instanceCode)" "$CREATE_CUSTOM")"
KEY_CUSTOM="$(node -e "const data=JSON.parse(process.argv[1]); console.log(data.accessKey)" "$CREATE_CUSTOM")"

node -e "const data=JSON.parse(process.argv[1]); if(!/instructions\\.html\\?instance=.*&key=/.test(data.studentUrl) || !/teacher-dashboard\\.html\\?instance=.*&teacherKey=.*&admin=/.test(data.teacherUrl) || !/admin\\.html\\?instance=.*&teacherKey=.*&admin=/.test(data.adminUrl)) process.exit(1)" "$CREATE_A"

curl -fsS -H "Origin: $ORIGIN" "$BASE_URL/instance/tetris/status" | node -e "const fs=require('fs'); const d=JSON.parse(fs.readFileSync(0,'utf8')); if(!d.valid || d.instanceCode!=='tetris' || d.pictureId!=='tetris') process.exit(1)"
curl -fsS -H "Origin: $ORIGIN" -H "Content-Type: application/json" \
  -d '{"data":"0,0,10,10,#abcdef,0,0"}' \
  "$BASE_URL/instance/tetris/insert" >/dev/null
curl -fsS -H "Origin: $ORIGIN" "$BASE_URL/instance/tetris/retrieve" \
  | node -e "const fs=require('fs'); const d=JSON.parse(fs.readFileSync(0,'utf8')); if(!d.some(row => row.DATA && row.DATA.includes('#abcdef'))) process.exit(1)"
curl -fsS -H "Origin: $ORIGIN" -H "Content-Type: application/json" \
  -d '{}' \
  "$BASE_URL/instance/tetris/reset" >/dev/null
curl -fsS -H "Origin: $ORIGIN" "$BASE_URL/instance/tetris/retrieve" \
  | node -e "const fs=require('fs'); const d=JSON.parse(fs.readFileSync(0,'utf8')); if(d.length!==0) process.exit(1)"
TETRIS_DELETE_STATUS="$(curl -s -o /tmp/pixel-tetris-delete.json -w "%{http_code}" -H "Origin: $ORIGIN" -H "Content-Type: application/json" -d '{}' "$BASE_URL/instance/tetris/deactivate")"
test "$TETRIS_DELETE_STATUS" = "403"

RESERVED_NAME_STATUS="$(curl -s -o /tmp/pixel-reserved-name.json -w "%{http_code}" -H "Origin: $ORIGIN" -H "Content-Type: application/json" \
  -d '{"pictureId":"tetris","instanceName":"tetris","teacherName":"Reserved","dateTime":"2026-06-23T13:30:00","expirationHours":2}' \
  "$BASE_URL/instance/create")"
test "$RESERVED_NAME_STATUS" = "409"

MISSING_KEY_STATUS="$(curl -s -o /tmp/pixel-missing-key.json -w "%{http_code}" -H "Origin: $ORIGIN" "$BASE_URL/instance/$CODE_B/status")"
test "$MISSING_KEY_STATUS" = "403"
curl -fsS -H "Origin: $ORIGIN" "$BASE_URL/instance/$CODE_A/status?key=$KEY_A" | node -e "const fs=require('fs'); const d=JSON.parse(fs.readFileSync(0,'utf8')); if(!d.valid) process.exit(1)"
curl -fsS -H "Origin: $ORIGIN" "$BASE_URL/instance/$CODE_CUSTOM/status?key=$KEY_CUSTOM" \
  | node -e "const fs=require('fs'); const d=JSON.parse(fs.readFileSync(0,'utf8')); if(!d.valid || !d.pictureCustom || !d.pictureSpecUrl) process.exit(1)"

INVALID_STATUS="$(curl -s -o /tmp/pixel-invalid.json -w "%{http_code}" -H "Origin: $ORIGIN" "$BASE_URL/instance/BAD-CODE/status")"
test "$INVALID_STATUS" = "400"

curl -fsS -H "Origin: $ORIGIN" -H "Content-Type: application/json" \
  -d "{\"accessKey\":\"$KEY_A\",\"data\":\"0,0,10,10,#ff0000,0,0\"}" \
  "$BASE_URL/instance/$CODE_A/insert" >/dev/null
curl -fsS -H "Origin: $ORIGIN" -H "Content-Type: application/json" \
  -d "{\"accessKey\":\"$KEY_B\",\"data\":\"0,0,10,10,#0000ff,1,0\"}" \
  "$BASE_URL/instance/$CODE_B/insert" >/dev/null

curl -fsS -H "Origin: $ORIGIN" "$BASE_URL/instance/$CODE_A/retrieve?key=$KEY_A" \
  | node -e "const fs=require('fs'); const d=JSON.parse(fs.readFileSync(0,'utf8')); if(d.length!==1 || !d[0].DATA.includes('#ff0000')) process.exit(1)"
curl -fsS -H "Origin: $ORIGIN" "$BASE_URL/instance/$CODE_B/retrieve?key=$KEY_B" \
  | node -e "const fs=require('fs'); const d=JSON.parse(fs.readFileSync(0,'utf8')); if(d.length!==1 || !d[0].DATA.includes('#0000ff')) process.exit(1)"

MISSING_TEACHER_STATUS="$(curl -s -o /tmp/pixel-missing-teacher-key.json -w "%{http_code}" -H "Origin: $ORIGIN" "$BASE_URL/instance/$CODE_B/admin?admin=$ADMIN_B&adminPassword=$ADMIN_PASSWORD")"
test "$MISSING_TEACHER_STATUS" = "403"
ADMIN_VIEW="$(curl -fsS -H "Origin: $ORIGIN" "$BASE_URL/instance/$CODE_A/admin?admin=$ADMIN_A&teacherKey=$TEACHER_KEY_A&adminPassword=$ADMIN_PASSWORD")"
EVENT_ID="$(node -e "const data=JSON.parse(process.argv[1]); if(data.rows.length!==1) process.exit(1); console.log(data.rows[0].ID)" "$ADMIN_VIEW")"
curl -fsS -H "Origin: $ORIGIN" -H "Content-Type: application/json" \
  -d "{\"adminCode\":\"$ADMIN_A\",\"teacherKey\":\"$TEACHER_KEY_A\",\"adminPassword\":\"$ADMIN_PASSWORD\",\"data\":\"0,0,10,10,#00ff00,0,0\"}" \
  "$BASE_URL/instance/$CODE_A/event/$EVENT_ID/update" >/dev/null
curl -fsS -H "Origin: $ORIGIN" "$BASE_URL/instance/$CODE_A/retrieve?key=$KEY_A" \
  | node -e "const fs=require('fs'); const d=JSON.parse(fs.readFileSync(0,'utf8')); if(d.length!==1 || !d[0].DATA.includes('#00ff00')) process.exit(1)"
curl -fsS -H "Origin: $ORIGIN" -H "Content-Type: application/json" \
  -d "{\"accessKey\":\"$KEY_A\",\"data\":\"0,0,10,10,#111111,2,0\"}" \
  "$BASE_URL/instance/$CODE_A/insert" >/dev/null
ADMIN_VIEW_AFTER_INSERT="$(curl -fsS -H "Origin: $ORIGIN" "$BASE_URL/instance/$CODE_A/admin?admin=$ADMIN_A&teacherKey=$TEACHER_KEY_A&adminPassword=$ADMIN_PASSWORD")"
DELETE_EVENT_ID="$(node -e "const data=JSON.parse(process.argv[1]); if(data.rows.length!==2) process.exit(1); console.log(data.rows.find(row => row.DATA.includes('#111111')).ID)" "$ADMIN_VIEW_AFTER_INSERT")"
curl -fsS -H "Origin: $ORIGIN" -H "Content-Type: application/json" \
  -d "{\"adminCode\":\"$ADMIN_A\",\"teacherKey\":\"$TEACHER_KEY_A\",\"adminPassword\":\"$ADMIN_PASSWORD\"}" \
  "$BASE_URL/instance/$CODE_A/event/$DELETE_EVENT_ID/delete" >/dev/null
curl -fsS -H "Origin: $ORIGIN" "$BASE_URL/instance/$CODE_A/retrieve?key=$KEY_A" \
  | node -e "const fs=require('fs'); const d=JSON.parse(fs.readFileSync(0,'utf8')); if(d.length!==1 || d.some(row => row.DATA.includes('#111111'))) process.exit(1)"

ROTATE_STUDENT="$(curl -fsS -H "Origin: $ORIGIN" -H "Content-Type: application/json" \
  -d "{\"keyType\":\"student\",\"adminCode\":\"$ADMIN_B\",\"teacherKey\":\"$TEACHER_KEY_B\",\"adminPassword\":\"$ADMIN_PASSWORD\"}" \
  "$BASE_URL/instance/$CODE_B/rotate-key")"
NEW_KEY_B="$(node -e "const data=JSON.parse(process.argv[1]); if(data.keyType!=='student' || data.accessKey===process.argv[2]) process.exit(1); console.log(data.accessKey)" "$ROTATE_STUDENT" "$KEY_B")"
OLD_KEY_STATUS="$(curl -s -o /tmp/pixel-old-key.json -w "%{http_code}" -H "Origin: $ORIGIN" "$BASE_URL/instance/$CODE_B/status?key=$KEY_B")"
test "$OLD_KEY_STATUS" = "403"
KEY_B="$NEW_KEY_B"
curl -fsS -H "Origin: $ORIGIN" "$BASE_URL/instance/$CODE_B/status?key=$KEY_B" >/dev/null

ROTATE_TEACHER="$(curl -fsS -H "Origin: $ORIGIN" -H "Content-Type: application/json" \
  -d "{\"keyType\":\"teacher\",\"adminCode\":\"$ADMIN_B\",\"teacherKey\":\"$TEACHER_KEY_B\",\"adminPassword\":\"$ADMIN_PASSWORD\"}" \
  "$BASE_URL/instance/$CODE_B/rotate-key")"
NEW_TEACHER_KEY_B="$(node -e "const data=JSON.parse(process.argv[1]); if(data.keyType!=='teacher' || data.teacherKey===process.argv[2]) process.exit(1); console.log(data.teacherKey)" "$ROTATE_TEACHER" "$TEACHER_KEY_B")"
OLD_TEACHER_STATUS="$(curl -s -o /tmp/pixel-old-teacher-key.json -w "%{http_code}" -H "Origin: $ORIGIN" -H "Content-Type: application/json" \
  -d "{\"keyType\":\"student\",\"adminCode\":\"$ADMIN_B\",\"teacherKey\":\"$TEACHER_KEY_B\",\"adminPassword\":\"$ADMIN_PASSWORD\"}" \
  "$BASE_URL/instance/$CODE_B/rotate-key")"
test "$OLD_TEACHER_STATUS" = "403"
TEACHER_KEY_B="$NEW_TEACHER_KEY_B"

TETRIS_ROTATE_STATUS="$(curl -s -o /tmp/pixel-tetris-rotate.json -w "%{http_code}" -H "Origin: $ORIGIN" -H "Content-Type: application/json" \
  -d '{"keyType":"student"}' \
  "$BASE_URL/instance/tetris/rotate-key")"
test "$TETRIS_ROTATE_STATUS" = "403"

curl -fsS -H "Origin: $ORIGIN" -H "Content-Type: application/json" \
  -d "{\"adminCode\":\"$ADMIN_A\",\"teacherKey\":\"$TEACHER_KEY_A\",\"adminPassword\":\"$ADMIN_PASSWORD\"}" \
  "$BASE_URL/instance/$CODE_A/reset" >/dev/null
curl -fsS -H "Origin: $ORIGIN" "$BASE_URL/instance/$CODE_A/retrieve?key=$KEY_A" \
  | node -e "const fs=require('fs'); const d=JSON.parse(fs.readFileSync(0,'utf8')); if(d.length!==0) process.exit(1)"

curl -fsS -H "Origin: $ORIGIN" -H "Content-Type: application/json" \
  -d "{\"accessKey\":\"$KEY_A\",\"data\":\"0,0,10,10,#123456,0,0\"}" \
  "$BASE_URL/instance/$CODE_A/insert" >/dev/null
curl -fsS -H "Origin: $ORIGIN" -H "Content-Type: application/json" \
  -d "{\"adminCode\":\"$ADMIN_A\",\"teacherKey\":\"$TEACHER_KEY_A\",\"adminPassword\":\"$ADMIN_PASSWORD\"}" \
  "$BASE_URL/instance/$CODE_A/deactivate" >/dev/null
DELETE_STATUS="$(curl -s -o /tmp/pixel-deleted.json -w "%{http_code}" -H "Origin: $ORIGIN" "$BASE_URL/instance/$CODE_A/status?key=$KEY_A")"
test "$DELETE_STATUS" = "404"
curl -fsS -H "Origin: $ORIGIN" "$BASE_URL/retrieve?name=$CODE_A" \
  | node -e "const fs=require('fs'); const d=JSON.parse(fs.readFileSync(0,'utf8')); if(d.length!==1 || !d[0].DATA.includes('#123456')) process.exit(1)"

curl -fsS -H "Origin: $ORIGIN" -H "Content-Type: application/json" \
  -d '{"data":"legacy"}' "$BASE_URL/insert?name=legacy-test" >/dev/null
curl -fsS -H "Origin: $ORIGIN" "$BASE_URL/retrieve?name=legacy-test" \
  | node -e "const fs=require('fs'); const d=JSON.parse(fs.readFileSync(0,'utf8')); if(d.length<1) process.exit(1)"

for _ in $(seq 1 5); do
  curl -s -o /tmp/pixel-auth-failure.json -w "%{http_code}" -H "Origin: $ORIGIN" "$BASE_URL/instance/$CODE_B/status?key=WRONG" >/dev/null
done
BANNED_STATUS="$(curl -s -o /tmp/pixel-auth-banned.json -w "%{http_code}" -H "Origin: $ORIGIN" "$BASE_URL/instance/$CODE_B/status?key=$KEY_B")"
test "$BANNED_STATUS" = "429"

echo "Server tests passed."
