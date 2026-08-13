#!/bin/sh
set -eu
java -jar /opt/odota-parser/parser.jar >/tmp/parser.log 2>&1 &
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:5600/healthz >/dev/null; then
    exec node /app/server.mjs
  fi
  sleep 1
done
cat /tmp/parser.log
exit 1
