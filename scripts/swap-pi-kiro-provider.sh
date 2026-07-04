#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Swap pi-kiro-provider between GitHub and this local checkout.

Usage:
  scripts/swap-pi-kiro-provider.sh [--project] status
  scripts/swap-pi-kiro-provider.sh [--project] doctor
  scripts/swap-pi-kiro-provider.sh [--project] use-local
  scripts/swap-pi-kiro-provider.sh [--project] test-local [-- <pi args...>]
  scripts/swap-pi-kiro-provider.sh [--project] use-github
  scripts/swap-pi-kiro-provider.sh [--project] test-github [-- <pi args...>]

Options:
  --project, -l   Install/remove in project-local pi settings instead of user settings

Environment overrides:
  PI_KIRO_REMOTE_SOURCE   GitHub package source to reinstall
                          default: git:github.com/jtdelia/pi-kiro-provider
  PI_KIRO_LOCAL_SOURCE    Local package path to install
                          default: this repo root

Examples:
  scripts/swap-pi-kiro-provider.sh doctor
  scripts/swap-pi-kiro-provider.sh use-local
  scripts/swap-pi-kiro-provider.sh test-local
  scripts/swap-pi-kiro-provider.sh use-github
  scripts/swap-pi-kiro-provider.sh test-github -- -p "hello"
EOF
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: required command not found: $1" >&2
    exit 1
  fi
}

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
LOCAL_SOURCE="${PI_KIRO_LOCAL_SOURCE:-$REPO_ROOT}"
REMOTE_SOURCE="${PI_KIRO_REMOTE_SOURCE:-git:github.com/jtdelia/pi-kiro-provider}"

SCOPE_ARGS=()
if [[ "${1:-}" == "--project" || "${1:-}" == "-l" ]]; then
  SCOPE_ARGS=(-l)
  shift
fi

COMMAND="${1:-}"
if [[ -z "$COMMAND" ]]; then
  usage
  exit 1
fi
shift || true

PI_ARGS=()
if [[ "${1:-}" == "--" ]]; then
  shift
fi
PI_ARGS=("$@")

require_cmd pi

remove_if_present() {
  local scope="$1"
  local source="$2"
  local -a args=()
  local label="user"

  if [[ "$scope" == "project" ]]; then
    args=(-l)
    label="project"
  fi

  if [[ ${#args[@]} -gt 0 ]]; then
    if pi remove "${args[@]}" "$source" >/dev/null 2>&1; then
      echo "removed ($label): $source"
    else
      echo "not installed in $label scope (or already removed): $source"
    fi
  else
    if pi remove "$source" >/dev/null 2>&1; then
      echo "removed ($label): $source"
    else
      echo "not installed in $label scope (or already removed): $source"
    fi
  fi
}

known_variants() {
  printf '%s\n' \
    "$LOCAL_SOURCE" \
    "$REMOTE_SOURCE" \
    "https://github.com/jtdelia/pi-kiro-provider" \
    "git:git@github.com:jtdelia/pi-kiro-provider" \
    "ssh://git@github.com/jtdelia/pi-kiro-provider" \
    "." \
    ".."
}

remove_known_variants() {
  local variant
  while IFS= read -r variant; do
    remove_if_present user "$variant"
    remove_if_present project "$variant"
  done < <(known_variants)
}

install_local() {
  echo "==> switching to local package"
  remove_known_variants
  pi install "${SCOPE_ARGS[@]}" "$LOCAL_SOURCE"
  echo
  echo "Local package installed from: $LOCAL_SOURCE"
}

install_github() {
  echo "==> switching to GitHub package"
  remove_known_variants
  pi install "${SCOPE_ARGS[@]}" "$REMOTE_SOURCE"
  echo
  echo "GitHub package installed from: $REMOTE_SOURCE"
}

settings_path_for_scope() {
  local scope="$1"
  if [[ "$scope" == "project" ]]; then
    printf '%s\n' "$REPO_ROOT/.pi/settings.json"
  else
    printf '%s\n' "$HOME/.pi/agent/settings.json"
  fi
}

detect_scope_source() {
  local scope="$1"
  local settings_path
  settings_path="$(settings_path_for_scope "$scope")"

  if [[ ! -f "$settings_path" ]]; then
    printf 'none\n'
    return
  fi

  python3 - "$settings_path" "$LOCAL_SOURCE" "$REMOTE_SOURCE" <<'PY'
import json
import os
import sys

settings_path, local_source, remote_source = sys.argv[1:4]

try:
    with open(settings_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
except Exception:
    print('none')
    raise SystemExit(0)

packages = data.get('packages', [])
entries = []
for item in packages:
    if isinstance(item, str):
        entries.append(item)
    elif isinstance(item, dict) and isinstance(item.get('source'), str):
        entries.append(item['source'])

repo_root = os.path.dirname(os.path.dirname(os.path.abspath(settings_path))) if settings_path.endswith('/.pi/settings.json') else None

local_variants = {local_source, '.', '..'}
github_variants = {
    remote_source,
    'https://github.com/jtdelia/pi-kiro-provider',
    'git:git@github.com:jtdelia/pi-kiro-provider',
    'ssh://git@github.com/jtdelia/pi-kiro-provider',
}

found_local = any(entry in local_variants for entry in entries)
found_github = any(entry in github_variants for entry in entries)

if found_local and found_github:
    print('both')
elif found_local:
    print('local')
elif found_github:
    print('github')
else:
    print('none')
PY
}

doctor() {
  local user_source project_source
  user_source="$(detect_scope_source user)"
  project_source="$(detect_scope_source project)"

  if [[ "$user_source" == "none" && "$project_source" == "none" ]]; then
    echo "not installed"
  elif [[ "$user_source" == "both" || "$project_source" == "both" ]]; then
    echo "duplicate install detected"
  elif [[ "$user_source" == "local" && "$project_source" == "none" ]]; then
    echo "local only"
  elif [[ "$user_source" == "none" && "$project_source" == "local" ]]; then
    echo "local only"
  elif [[ "$user_source" == "github" && "$project_source" == "none" ]]; then
    echo "github only"
  elif [[ "$user_source" == "none" && "$project_source" == "github" ]]; then
    echo "github only"
  elif [[ "$user_source" == "$project_source" ]]; then
    echo "duplicate install detected"
  else
    echo "mixed install detected"
  fi
}

show_status() {
  echo "repo root:      $REPO_ROOT"
  echo "local source:   $LOCAL_SOURCE"
  echo "github source:  $REMOTE_SOURCE"
  echo "scope:          ${SCOPE_ARGS[*]:-(user settings)}"
  if [[ -f "$REPO_ROOT/.pi/settings.json" && ${#SCOPE_ARGS[@]} -eq 0 ]]; then
    echo "note:           .pi/settings.json exists in this repo; project packages override user installs"
    echo "                test-local/test-github will launch pi with --no-approve to ignore project-local settings"
  fi
  echo "doctor:        $(doctor)"
  echo
  pi list || true
}

launch_pi() {
  local pi_cmd=(pi)
  if [[ -f "$REPO_ROOT/.pi/settings.json" && ${#SCOPE_ARGS[@]} -eq 0 ]]; then
    pi_cmd+=(--no-approve)
  fi

  echo
  echo "Launching: ${pi_cmd[*]} ${PI_ARGS[*]}"
  echo "After startup, pick a kiro/* model (for example via /model) and test your prompt."
  echo
  exec "${pi_cmd[@]}" "${PI_ARGS[@]}"
}

case "$COMMAND" in
  status)
    show_status
    ;;
  doctor)
    doctor
    ;;
  use-local)
    install_local
    show_status
    ;;
  test-local)
    install_local
    launch_pi
    ;;
  use-github)
    install_github
    show_status
    ;;
  test-github)
    install_github
    launch_pi
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    echo "error: unknown command: $COMMAND" >&2
    echo >&2
    usage >&2
    exit 1
    ;;
esac
