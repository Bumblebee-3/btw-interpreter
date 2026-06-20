#!/usr/bin/env bash
set -euo pipefail

title="${1:-Bumblebee Reminder}"
body="${2:-You have a reminder.}"
allowed_options_raw="${3:-}"

default_options=("snooze_5m" "snooze_10m" "snooze_1h" "snooze_1d" "snooze_1w")
allowed_options=()

if [[ -n "$allowed_options_raw" ]]; then
  IFS=',' read -r -a allowed_options <<< "$allowed_options_raw"
fi

if [[ ${#allowed_options[@]} -eq 0 ]]; then
  allowed_options=("${default_options[@]}")
fi

zenity_rows=()
for option in "${allowed_options[@]}"; do
  case "$option" in
    "snooze_5m")
      zenity_rows+=(FALSE "Remind in 5 minutes")
      ;;
    "snooze_10m")
      zenity_rows+=(FALSE "Remind in 10 minutes")
      ;;
    "snooze_1h")
      zenity_rows+=(FALSE "Remind in 1 hour")
      ;;
    "snooze_1d")
      zenity_rows+=(FALSE "Remind in 1 day")
      ;;
    "snooze_1w")
      zenity_rows+=(FALSE "Remind in 1 week")
      ;;
  esac
done

if [[ ${#zenity_rows[@]} -eq 0 ]]; then
  zenity_rows+=(FALSE "Remind in 10 minutes")
fi

if ! command -v zenity >/dev/null 2>&1; then
  echo dismiss
  exit 0
fi

choice=""
if ! choice=$(zenity --list \
  --radiolist \
  --title="$title" \
  --text="$body" \
  --width=480 \
  --height=320 \
  --column="" --column="Action" \
  TRUE "Do not show again" \
  "${zenity_rows[@]}" \
  --ok-label="Apply" \
  --cancel-label="Dismiss"); then
  echo dismiss
  exit 0
fi

case "$choice" in
  "Do not show again")
    echo dismiss
    ;;
  "Remind in 5 minutes")
    echo snooze_5m
    ;;
  "Remind in 10 minutes")
    echo snooze_10m
    ;;
  "Remind in 1 hour")
    echo snooze_1h
    ;;
  "Remind in 1 day")
    echo snooze_1d
    ;;
  "Remind in 1 week")
    echo snooze_1w
    ;;
  *)
    echo dismiss
    ;;
esac
