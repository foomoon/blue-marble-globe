#!/usr/bin/env bash
# Install everything this project needs on Ubuntu 24.04, then check it (scripts/doctor.py).
#
#   scripts/setup-ubuntu.sh              everything: data builds, the app, the map server
#   scripts/setup-ubuntu.sh --server     only the map server: Python + Docker
#   scripts/setup-ubuntu.sh --no-docker  everything but Docker
#   scripts/setup-ubuntu.sh --tests      also Playwright's Chromium, for npm test
#
# Safe to run again. Uses Ubuntu's own packages for GDAL, Python and numpy (GDAL's Python
# bindings are built against Ubuntu's numpy, so the venv uses those, not pip's), and nvm for
# Node, at the version in .nvmrc.
set -euo pipefail
cd "$(dirname "$0")/.."

server=0; docker=1; tests=0
for arg in "$@"; do
  case "$arg" in
    --server) server=1 ;;
    --no-docker) docker=0 ;;
    --tests) tests=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

sudo=""; [ "$(id -u)" -ne 0 ] && sudo="sudo"
step() { printf '\n== %s\n' "$*"; }
log() { printf '   %s\n' "$*"; }
NVM_VERSION=v0.40.1
NVM_INSTALLER="https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh"

if ! grep -qi ubuntu /etc/os-release 2>/dev/null; then
  echo "This script is for Ubuntu (24.04). Elsewhere, install the same things by hand: see the README." >&2
  exit 1
fi

packages=(python3 ca-certificates curl)
# libatomic1: Node's Linux builds need it, and minimal/server installs of Ubuntu lack it
[ "$server" -eq 0 ] && packages+=(gdal-bin python3-gdal python3-numpy python3-venv git libatomic1)
[ "$docker" -eq 1 ] && packages+=(docker.io docker-compose-v2)

step "Ubuntu packages: ${packages[*]}"
$sudo apt-get update -qq
DEBIAN_FRONTEND=noninteractive $sudo apt-get install -y -qq "${packages[@]}"

if [ "$docker" -eq 1 ]; then
  step "Docker"
  if [ -d /run/systemd/system ]; then
    $sudo systemctl enable --now docker
  fi
  if [ -n "$sudo" ] && ! id -nG "$USER" | grep -qw docker; then
    $sudo usermod -aG docker "$USER"
    echo "Added $USER to the docker group: log out and back in for it to take effect."
  fi
fi

if [ "$server" -eq 0 ]; then
  want=$(cat .nvmrc)
  step "Node $want"
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  have_path=$(command -v node || true)
  have_ver=$([ -n "$have_path" ] && "$have_path" --version 2>/dev/null || true)
  have_major=${have_ver#v}; have_major=${have_major%%.*}
  used_nvm=0

  if [ -n "$have_ver" ] && [ "$have_major" = "$want" ] && [ ! -s "$NVM_DIR/nvm.sh" ]; then
    log "Node $have_ver at $have_path matches .nvmrc ($want): using it, not installing nvm."
  else
    if [ -s "$NVM_DIR/nvm.sh" ]; then
      log "nvm found at $NVM_DIR: using it for Node $want."
    else
      if [ -n "$have_ver" ]; then
        log "Node $have_ver at $have_path is not $want (.nvmrc): installing nvm and Node $want alongside it."
        log "  (In new terminals nvm's Node comes first on the PATH; the other one is left as it is.)"
      elif [ -n "$have_path" ]; then
        log "A 'node' at $have_path doesn't run: installing nvm and Node $want."
      else
        log "No Node found: installing nvm $NVM_VERSION, then Node $want."
      fi
      log "Downloading nvm's installer: $NVM_INSTALLER"
      log "  (it installs to $NVM_DIR and adds two lines to ~/.bashrc so new terminals load nvm)"
      curl -fsSL "$NVM_INSTALLER" | bash
    fi
    # nvm's script doesn't work under `set -eu` (it reads unset variables and returns non-zero
    # on purpose), so relax that while using it, and check the result ourselves
    set +eu
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
    nvm install && nvm use >/dev/null
    status=$?
    set -eu
    [ "$status" -eq 0 ] || { echo "nvm couldn't install Node $want" >&2; exit 1; }
    used_nvm=1
  fi
  log "Using Node $(node --version) at $(command -v node), npm $(npm --version)."

  step "npm packages"
  npm ci --no-audit --no-fund

  step "Python venv (.venv), using Ubuntu's GDAL bindings and numpy"
  [ -x .venv/bin/python ] || python3 -m venv --system-site-packages .venv

  if [ "$tests" -eq 1 ]; then
    step "Playwright Chromium (for npm test)"
    $sudo env "PATH=$PATH" npx playwright install-deps chromium
    npx playwright install chromium
  fi
fi

step "Check"
if [ "$server" -eq 1 ]; then python3 scripts/doctor.py --server; else python3 scripts/doctor.py; fi
if [ "$server" -eq 0 ] && [ "$used_nvm" -eq 1 ]; then
  echo
  echo "Node comes from nvm, which new terminals load automatically. In this one, run:"
  echo "  source $NVM_DIR/nvm.sh"
fi
