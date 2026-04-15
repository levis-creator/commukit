#!/bin/sh
# Janus entrypoint — injects NAT/STUN/TLS settings into config files before starting.
set -e

CONFIG="/usr/local/etc/janus/janus.jcfg"
WS_CONFIG="/usr/local/etc/janus/janus.transport.websockets.jcfg"
HTTP_CONFIG="/usr/local/etc/janus/janus.transport.http.jcfg"

TMP=$(mktemp)
cp "$CONFIG" "$TMP"

# ── STUN ─────────────────────────────────────────────────────────────────────
if [ -n "$JANUS_STUN_SERVER" ]; then
  sed -i "s|##STUN_SERVER##|stun_server = \"$JANUS_STUN_SERVER\"|" "$TMP"
else
  sed -i "s|##STUN_SERVER##||" "$TMP"
fi

if [ -n "$JANUS_STUN_PORT" ]; then
  sed -i "s|##STUN_PORT##|stun_port = $JANUS_STUN_PORT|" "$TMP"
else
  sed -i "s|##STUN_PORT##||" "$TMP"
fi

# ── NAT ───────────────────────────────────────────────────────────────────────
if [ -n "$JANUS_NAT_1_1" ]; then
  sed -i "s|##NAT_1_1_MAPPING##|nat_1_1_mapping = \"$JANUS_NAT_1_1\"|" "$TMP"
else
  sed -i "s|##NAT_1_1_MAPPING##||" "$TMP"
fi

# ── TURN ──────────────────────────────────────────────────────────────────────
if [ -n "$JANUS_TURN_SERVER" ]; then
  sed -i "s|##TURN_SERVER##|turn_server = \"$JANUS_TURN_SERVER\"|" "$TMP"
  sed -i "s|##TURN_PORT##|turn_port = ${JANUS_TURN_PORT:-3478}|" "$TMP"
  sed -i "s|##TURN_TYPE##|turn_type = \"${JANUS_TURN_TYPE:-udp}\"|" "$TMP"
  sed -i "s|##TURN_USER##|turn_user = \"${JANUS_TURN_USER:-}\"|" "$TMP"
  sed -i "s|##TURN_PWD##|turn_pwd = \"${JANUS_TURN_PWD:-}\"|" "$TMP"
else
  sed -i "s|##TURN_SERVER##||;s|##TURN_PORT##||;s|##TURN_TYPE##||;s|##TURN_USER##||;s|##TURN_PWD##||" "$TMP"
fi

# ── TLS certificates ──────────────────────────────────────────────────────────
# Set JANUS_CERT_PEM and JANUS_CERT_KEY to the paths of your TLS certificate and
# private key files (mounted into the container). When both are provided:
#   • WSS is enabled on port 8989  (wss://<host>:8989/janus)
#   • HTTPS is enabled on port 8089 (https://<host>:8089/janus)
# Plain WS (8188) and HTTP (8088) remain active for internal backend calls.
if [ -n "$JANUS_CERT_PEM" ] && [ -n "$JANUS_CERT_KEY" ]; then
  echo "[entrypoint] TLS certs found — enabling WSS (8989) and HTTPS (8089)"
  sed -i "s|##JANUS_CERT_PEM##|cert_pem = \"$JANUS_CERT_PEM\"|" "$TMP"
  sed -i "s|##JANUS_CERT_KEY##|cert_key = \"$JANUS_CERT_KEY\"|" "$TMP"

  TMP_WS=$(mktemp)
  cp "$WS_CONFIG" "$TMP_WS"
  sed -i "s|##JANUS_WSS_ENABLED##|wss = true|" "$TMP_WS"
  sed -i "s|##JANUS_WSS_PORT##|wss_port = 8989|" "$TMP_WS"
  cp "$TMP_WS" "$WS_CONFIG"
  rm -f "$TMP_WS"

  TMP_HTTP=$(mktemp)
  cp "$HTTP_CONFIG" "$TMP_HTTP"
  sed -i "s|##JANUS_HTTPS_ENABLED##|https = true|" "$TMP_HTTP"
  sed -i "s|##JANUS_HTTPS_PORT##|https_port = 8089|" "$TMP_HTTP"
  cp "$TMP_HTTP" "$HTTP_CONFIG"
  rm -f "$TMP_HTTP"
else
  echo "[entrypoint] JANUS_CERT_PEM/KEY not set — WSS and HTTPS disabled (plain WS/HTTP only)"
  sed -i "s|##JANUS_CERT_PEM##||;s|##JANUS_CERT_KEY##||" "$TMP"

  TMP_WS=$(mktemp)
  cp "$WS_CONFIG" "$TMP_WS"
  sed -i "s|##JANUS_WSS_ENABLED##|wss = false|" "$TMP_WS"
  sed -i "s|##JANUS_WSS_PORT##||" "$TMP_WS"
  cp "$TMP_WS" "$WS_CONFIG"
  rm -f "$TMP_WS"

  TMP_HTTP=$(mktemp)
  cp "$HTTP_CONFIG" "$TMP_HTTP"
  sed -i "s|##JANUS_HTTPS_ENABLED##|https = false|" "$TMP_HTTP"
  sed -i "s|##JANUS_HTTPS_PORT##||" "$TMP_HTTP"
  cp "$TMP_HTTP" "$HTTP_CONFIG"
  rm -f "$TMP_HTTP"
fi

cp "$TMP" "$CONFIG"
rm -f "$TMP"

exec /usr/local/bin/janus "$@"
