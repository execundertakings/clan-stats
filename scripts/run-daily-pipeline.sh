#!/bin/bash
# run-daily-pipeline.sh
# Loads .env then runs daily_clan.js. Invoked by the internal launcher
# (~/Library/Application Support/clan-stats/launch-daily-pipeline.sh) that
# com.greg.clan-daily-pipeline.plist calls at 5:00am daily — the launcher waits
# for this (external) project volume to mount before calling this script.

set -a
# shellcheck disable=SC1091
source "/Users/jean/Documents/projects/Clan stats page/.env" 2>/dev/null
set +a

exec /opt/homebrew/bin/node "/Users/jean/Documents/projects/Clan stats page/scripts/daily_clan.js"
