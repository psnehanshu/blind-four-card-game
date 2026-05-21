#!/bin/bash
# PID 1 for the runtime image. Starts the node game server on an internal
# port, then runs nginx in the foreground. If either dies the container
# exits, so Docker's restart policy can take over.
set -euo pipefail

GAME_SERVER_PORT="${GAME_SERVER_PORT:-3001}"
SERVER_ENTRY="${SERVER_ENTRY:-/app/dist/server/index.js}"

PORT="${GAME_SERVER_PORT}" node "${SERVER_ENTRY}" &
NODE_PID=$!

nginx -g 'daemon off;' &
NGINX_PID=$!

term() {
  kill -TERM "${NODE_PID}"  2>/dev/null || true
  kill -TERM "${NGINX_PID}" 2>/dev/null || true
}
trap term INT TERM

# Exit when either child exits (busybox ash supports `wait -n`).
wait -n
status=$?
term
wait || true
exit "${status}"
