#!/usr/bin/env bash
# Burtplace Workforce — install on this Mac / Linux machine.
#
#   ./scripts/install.sh                      install into ~/HR/Burtplace
#   ./scripts/install.sh --path ~/work/bp     install somewhere else
#   ./scripts/install.sh --no-start           install without starting it
#
# Puts the program in ~/HR/Burtplace, adds a "Burtplace Workforce" launcher to the
# Desktop and starts it. After this, opening the program is a double-click.
set -euo pipefail
PATH_ARG="$HOME/HR/Burtplace"
REPO="https://github.com/amr28758-debug/HR.git"
BRANCH="claude/gracious-brahmagupta-mcdn7j"
START=1
while [ $# -gt 0 ]; do case "$1" in
  --path) PATH_ARG="$2"; shift 2 ;;
  --repo) REPO="$2"; shift 2 ;;
  --branch) BRANCH="$2"; shift 2 ;;
  --no-start) START=0; shift ;;
  -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "Unknown option: $1 (try --help)"; exit 1 ;;
esac; done

c_ok()   { printf '\033[32m✓\033[0m %s\n' "$1"; }
c_step() { printf '\033[36m▸\033[0m %s\n' "$1"; }
c_err()  { printf '\033[31m✗\033[0m %s\n' "$1" >&2; }
have()   { command -v "$1" >/dev/null 2>&1; }

printf '\n\033[36m  Burtplace Workforce — installer\033[0m\n\n'
have git  || { c_err "Git is not installed. Install it (macOS: xcode-select --install) and run this again."; exit 1; }
have node || { c_err "Node.js is not installed. Install Node 22 LTS from https://nodejs.org and run this again."; exit 1; }

# ── 1. Copy of the program ───────────────────────────────────────────────────
if [ -d "$PATH_ARG/.git" ]; then
  c_step "Updating the existing copy in $PATH_ARG"
  git -C "$PATH_ARG" fetch origin "$BRANCH"
  git -C "$PATH_ARG" checkout "$BRANCH"
  git -C "$PATH_ARG" pull --ff-only origin "$BRANCH"
else
  if [ -d "$PATH_ARG" ] && [ -n "$(ls -A "$PATH_ARG" 2>/dev/null)" ]; then
    c_err "$PATH_ARG already exists and is not empty. Choose another folder with --path, or empty this one."
    exit 1
  fi
  c_step "Downloading the program into $PATH_ARG"
  mkdir -p "$(dirname "$PATH_ARG")"
  git clone --branch "$BRANCH" "$REPO" "$PATH_ARG"
fi
ROOT="$(cd "$PATH_ARG" && pwd)"
chmod +x "$ROOT/scripts/start.sh" "$ROOT/scripts/install.sh" 2>/dev/null || true
c_ok "Program files in $ROOT"

# ── 2. Desktop launcher ──────────────────────────────────────────────────────
DESKTOP="$HOME/Desktop"
if [ -d "$DESKTOP" ]; then
  c_step "Creating the Desktop launcher"
  if [ "$(uname)" = "Darwin" ]; then
    cat > "$DESKTOP/Burtplace Workforce.command" <<LAUNCHER
#!/usr/bin/env bash
cd "$ROOT" && exec ./scripts/start.sh
LAUNCHER
    chmod +x "$DESKTOP/Burtplace Workforce.command"
  else
    cat > "$DESKTOP/burtplace-workforce.desktop" <<LAUNCHER
[Desktop Entry]
Type=Application
Name=Burtplace Workforce
Comment=HR, attendance and payroll
Exec=bash -c 'cd "$ROOT" && ./scripts/start.sh; read -p "Press Enter to close"'
Icon=$ROOT/infra/branding/burtplace-256.png
Terminal=true
Categories=Office;
LAUNCHER
    chmod +x "$DESKTOP/burtplace-workforce.desktop"
    gio set "$DESKTOP/burtplace-workforce.desktop" metadata::trusted true 2>/dev/null || true
  fi
  c_ok 'Launcher "Burtplace Workforce" added to the Desktop'
fi

# ── 3. First start ───────────────────────────────────────────────────────────
if [ "$START" = 0 ]; then
  printf '\n'; c_ok 'Installed. Open "Burtplace Workforce" on the Desktop to start it.'
  exit 0
fi
printf '\n'; c_step 'Starting for the first time (installs dependencies and demo data — a few minutes)'; printf '\n'
exec "$ROOT/scripts/start.sh"
