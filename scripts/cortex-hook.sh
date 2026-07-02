#!/usr/bin/env bash
# cortex-hook.sh — Auto-capture shell hooks for agentic-cortex.
#
# Source this in your ~/.bashrc or ~/.zshrc:
#   source /path/to/cortex-hook.sh
#
# Wraps common commands to auto-start sessions, record activity,
# and auto-save observations without explicit user invocations.
#
# Features:
#   - Auto-starts a session when entering a project directory (cd into dir with .git)
#   - Auto-ends session when leaving a project directory
#   - Records git, npm, yarn, pnpm, docker commands as observations
#   - Debounces rapid commands to avoid spam
#
# Environment:
#   CORTEX_AUTO_CAPTURE=1    Enable auto-capture (set to 0 to disable)
#   CORTEX_QUIET=1           Suppress hook messages to stderr

# ─── Guard: only source once ─────────────────────────────────────

if [ -n "$_CORTEX_HOOK_SOURCED" ]; then
  return 0 2>/dev/null || exit 0
fi
export _CORTEX_HOOK_SOURCED=1

# ─── Config ──────────────────────────────────────────────────────

: "${CORTEX_AUTO_CAPTURE:=1}"
: "${CORTEX_QUIET:=0}"

_cortex_log() {
  if [ "$CORTEX_QUIET" != "1" ]; then
    echo "[cortex]" "$@" >&2
  fi
}

# ─── Session tracking ─────────────────────────────────────────────

_CORTEX_ACTIVE_SESSION=""
_CORTEX_LAST_PROJECT=""

# Check if a directory is a project root (has .git or package.json)
_cortex_is_project() {
  [ -d "$1/.git" ] || [ -f "$1/package.json" ] || [ -f "$1/pyproject.toml" ] || [ -f "$1/Cargo.toml" ]
}

# Find the nearest project root walking up from a directory
_cortex_find_project() {
  local dir="$1"
  while [ "$dir" != "/" ] && [ "$dir" != "." ]; do
    if _cortex_is_project "$dir"; then
      echo "$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  return 1
}

# Start a session when entering a project
_cortex_enter_project() {
  if [ "$CORTEX_AUTO_CAPTURE" != "1" ]; then return; fi

  local project
  project="$(_cortex_find_project "$PWD")" || return

  if [ "$project" != "$_CORTEX_LAST_PROJECT" ]; then
    if [ -n "$_CORTEX_LAST_PROJECT" ] && [ -n "$_CORTEX_ACTIVE_SESSION" ]; then
      _cortex_end_session "$_CORTEX_LAST_PROJECT"
    fi
    _cortex_start_session "$project"
  fi
}

_cortex_start_session() {
  local project="$1"
  _cortex_log "Entering project: $project"
  if command -v agentic-cortex >/dev/null 2>&1; then
    local result
    # Set project via env var since session start doesn't support --project flag
    result="$(AGENTIC_CORTEX_PROJECT="$project" agentic-cortex session start "Auto-captured shell session in $(basename "$project")" 2>/dev/null)"
    if echo "$result" | grep -q '"session_id"'; then
      _CORTEX_ACTIVE_SESSION="$(echo "$result" | grep -o '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -o '"[^"]*"$' | tr -d '"')"
      export AGENTIC_CORTEX_SESSION="$_CORTEX_ACTIVE_SESSION"
      _CORTEX_LAST_PROJECT="$project"
      _cortex_log "Session started: $_CORTEX_ACTIVE_SESSION"
    fi
  fi
}

_cortex_end_session() {
  local project="$1"
  if [ -n "$_CORTEX_ACTIVE_SESSION" ]; then
    _cortex_log "Leaving project: $project"
    if command -v agentic-cortex >/dev/null 2>&1; then
      agentic-cortex session end --id "$_CORTEX_ACTIVE_SESSION" --summary "Shell session ended" >/dev/null 2>&1 || true
    fi
    _CORTEX_ACTIVE_SESSION=""
    _CORTEX_LAST_PROJECT=""
    unset AGENTIC_CORTEX_SESSION
  fi
}

# ─── Command capture ──────────────────────────────────────────────

# Commands worth recording (prefixes)
_CORTEX_TRACKED_COMMANDS="git npm yarn pnpm docker kubectl terraform make cargo go python3 python node npx"

_cortex_should_track() {
  local cmd="$1"
  local base
  base="${cmd%% *}"  # first word

  for prefix in $_CORTEX_TRACKED_COMMANDS; do
    if [ "$base" = "$prefix" ]; then
      return 0
    fi
  done
  return 1
}

_cortex_record_command() {
  if [ "$CORTEX_AUTO_CAPTURE" != "1" ]; then return; fi
  if [ -z "$_CORTEX_ACTIVE_SESSION" ]; then return; fi

  local cmd="$1"
  local exit_code="${2:-0}"

  # Skip empty or very short commands
  if [ -z "$cmd" ] || [ ${#cmd} -lt 3 ]; then return; fi

  if _cortex_should_track "$cmd"; then
    local status="succeeded"
    if [ "$exit_code" != "0" ]; then status="failed (exit $exit_code)"; fi

    # Run save in background to avoid blocking the shell
    (
      agentic-cortex save "Shell: ${cmd%% *}" "Ran: \`$cmd\` — $status" \
        --type event \
        --importance 3 \
        --tags "auto-capture,shell,${cmd%% *}" \
        --project "${_CORTEX_LAST_PROJECT:-$PWD}" \
        --session "${_CORTEX_ACTIVE_SESSION}" \
        >/dev/null 2>&1 || true
    ) &
  fi
}

# ─── Hook into shell ──────────────────────────────────────────────

# Store the last command and exit code for post-exec capture
_CORTEX_LAST_CMD=""
_CORTEX_LAST_EXIT=0

# Pre-exec: capture the command that's about to run
if [ -n "$BASH_VERSION" ]; then
  # Bash: use DEBUG trap
  _cortex_preexec() {
    _CORTEX_LAST_CMD="$BASH_COMMAND"
  }
  trap '_cortex_preexec' DEBUG

  # Post-exec: after command completes
  _cortex_postexec() {
    local exit_code=$?
    # Skip our own internal commands
    case "$_CORTEX_LAST_CMD" in
      _cortex_*|agentic-cortex*) return ;;
    esac
    _cortex_record_command "$_CORTEX_LAST_CMD" "$exit_code"
    _CORTEX_LAST_EXIT=$exit_code
  }
  PROMPT_COMMAND="_cortex_postexec${PROMPT_COMMAND:+;$PROMPT_COMMAND}"

elif [ -n "$ZSH_VERSION" ]; then
  # Zsh: use preexec and precmd hooks
  _cortex_preexec() {
    _CORTEX_LAST_CMD="$1"
  }
  _cortex_precmd() {
    local exit_code=$?
    case "$_CORTEX_LAST_CMD" in
      _cortex_*|agentic-cortex*) return ;;
    esac
    _cortex_record_command "$_CORTEX_LAST_CMD" "$exit_code"
    _CORTEX_LAST_EXIT=$exit_code
  }

  autoload -Uz add-zsh-hook 2>/dev/null
  if [ $? -eq 0 ]; then
    add-zsh-hook preexec _cortex_preexec
    add-zsh-hook precmd _cortex_precmd
  fi
fi

# ─── cd override: detect project enter/leave ──────────────────────

_cortex_cd() {
  builtin cd "$@" || return $?
  _cortex_enter_project
}

# Alias cd to our wrapper
alias cd='_cortex_cd'

# Check current directory on shell startup
_cortex_enter_project

# ─── Manual commands ──────────────────────────────────────────────

# cortex-save: manually save an observation from the shell
cortex-save() {
  if [ "$#" -lt 2 ]; then
    echo "Usage: cortex-save <title> <content>" >&2
    return 1
  fi
  local title="$1"; shift
  local content="$*"
  agentic-cortex save "$title" "$content" \
    --type observation \
    --importance 5 \
    --provenance observed \
    --tags "manual,shell" \
    --project "${_CORTEX_LAST_PROJECT:-$PWD}" \
    --session "${_CORTEX_ACTIVE_SESSION:-}"
}

# cortex-status: show current auto-capture status
cortex-status() {
  echo "agentic-cortex auto-capture status:"
  echo "  Auto-capture: ${CORTEX_AUTO_CAPTURE}"
  echo "  Active session: ${_CORTEX_ACTIVE_SESSION:-none}"
  echo "  Current project: ${_CORTEX_LAST_PROJECT:-none}"
}

# cortex-on / cortex-off: toggle auto-capture
cortex-on() {
  export CORTEX_AUTO_CAPTURE=1
  _cortex_log "Auto-capture ENABLED"
}
cortex-off() {
  export CORTEX_AUTO_CAPTURE=0
  _cortex_log "Auto-capture DISABLED"
}

_cortex_log "Shell hooks loaded. Auto-capture: $([ "$CORTEX_AUTO_CAPTURE" = "1" ] && echo 'ON' || echo 'OFF')"
_cortex_log "Commands: cortex-save, cortex-status, cortex-on, cortex-off"
