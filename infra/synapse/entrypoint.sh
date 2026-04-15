#!/bin/sh
# Synapse entrypoint — injects env vars into homeserver.yaml before starting.
set -e

CONFIG="/conf/homeserver.yaml"
TMP=$(mktemp)
cp "$CONFIG" "$TMP"

sed -i "s|##MATRIX_SERVER_NAME##|${MATRIX_SERVER_NAME:-comms.local}|g" "$TMP"
sed -i "s|##MATRIX_REGISTRATION_SHARED_SECRET##|${MATRIX_REGISTRATION_SHARED_SECRET:-change-me-registration-secret}|g" "$TMP"

cp "$TMP" "$CONFIG"
rm -f "$TMP"

# Generate signing key if it doesn't exist
if [ ! -f /data/signing.key ]; then
  python -m synapse.app.homeserver --generate-keys -c "$CONFIG"
fi

exec python -m synapse.app.homeserver -c "$CONFIG"
