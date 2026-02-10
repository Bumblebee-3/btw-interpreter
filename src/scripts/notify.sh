#!/usr/bin/env bash
set -euo pipefail

title="${1:-Confirm}"
body="${2:-Proceed?}"

command -v zenity >/dev/null 2>&1 || {
  echo false
  exit 1
}

if zenity --question \
  --title="$title" \
  --text="$body" \
  --ok-label="Yes" \
  --cancel-label="No"; then
  echo true
  exit 0
fi

echo false
exit 1
