# Burtplace Workforce — one-command local launcher (Windows / PowerShell).
#
#   .\scripts\start.ps1              start everything (first run installs & seeds)
#   .\scripts\start.ps1 -Reset       wipe the database and re-seed the demo data
#   .\scripts\start.ps1 -Https       serve the web app over HTTPS (needed to test the
#                                    camera from a phone on the same Wi-Fi)
#   .\scripts\start.ps1 -Stop        stop the database containers started by this script
#
# Requirements: Node 22+ and either Docker Desktop (for PostgreSQL/Redis) or a local
# PostgreSQL 16 + Redis already running on the default ports.
#
# If Windows blocks the script, run it once as:
#   powershell -ExecutionPolicy Bypass -File .\scripts\start.ps1
param([switch]$Https, [switch]$Reset, [switch]$Stop)
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
$root = (Get-Location).Path

function Ok([string]$m)   { Write-Host "OK  $m" -ForegroundColor Green }
function Step([string]$m) { Write-Host ">>  $m" -ForegroundColor Cyan }
function Fail([string]$m) { Write-Host "ERR $m" -ForegroundColor Red }
function Have([string]$c) { $null -ne (Get-Command $c -ErrorAction SilentlyContinue) }
function DockerUp { if (-not (Have docker)) { return $false }; docker info *> $null; return $LASTEXITCODE -eq 0 }
function PortOpen([int]$p) { try { (New-Object Net.Sockets.TcpClient).ConnectAsync('127.0.0.1', $p).Wait(1500) } catch { $false } }

if ($Stop) {
  if (DockerUp) { docker compose stop postgres redis *> $null; Ok 'Database containers stopped' }
  exit 0
}

# --- 1. Prerequisites --------------------------------------------------------
if (-not (Have node)) { Fail 'Node.js is not installed. Install Node 22 LTS from https://nodejs.org and run this again.'; exit 1 }
$major = [int](node -p "process.versions.node.split('.')[0]")
if ($major -lt 20) { Fail "Node $major found; Node 22 LTS is required (https://nodejs.org)."; exit 1 }
if (-not (Have pnpm)) { Step 'Installing pnpm'; corepack enable *> $null; corepack prepare pnpm@10.33.0 --activate *> $null }
if (-not (Have pnpm)) { Fail 'Could not install pnpm. Run: npm install -g pnpm'; exit 1 }
Ok "Node $(node -v) - pnpm $(pnpm -v)"

# --- 2. Configuration (.env with generated secrets) --------------------------
if (-not (Test-Path .env)) {
  Step 'Creating .env with freshly generated secrets'
  Copy-Item .env.example .env
  node -e @'
const fs = require("fs"), crypto = require("crypto");
const hex = (n) => crypto.randomBytes(n).toString("hex");
let s = fs.readFileSync(".env", "utf8");
const set = (k, v) => { s = s.match(new RegExp("^"+k+"=.*$", "m")) ? s.replace(new RegExp("^"+k+"=.*$", "m"), k+"="+v) : s + "\n"+k+"="+v; };
set("AUTH_LOCAL_JWT_SECRET", hex(32));
set("API_KEY_PEPPER", hex(24));
set("BIOMETRIC_TEMPLATE_KEY", hex(32));
set("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/burtplace_dev");
set("DATABASE_URL_TEST", "postgres://postgres:postgres@localhost:5432/burtplace_test");
fs.writeFileSync(".env", s);
'@
  Ok '.env created (keep it private - it holds the biometric template key)'
} else { Ok '.env found (left unchanged)' }

# --- 3. PostgreSQL + Redis ---------------------------------------------------
if ((PortOpen 5432) -and (PortOpen 6379)) {
  Ok 'PostgreSQL and Redis already running'
} elseif (DockerUp) {
  Step 'Starting PostgreSQL and Redis (Docker)'
  docker compose up -d postgres redis
  for ($i = 0; $i -lt 60 -and -not ((PortOpen 5432) -and (PortOpen 6379)); $i++) { Start-Sleep 1 }
  if (-not (PortOpen 5432)) { Fail 'PostgreSQL did not become ready. Check: docker compose logs postgres'; exit 1 }
  Ok 'PostgreSQL and Redis ready'
} else {
  Fail 'Neither a running PostgreSQL/Redis nor Docker was found.'
  Write-Host '    Install Docker Desktop (https://docker.com/products/docker-desktop) and run this script again,'
  Write-Host '    or start PostgreSQL 16 on port 5432 and Redis on 6379 yourself.'
  exit 1
}

# --- 4. Dependencies and shared packages -------------------------------------
Step 'Installing dependencies (first run takes a few minutes)'
pnpm install
if ($LASTEXITCODE -ne 0) { Fail 'pnpm install failed'; exit 1 }
Step 'Building shared packages'
pnpm -r --filter './packages/**' build | Out-Null
Ok 'Packages built'

# --- 5. Database schema + demo data ------------------------------------------
if ($Reset) { Step 'Resetting the database and loading the demo data'; pnpm db:reset }
else { Step 'Applying migrations (and seeding the demo data on a first run)'; pnpm db:ensure }
Ok 'Database ready'

# --- 6. Run API + web --------------------------------------------------------
New-Item -ItemType Directory -Force -Path .logs | Out-Null
$lan = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
        Select-Object -First 1).IPAddress

Step 'Starting the API'
$api = Start-Process -FilePath 'pnpm' -ArgumentList 'dev:api' -WorkingDirectory $root -PassThru -NoNewWindow `
       -RedirectStandardOutput "$root\.logs\api.log" -RedirectStandardError "$root\.logs\api.err.log"
for ($i = 0; $i -lt 90 -and -not (PortOpen 4000); $i++) { Start-Sleep 1 }
if (-not (PortOpen 4000)) { Fail 'The API did not start. See .logs\api.log'; Get-Content "$root\.logs\api.log" -Tail 20; exit 1 }
Ok 'API ready on http://localhost:4000 (API reference at /docs)'

Step 'Starting the web app'
if ($Https) {
  $web = Start-Process -FilePath 'pnpm' -ArgumentList 'exec','next','dev','-p','3000','-H','0.0.0.0','--experimental-https' `
         -WorkingDirectory "$root\apps\web" -PassThru -NoNewWindow `
         -RedirectStandardOutput "$root\.logs\web.log" -RedirectStandardError "$root\.logs\web.err.log"
  $scheme = 'https'
} else {
  $web = Start-Process -FilePath 'pnpm' -ArgumentList 'dev:web' -WorkingDirectory $root -PassThru -NoNewWindow `
         -RedirectStandardOutput "$root\.logs\web.log" -RedirectStandardError "$root\.logs\web.err.log"
  $scheme = 'http'
}
for ($i = 0; $i -lt 90 -and -not (PortOpen 3000); $i++) { Start-Sleep 1 }
Ok 'Web app ready'

Write-Host ''
Write-Host '  --------------------------------------------------------------------'
Write-Host '   BURTPLACE WORKFORCE is running' -ForegroundColor Green
Write-Host '  --------------------------------------------------------------------'
Write-Host "   Open:      $scheme`://localhost:3000"
Write-Host '   API docs:  http://localhost:4000/docs'
if ($Https -and $lan) {
  Write-Host "   From a phone on the same Wi-Fi:  https://$lan`:3000/attendance"
  Write-Host '   (accept the self-signed certificate warning once)'
}
Write-Host ''
Write-Host '   Sign in with any of these (password for all: Password123!)'
Write-Host '     hr.manager@burtplace.local   full HR access, face enrollment & settings'
Write-Host '     it.admin@burtplace.local     devices, kiosks, pairing codes'
Write-Host '     employee@burtplace.local     employee self-service'
Write-Host ''
Write-Host '   Face attendance - try it in this order'
Write-Host '     1. Directory -> open an employee -> Biometric tab -> Enroll face'
Write-Host '        (use your own face so recognition can find you afterwards)'
Write-Host '     2. Same tab -> Test recognition (checks the match, records no attendance)'
Write-Host '     3. Open /attendance -> Start -> follow the steps -> CHECK IN'
Write-Host '     4. Administration -> Face recognition -> Terminals -> Register terminal,'
Write-Host '        then open /kiosk/pair on a tablet and enter the 6-digit code'
Write-Host '     5. Administration -> Face recognition -> Settings / Recognition events'
Write-Host ''
Write-Host '   Logs: .logs\api.log - .logs\web.log        Press Ctrl+C to stop'
Write-Host '  --------------------------------------------------------------------'
Write-Host ''

Start-Process "$scheme`://localhost:3000" -ErrorAction SilentlyContinue
try { Wait-Process -Id $api.Id, $web.Id } finally {
  Step 'Stopping...'
  Stop-Process -Id $api.Id, $web.Id -Force -ErrorAction SilentlyContinue
}
