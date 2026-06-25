#!/bin/sh
set -e

# When piped from curl, $0 is "sh" — fetch the bridge script from the collector,
# then optionally wire up agent hooks. Everything stays on this machine.
COT_ENDPOINT="${COT_ENDPOINT:-http://localhost:31337}"
COT_HOME="${HOME}/.cot"
BIN_DIR="${COT_HOME}/bin"
TARGET="${BIN_DIR}/cot"
COT_VERSION="${COT_VERSION:-}"
REPAIR_MODE=0
REPAIR_SELECTION=""

resolve_version() {
  [ -n "${COT_VERSION}" ] && return 0
  json=$(curl -fsSL "${COT_ENDPOINT}/health" 2>/dev/null) || json=""
  COT_VERSION=$(printf '%s' "${json}" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)
  COT_VERSION="${COT_VERSION:-unknown}"
}

for arg in "$@"; do
  case "${arg}" in
    --repair) REPAIR_MODE=1 ;;
    *) REPAIR_SELECTION="${REPAIR_SELECTION} ${arg}" ;;
  esac
done

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_TTY=1
  C_RESET="$(printf '\033[0m')"
  C_BOLD="$(printf '\033[1m')"
  C_VERMILION="$(printf '\033[38;2;255;69;0m')"
  C_CLEAR="$(printf '\033[2K')"
else
  C_TTY=0
  C_RESET=""
  C_BOLD=""
  C_VERMILION=""
  C_CLEAR=""
fi

title() {
  printf '%s%s%s\n' "${C_VERMILION}${C_BOLD}" '    ' "${C_RESET}"
  printf '%s%s%s\n' "${C_VERMILION}${C_BOLD}" '┏┏┓╋' "${C_RESET}"
  printf '%s%s%s\n' "${C_VERMILION}${C_BOLD}" '┗┗┛┗' "${C_RESET}"
  printf '%s%s%s\n' "${C_VERMILION}${C_BOLD}" '    ' "${C_RESET}"
  if [ "${REPAIR_MODE}" = "1" ]; then
    printf '%s\n' "cot hook repair v${COT_VERSION}"
  else
    printf '%s\n' "cot bridge installer v${COT_VERSION}"
  fi
  printf '%s\n\n' "hooks for Claude Code | Cursor | Codex"
}

section() {
  printf '\n%s\n' "$1"
}

step() {
  printf '› %s\n' "$1"
}

ok() {
  printf '✓ %s\n' "$1"
}

warn() {
  printf '! %s\n' "$1"
}

fail() {
  printf 'x %s\n' "$1" >&2
}

details() {
  label="$1"
  body="$2"
  [ -n "${body}" ] || return 0
  printf '%s\n' "  ${label}" >&2
  printf '%s\n' "${body}" | while IFS= read -r line; do
    printf '    %s\n' "${line}" >&2
  done
}

ACTIVE_PID=""
ACTIVE_LOG=""
handle_interrupt() {
  trap - INT TERM
  [ "${C_TTY}" = "1" ] && printf '\r%s\r' "${C_CLEAR}" >&2
  if [ -n "${ACTIVE_PID}" ] && kill -0 "${ACTIVE_PID}" 2>/dev/null; then
    kill "${ACTIVE_PID}" 2>/dev/null || true
    wait "${ACTIVE_PID}" 2>/dev/null || true
  fi
  [ -n "${ACTIVE_LOG}" ] && rm -f "${ACTIVE_LOG}"
  printf '\n! Install interrupted by user.\n' >&2
  printf '%s\n' "  No further changes will be made by this run." >&2
  printf '%s\n' "  Re-run the installer when you are ready." >&2
  exit 130
}

trap handle_interrupt INT TERM

table_line() {
  printf '  %s\n' "+--------------+--------------------------------------------------------------+"
}

table_row() {
  printf '  | %-12s | %-60.60s |\n' "$1" "$2"
}

summary_table() {
  table_line
  table_row "Version" "${COT_VERSION}"
  table_row "Endpoint" "${COT_ENDPOINT}"
  table_row "Bridge" "${TARGET}"
  if [ "${REPAIR_MODE}" = "1" ]; then
    table_row "Mode" "repair"
    table_row "Agents" "${REPAIR_SELECTION:-${COT_AGENTS:-all}}"
  else
    table_row "Agents" "${COT_AGENTS:-interactive}"
  fi
  table_line
}

spinner_frame() {
  case "$1" in
    0) printf '-' ;;
    1) printf '\\' ;;
    2) printf '|' ;;
    *) printf '/' ;;
  esac
}

RUN_OUTPUT=""
RUN_COUNT=0
run_spinner() {
  label="$1"
  shift
  log="${TMPDIR:-/tmp}/cot-install.$$.$RUN_COUNT.log"
  RUN_COUNT=$((RUN_COUNT + 1))
  ACTIVE_LOG="${log}"
  [ "${C_TTY}" = "1" ] || step "${label}"
  set +e
  "$@" >"${log}" 2>&1 &
  pid=$!
  ACTIVE_PID="${pid}"
  i=0
  if [ "${C_TTY}" = "1" ]; then
    while kill -0 "${pid}" 2>/dev/null; do
      frame=$(spinner_frame "${i}")
      printf '\r%s %s' "${frame}" "${label}"
      i=$(( (i + 1) % 4 ))
      sleep 0.12
    done
  fi
  wait "${pid}"
  code=$?
  ACTIVE_PID=""
  set -e
  [ "${C_TTY}" = "1" ] && printf '\r%s\r' "${C_CLEAR}"
  RUN_OUTPUT=$(cat "${log}" 2>/dev/null)
  rm -f "${log}"
  ACTIVE_LOG=""
  return "${code}"
}

resolve_version
title
summary_table

# 1. Download the bridge.
section "Bridge"
# Docker's bind-mount (docker-compose.yml) may have created ~/.cot as root
# before the user runs this script. Reclaim ownership so mkdir/writes succeed.
if [ -d "${COT_HOME}" ] && [ ! -w "${COT_HOME}" ]; then
  step "Fixing ownership of ${COT_HOME}"
  sudo chown -R "${USER}:${USER}" "${COT_HOME}" 2>/dev/null || {
    fail "${COT_HOME} exists but is not writable (Docker may have created it as root)."
    printf '%s\n' "  Run: sudo chown -R \$(id -u):\$(id -g) ${COT_HOME}"
    exit 1
  }
fi
if ! run_spinner "Preparing ${BIN_DIR}" mkdir -p "${BIN_DIR}"; then
  fail "Could not create ${BIN_DIR}."
  details "Error found" "${RUN_OUTPUT}"
  exit 1
fi
if ! run_spinner "Downloading bridge from ${COT_ENDPOINT}" curl -fsSL "${COT_ENDPOINT}/cot" -o "${TARGET}"; then
  fail "Could not download cot bridge."
  details "Error found" "${RUN_OUTPUT}"
  exit 1
fi
if ! run_spinner "Making bridge executable" chmod +x "${TARGET}"; then
  fail "Could not make ${TARGET} executable."
  details "Error found" "${RUN_OUTPUT}"
  exit 1
fi
ok "Bridge installed to ${TARGET}"

# Persist the endpoint so hooks reach this collector regardless of the
# environment the agent runs them in.
if ! config_output=$({ printf '{"endpoint": "%s"}\n' "${COT_ENDPOINT}" > "${COT_HOME}/config.json"; } 2>&1); then
  fail "Could not write ${COT_HOME}/config.json."
  details "Error found" "${config_output}"
  exit 1
fi
ok "Endpoint saved to ${COT_HOME}/config.json"

# 2. Decide which agents to wire up. COT_AGENTS skips the prompt (handy for CI),
#    otherwise ask interactively over the controlling terminal — stdin is busy
#    carrying this script from the curl pipe.
if [ "${REPAIR_MODE}" = "1" ]; then
  SELECTION="${REPAIR_SELECTION:-${COT_AGENTS:-all}}"
else
  SELECTION="${COT_AGENTS:-}"
fi
if [ -z "${SELECTION}" ]; then
  if [ -r /dev/tty ]; then
    section "Choose Agents"
    printf '%s\n' "  1) claude   Claude Code   ~/.claude/settings.json"
    printf '%s\n' "  2) cursor   Cursor        ~/.cursor/hooks.json"
    printf '%s\n' "  3) codex    Codex         ~/.codex/hooks.json"
    echo ""
    printf "Enter names/numbers (space-separated), 'all', or 'none' [all]: "
    read -r SELECTION < /dev/tty || SELECTION=""
    [ -z "${SELECTION}" ] && SELECTION="all"
  else
    SELECTION="none"
    echo ""
    warn "Non-interactive shell; skipping hook setup"
    printf '%s\n' "  Re-run with COT_AGENTS=\"claude cursor codex\" to wire up hooks,"
    printf '%s\n' "  or run: ${TARGET} install"
  fi
fi

# Resolve the selection into a clean list of agent ids.
AGENTS=""
case " ${SELECTION} " in
  *" none "*|*" None "*|*" NONE "*) AGENTS="" ;;
  *" all "*|*" All "*|*" ALL "*)    AGENTS="claude cursor codex" ;;
  *)
    for token in ${SELECTION}; do
      case "${token}" in
        1|claude|Claude|CLAUDE) AGENTS="${AGENTS} claude" ;;
        2|cursor|Cursor|CURSOR) AGENTS="${AGENTS} cursor" ;;
        3|codex|Codex|CODEX)    AGENTS="${AGENTS} codex" ;;
      esac
    done
    ;;
esac

# 3. Install hooks for the chosen agents.
if [ -n "${AGENTS}" ]; then
  section "Agent Hooks"
  if [ "${REPAIR_MODE}" = "1" ]; then
    HOOK_LABEL="Repairing hooks for:${AGENTS}"
    HOOK_ENV="COT_REPAIR=1"
  else
    HOOK_LABEL="Wiring hooks for:${AGENTS}"
    HOOK_ENV="COT_REPAIR=0"
  fi
  if run_spinner "${HOOK_LABEL}" env COT_ENDPOINT="${COT_ENDPOINT}" ${HOOK_ENV} "${TARGET}" install ${AGENTS}; then
    [ -z "${RUN_OUTPUT}" ] || printf '%s\n' "${RUN_OUTPUT}"
  else
    fail "Could not wire agent hooks."
    details "Error found" "${RUN_OUTPUT}"
    exit 1
  fi
fi

if [ "${REPAIR_MODE}" = "1" ]; then
  section "Complete"
  ok "cot hooks repaired"
  table_line
  table_row "Dashboard" "${COT_ENDPOINT}"
  table_row "Status" "Refresh Settings"
  table_line
  exit 0
fi

# 4. Make `cot` available on the PATH for interactive use.
section "Shell Setup"
PATH_LINE="export PATH=\"\${HOME}/.cot/bin:\${PATH}\""
case "${SHELL##*/}" in
  zsh)  PROFILE="${HOME}/.zshrc" ;;
  bash) PROFILE="${HOME}/.bashrc" ;;
  *)    PROFILE="${HOME}/.profile" ;;
esac
if [ -f "${PROFILE}" ] && grep -qs ".cot/bin" "${PROFILE}"; then
  ok "~/.cot/bin is already on PATH in ${PROFILE}"
else
  if ! path_output=$({ printf '\n# cot bridge\n%s\n' "${PATH_LINE}" >> "${PROFILE}"; } 2>&1); then
    fail "Could not update ${PROFILE}."
    details "Error found" "${path_output}"
    exit 1
  fi
  echo ""
  ok "Added ~/.cot/bin to your PATH in ${PROFILE}"
  printf '%s\n' "  Open a new shell or run: ${PATH_LINE}"
fi

section "Complete"
ok "cot is wired up"
table_line
table_row "Dashboard" "${COT_ENDPOINT}"
table_row "Status" "${TARGET} status"
table_line
