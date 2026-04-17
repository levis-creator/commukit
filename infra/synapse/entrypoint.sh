#!/bin/sh
# Synapse entrypoint — renders env vars into a runtime copy of
# homeserver.yaml. The source config is mounted read-only so placeholder
# values never leak back into the host on local runs.
set -e

SOURCE_CONFIG="/conf/homeserver.yaml"
RENDERED_CONFIG="/data/homeserver.rendered.yaml"

cp "$SOURCE_CONFIG" "$RENDERED_CONFIG"

sed -i "s|##MATRIX_SERVER_NAME##|${MATRIX_SERVER_NAME:-comms.local}|g" "$RENDERED_CONFIG"
sed -i "s|##MATRIX_REGISTRATION_SHARED_SECRET##|${MATRIX_REGISTRATION_SHARED_SECRET:-change-me-registration-secret}|g" "$RENDERED_CONFIG"

# Generate signing key if it doesn't exist
if [ ! -f /data/signing.key ]; then
  python -m synapse.app.homeserver --generate-keys -c "$RENDERED_CONFIG"
fi

exec python -m synapse.app.homeserver -c "$RENDERED_CONFIG"
