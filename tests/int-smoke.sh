#!/usr/bin/env bash
# Smoke tests for pi-claude-bridge provider.
# Requires: pi CLI, Claude Code (for Agent SDK subprocess).
# Requires: CLAUDE_BRIDGE_TESTING_ALT_MODEL (e.g. "MiniMax-M2.7-highspeed")

source "$(dirname "$0")/lib/bash-setup.sh"

echo "=== smoke-test.sh ==="

setup_test_env "smoke-test"

ALT_MODEL=$(require_env CLAUDE_BRIDGE_TESTING_ALT_MODEL)

TIMEOUT=60
PASS=0
FAIL=0

trap kill_descendants EXIT

run() {
  local name="$1"; shift
  local slug=$(echo "$name" | tr ' :,' '-' | tr -cd '[:alnum:]-')
  local logfile="$LOGDIR/$slug.log"
  printf "%-50s " "$name"
  if output=$(timeout "$TIMEOUT" "$@" 2>&1); then
    echo "$output" > "$logfile"
    if [ -n "$output" ]; then
      echo "PASS"
      ((PASS++))
    else
      echo "FAIL (empty output)"
      echo "  Log: $logfile"
      ((FAIL++))
    fi
  else
    local rc=$?
    echo "${output:-}" > "$logfile" 2>/dev/null || true
    echo "FAIL (exit $rc)"
    echo "  Log: $logfile"
    ((FAIL++))
  fi
  kill_descendants
}

# --- Tests ---

run "provider: print mode responds" \
  pi --no-session -ne -e "$DIR" \
  --model "claude-bridge/claude-sonnet-4-6" \
  -p "Reply with just the word 'yes'"

run "provider: --provider flag works" \
  pi --no-session -ne -e "$DIR" \
  --provider claude-bridge \
  -p "Reply with just the word 'yes'"

run "provider: model list includes provider" \
  bash -c "pi --no-session -ne -e '$DIR' --list-models 2>&1 | grep claude-bridge"

# AskClaude only registers when a non-claude-bridge provider is active
run "tool: AskClaude registered" \
  bash -c "pi --no-session -ne -e '$DIR' --mode json --model '$ALT_MODEL' -p 'list your tools' 2>&1 | grep -q AskClaude && echo ok"

# AskClaude e2e: force a non-Claude model to call the tool and check for a tool result
run "tool: AskClaude responds" \
  bash -c "pi --no-session -ne -e '$DIR' --model '$ALT_MODEL' --mode json \
    -p 'Use the AskClaude tool with prompt=\"What is 2+2? Reply with just the number.\" and then tell me the answer.' 2>&1 \
    | grep -q '\"toolName\":\"AskClaude\"' && echo ok"

# systemPromptMode: "output-style" (spec: docs/2607072219_spec_output_styles.md §9.2).
# NOTE: setup_test_env does not isolate $HOME, so ensureOutputStyle writes into the
# REAL ~/.claude/output-styles/ on this machine. We snapshot mtimes beforehand and
# assert a pi-bridge-*.md file was written/touched, without deleting anything (GC
# handles stale files after 30 days idle). We also write a project .pi/claude-bridge.json
# for the duration of this case only, restoring/removing it afterward.
STYLES_DIR="$HOME/.claude/output-styles"
CONFIG_FILE="$DIR/.pi/claude-bridge.json"
CONFIG_BACKUP=""
if [ -f "$CONFIG_FILE" ]; then
  CONFIG_BACKUP=$(mktemp)
  cp "$CONFIG_FILE" "$CONFIG_BACKUP"
fi
restore_output_style_config() {
  if [ -n "$CONFIG_BACKUP" ]; then
    cp "$CONFIG_BACKUP" "$CONFIG_FILE"
    rm -f "$CONFIG_BACKUP"
    CONFIG_BACKUP=""
  else
    rm -f "$CONFIG_FILE"
  fi
}
trap 'restore_output_style_config; kill_descendants' EXIT

mkdir -p "$DIR/.pi"
cat > "$CONFIG_FILE" <<'EOF'
{"provider": {"systemPromptMode": "output-style"}}
EOF

STYLE_SNAPSHOT=$(mktemp)
if [ -d "$STYLES_DIR" ]; then
  for f in "$STYLES_DIR"/pi-bridge-*.md; do
    [ -e "$f" ] || continue
    printf '%s %s\n' "$(basename "$f")" "$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f")" >> "$STYLE_SNAPSHOT"
  done
fi

run "provider: output-style mode responds" \
  pi --no-session -ne -e "$DIR" \
  --model "claude-bridge/claude-sonnet-4-6" \
  -p "Reply with just the word 'yes'"

STYLE_CHECK_SCRIPT=$(mktemp)
cat > "$STYLE_CHECK_SCRIPT" <<EOF
#!/usr/bin/env bash
set -euo pipefail
styles_dir="$STYLES_DIR"
snapshot="$STYLE_SNAPSHOT"
[ -d "\$styles_dir" ] || exit 1
for f in "\$styles_dir"/pi-bridge-*.md; do
  [ -e "\$f" ] || continue
  name=\$(basename "\$f")
  new_mtime=\$(stat -c %Y "\$f" 2>/dev/null || stat -f %m "\$f")
  old_mtime=\$(awk -v n="\$name" '\$1==n{print \$2}' "\$snapshot")
  if [ -z "\$old_mtime" ] || [ "\$new_mtime" -gt "\$old_mtime" ]; then
    echo ok
    exit 0
  fi
done
exit 1
EOF
chmod +x "$STYLE_CHECK_SCRIPT"

run "provider: output-style file written/touched" bash "$STYLE_CHECK_SCRIPT"

restore_output_style_config
rm -f "$STYLE_SNAPSHOT" "$STYLE_CHECK_SCRIPT"
trap kill_descendants EXIT

# --- Summary ---

echo ""
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
