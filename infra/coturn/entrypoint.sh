#!/bin/sh
set -e

CONFIG="/etc/coturn/turnserver.conf"
TMP=$(mktemp)
cp "$CONFIG" "$TMP"

sed -i "s|##TURN_USERNAME##|${TURN_USERNAME:-comms}|" "$TMP"
sed -i "s|##TURN_PASSWORD##|${TURN_PASSWORD:-change-me-turn-password}|" "$TMP"
sed -i "s|##TURN_REALM##|${TURN_REALM:-comms.local}|" "$TMP"
sed -i "s|##TURN_MIN_PORT##|${TURN_MIN_PORT:-49160}|" "$TMP"
sed -i "s|##TURN_MAX_PORT##|${TURN_MAX_PORT:-49200}|" "$TMP"

if [ -n "$TURN_EXTERNAL_IP" ]; then
  sed -i "s|##TURN_EXTERNAL_IP##|external-ip=${TURN_EXTERNAL_IP}|" "$TMP"
else
  sed -i "s|##TURN_EXTERNAL_IP##||" "$TMP"
fi

cp "$TMP" "$CONFIG"
rm -f "$TMP"

exec turnserver -c "$CONFIG" --no-tls --no-dtls "$@"
