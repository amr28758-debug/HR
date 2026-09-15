#!/usr/bin/env bash
# Burtplace Workforce — one-command local launcher (macOS / Linux).
#
#   ./scripts/start.sh              start everything (first run installs & seeds)
#   ./scripts/start.sh --reset      wipe the database and re-seed the demo data
#   ./scripts/start.sh --https      serve the web app over HTTPS (needed to test the
#                                   camera from a phone on the same Wi-Fi)
#   ./scripts/start.sh --stop       stop the database containers started by this script
#
# Requirements: Node 22+ and either Docker (for PostgreSQL/Redis) or a local
# PostgreSQL 16 + Redis already running on the default ports.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
HTTPS=0; RESET=0; STOP=0
for a in "$@"; do case "$a" in
  --https) HTTPS=1 ;;
  --reset) RESET=1 ;;
  --stop) STOP=1 ;;
  -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "Unknown option: $a (try --help)"; exit 1 ;;
esac; done

c_ok()   { printf '\033[32m✓\033[0m %s\n' "$1"; }
c_step() { printf '\033[36m▸\033[0m %s\n' "$1"; }
c_warn() { printf '\033[33m!\033[0m %s\n' "$1"; }
c_err()  { printf '\033[31m✗\033[0m %s\n' "$1" >&2; }

have() { command -v "$1" >/dev/null 2>&1; }
docker_up() { have docker && docker info >/dev/null 2>&1; }
port_busy() { node -e "
  const net = require('net'); const s = net.connect($1, '127.0.0.1');
  s.on('connect', () => { s.end(); process.exit(0); }); s.on('error', () => process.exit(1));
  setTimeout(() => process.exit(1), 1200);
" >/dev/null 2>&1; }
who_has() { have lsof && lsof -nP -iTCP:"$1" -sTCP:LISTEN -Fc 2>/dev/null | sed -n 's/^c//p' | head -1; }

if [ "$STOP" = 1 ]; then
  if docker_up; then docker compose stop postgres redis >/dev/null 2>&1 || true; c_ok "Database containers stopped"; fi
  exit 0
fi

# ── 1. Prerequisites ─────────────────────────────────────────────────────────
have node || { c_err "Node.js is not installed. Install Node 22 LTS from https://nodejs.org and run this again."; exit 1; }
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
[ "$NODE_MAJOR" -ge 20 ] || { c_err "Node $NODE_MAJOR found; Node 22 LTS is required (https://nodejs.org)."; exit 1; }
if ! have pnpm; then
  c_step "Installing pnpm"
  corepack enable >/dev/null 2>&1 || true
  corepack prepare pnpm@10.33.0 --activate >/dev/null 2>&1 || npm install -g pnpm@10 >/dev/null 2>&1 || true
  hash -r 2>/dev/null || true
fi
have pnpm || { c_err "Could not install pnpm automatically. Run: npm install -g pnpm@10 — then start this script again."; exit 1; }
c_ok "Node $(node -v) · pnpm $(pnpm -v)"

API_PORT="${API_PORT:-4000}"; WEB_PORT="${WEB_PORT:-3000}"
for pair in "API:$API_PORT" "web:$WEB_PORT"; do
  name="${pair%%:*}"; port="${pair##*:}"
  if port_busy "$port"; then
    owner=$(who_has "$port")
    c_err "Port $port (needed by the $name) is already in use${owner:+ by \"$owner\"}."
    echo "   Close that program, or start this script with a different port, e.g.:"
    echo "     API_PORT=4100 WEB_PORT=3100 ./scripts/start.sh"
    exit 1
  fi
done
export API_PORT API_INTERNAL_URL="http://localhost:$API_PORT"

# ── 2. Configuration (.env with generated secrets) ───────────────────────────
gen_hex() { node -e "console.log(require('crypto').randomBytes($1).toString('hex'))"; }
if [ ! -f .env ]; then
  c_step "Creating .env with freshly generated secrets"
  cp .env.example .env
  node -e '
    const fs = require("fs"), crypto = require("crypto");
    const hex = (n) => crypto.randomBytes(n).toString("hex");
    let s = fs.readFileSync(".env", "utf8");
    const set = (k, v) => { s = s.match(new RegExp("^"+k+"=.*$", "m")) ? s.replace(new RegExp("^"+k+"=.*$", "m"), k+"="+v) : s + "\n"+k+"="+v; };
    set("AUTH_LOCAL_JWT_SECRET", hex(32));
    set("API_KEY_PEPPER", hex(24));
    set("BIOMETRIC_TEMPLATE_KEY", hex(32));   // AES-256-GCM key for face templates
    set("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/burtplace_dev");
    set("DATABASE_URL_TEST", "postgres://postgres:postgres@localhost:5432/burtplace_test");
    fs.writeFileSync(".env", s);
  '
  c_ok ".env created (keep it private — it holds the biometric template key)"
else
  c_ok ".env found (left unchanged)"
fi

# ── 3. PostgreSQL + Redis ────────────────────────────────────────────────────
pg_ready() { node -e "
  const net = require('net'); const s = net.connect(5432, '127.0.0.1');
  s.on('connect', () => { s.end(); process.exit(0); }); s.on('error', () => process.exit(1));
  setTimeout(() => process.exit(1), 1500);
" >/dev/null 2>&1; }
redis_ready() { node -e "
  const net = require('net'); const s = net.connect(6379, '127.0.0.1');
  s.on('connect', () => { s.end(); process.exit(0); }); s.on('error', () => process.exit(1));
  setTimeout(() => process.exit(1), 1500);
" >/dev/null 2>&1; }

if pg_ready && redis_ready; then
  c_ok "PostgreSQL and Redis already running"
elif docker_up; then
  c_step "Starting PostgreSQL and Redis (Docker)"
  docker compose up -d postgres redis
  for i in $(seq 1 60); do pg_ready && redis_ready && break; sleep 1; done
  pg_ready || { c_err "PostgreSQL did not become ready. Check: docker compose logs postgres"; exit 1; }
  c_ok "PostgreSQL and Redis ready"
elif have docker; then
  c_err "Docker is installed but not running. Start Docker Desktop, wait until it says \"Engine running\", then run this script again."
  exit 1
else
  c_err "Neither a running PostgreSQL/Redis nor Docker was found."
  echo "   Install Docker Desktop (https://docker.com/products/docker-desktop) and run this script again,"
  echo "   or start PostgreSQL 16 on port 5432 and Redis on 6379 yourself."
  exit 1
fi

# ── 4. Dependencies and shared packages ──────────────────────────────────────
c_step "Installing dependencies (first run takes a few minutes)"
pnpm install || { c_err "Installing dependencies failed. Check your internet connection and run the script again."; exit 1; }
c_step "Building shared packages"
pnpm -r --filter './packages/**' build >/dev/null
c_ok "Packages built"

# ── 5. Database schema + demo data ───────────────────────────────────────────
if [ "$RESET" = 1 ]; then
  c_step "Resetting the database and loading the demo data"
  pnpm db:reset
else
  c_step "Applying migrations (and seeding the demo data on a first run)"
  pnpm db:ensure
fi
c_ok "Database ready"

# ── 6. Run API + web ─────────────────────────────────────────────────────────
LAN_IP=$(node -e "
  const os = require('os');
  const ip = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
  console.log(ip ? ip.address : '');
")
mkdir -p .logs
API_LOG="$ROOT/.logs/api.log"; WEB_LOG="$ROOT/.logs/web.log"
cleanup() { c_step "Stopping…"; kill ${API_PID:-0} ${WEB_PID:-0} 2>/dev/null || true; wait 2>/dev/null || true; }
trap cleanup EXIT INT TERM

c_step "Starting the API"
( API_PORT="$API_PORT" pnpm dev:api >"$API_LOG" 2>&1 ) & API_PID=$!
for i in $(seq 1 90); do curl -fsS -o /dev/null "http://localhost:$API_PORT/api/v1/attendance/mobile/config" 2>/dev/null && break; sleep 1; done
curl -fsS -o /dev/null "http://localhost:$API_PORT/api/v1/attendance/mobile/config" 2>/dev/null || { c_err "The API did not start. Last lines of $API_LOG:"; tail -25 "$API_LOG"; exit 1; }
c_ok "API ready on http://localhost:$API_PORT (API reference at /docs)"

c_step "Starting the web app"
if [ "$HTTPS" = 1 ]; then
  ( cd apps/web && pnpm exec next dev -p "$WEB_PORT" -H 0.0.0.0 --experimental-https >"$WEB_LOG" 2>&1 ) & WEB_PID=$!
  SCHEME=https
else
  ( cd apps/web && pnpm exec next dev -p "$WEB_PORT" >"$WEB_LOG" 2>&1 ) & WEB_PID=$!
  SCHEME=http
fi
for i in $(seq 1 120); do curl -fsSk -o /dev/null "$SCHEME://localhost:$WEB_PORT/login" 2>/dev/null && break; sleep 1; done
curl -fsSk -o /dev/null "$SCHEME://localhost:$WEB_PORT/login" 2>/dev/null || { c_err "The web app did not start. Last lines of $WEB_LOG:"; tail -25 "$WEB_LOG"; exit 1; }
c_ok "Web app ready"

cat <<BANNER

  ────────────────────────────────────────────────────────────────────
   BURTPLACE WORKFORCE is running
  ────────────────────────────────────────────────────────────────────
   Open:        $SCHEME://localhost:$WEB_PORT
   API docs:    http://localhost:$API_PORT/docs
$( [ "$HTTPS" = 1 ] && [ -n "$LAN_IP" ] && echo "   From a phone on the same Wi-Fi:  https://$LAN_IP:$WEB_PORT/attendance
   (accept the self-signed certificate warning once)" )

   Sign in with any of these (password for all: Password123!)
     hr.manager@burtplace.local   full HR access, face enrollment & settings
     it.admin@burtplace.local     devices, kiosks, pairing codes
     employee@burtplace.local     employee self-service

   Face attendance — try it in this order
     1. Directory → open an employee → Biometric tab → Enroll face
        (use your own face so recognition can find you afterwards)
     2. Same tab → Test recognition (checks the match, records no attendance)
     3. Open /attendance → Start → follow the on-screen steps → CHECK IN
     4. Administration → Face recognition → Terminals → Register terminal,
        then open /kiosk/pair on a tablet and enter the 6-digit code
     5. Administration → Face recognition → Settings / Recognition events

   Logs: .logs/api.log · .logs/web.log        Press Ctrl+C to stop
  ────────────────────────────────────────────────────────────────────

BANNER

if have open; then open "$SCHEME://localhost:$WEB_PORT" >/dev/null 2>&1 || true
elif have xdg-open; then xdg-open "$SCHEME://localhost:$WEB_PORT" >/dev/null 2>&1 || true; fi

wait $API_PID $WEB_PID
