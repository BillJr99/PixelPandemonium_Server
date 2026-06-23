#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
echo "Verify wrangler.jsonc has your D1 database_id before deploying."
npm run cloudflare:db:migrate:remote
npm run cloudflare:deploy
