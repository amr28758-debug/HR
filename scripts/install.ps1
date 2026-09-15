# Burtplace Workforce — install on this Windows PC.
#
#   powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Path "D:\HR\Burtplace"
#
# Puts the program in %USERPROFILE%\HR\Burtplace (or -Path), adds a "Burtplace Workforce"
# icon to the Desktop and the Start Menu, and starts it. After this, opening the program
# is a double-click — no commands.
param(
  [string]$Path = (Join-Path $env:USERPROFILE 'HR\Burtplace'),
  [string]$Repo = 'https://github.com/amr28758-debug/HR.git',
  [string]$Branch = 'claude/gracious-brahmagupta-mcdn7j',
  [switch]$NoStart
)
$ErrorActionPreference = 'Stop'
function Ok([string]$m)   { Write-Host "OK  $m" -ForegroundColor Green }
function Step([string]$m) { Write-Host ">>  $m" -ForegroundColor Cyan }
function Fail([string]$m) { Write-Host "ERR $m" -ForegroundColor Red }
function Have([string]$c) { $null -ne (Get-Command $c -ErrorAction SilentlyContinue) }

Write-Host ''
Write-Host '  Burtplace Workforce - installer' -ForegroundColor Cyan
Write-Host ''

if (-not (Have git))  { Fail 'Git is not installed. Install it from https://git-scm.com/download/win, then run this again.'; exit 1 }
if (-not (Have node)) { Fail 'Node.js is not installed. Install Node 22 LTS from https://nodejs.org, then run this again.'; exit 1 }

# --- 1. Copy of the program ---------------------------------------------------
if (Test-Path (Join-Path $Path '.git')) {
  Step "Updating the existing copy in $Path"
  git -C $Path fetch origin $Branch
  git -C $Path checkout $Branch
  git -C $Path pull --ff-only origin $Branch
} else {
  if ((Test-Path $Path) -and (Get-ChildItem $Path -Force | Measure-Object).Count -gt 0) {
    Fail "$Path already exists and is not empty. Choose another folder with -Path, or empty this one."
    exit 1
  }
  Step "Downloading the program into $Path"
  New-Item -ItemType Directory -Force -Path (Split-Path $Path -Parent) | Out-Null
  git clone --branch $Branch $Repo $Path
}
$root = (Resolve-Path $Path).Path
Ok "Program files in $root"

# --- 2. Desktop and Start Menu icons -----------------------------------------
Step 'Creating the Desktop and Start Menu shortcuts'
$icon = Join-Path $root 'infra\branding\burtplace.ico'
$target = Join-Path $root 'scripts\start.cmd'
$shell = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath('Desktop'),
                   (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'))) {
  if (-not (Test-Path $dir)) { continue }
  $lnk = $shell.CreateShortcut((Join-Path $dir 'Burtplace Workforce.lnk'))
  $lnk.TargetPath = $target
  $lnk.WorkingDirectory = $root
  $lnk.Description = 'Burtplace Workforce - HR, attendance and payroll'
  if (Test-Path $icon) { $lnk.IconLocation = $icon }
  $lnk.Save()
}
Ok 'Shortcut "Burtplace Workforce" added to the Desktop and the Start Menu'

# --- 3. First start -----------------------------------------------------------
if ($NoStart) {
  Write-Host ''
  Ok 'Installed. Double-click "Burtplace Workforce" on the Desktop to start it.'
  exit 0
}
Write-Host ''
Step 'Starting for the first time (this installs dependencies and demo data - a few minutes)'
Write-Host ''
& (Join-Path $root 'scripts\start.ps1')
