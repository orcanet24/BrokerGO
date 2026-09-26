#!/usr/bin/env bash
# install-broker.sh — one-shot installer for a swarm VPS.
# Run as root on a fresh Debian/Ubuntu node. Requires the verified binary
# at /tmp/broker (from scp) and /tmp/broker.sha256.
set -euo pipefail

BIN_SRC=/tmp/broker
SUM_SRC=/tmp/broker.sha256
UNIT_SRC="$(dirname "$0")/broker.service"
ENV_SRC="$(dirname "$0")/broker.env.example"
TMPFILES_SRC="$(dirname "$0")/broker.tmpfiles.conf"

echo "[1/6] Verifying checksum..."
( cd /tmp && sha256sum -c broker.sha256 )

echo "[2/6] Creating user and dirs..."
id -u broker >/dev/null 2>&1 || useradd --system --home /var/lib/broker --shell /usr/sbin/nologin broker
mkdir -p /var/lib/broker /etc/broker /etc/broker/jwks
install -m 0755 "$BIN_SRC" /usr/local/bin/broker

echo "[3/6] Firewall (443 + SSH only)..."
if command -v ufw >/dev/null; then
  ufw default deny incoming
  ufw allow 22/tcp
  ufw allow 443/tcp
  ufw --force enable || true
fi

echo "[4/6] Config..."
if [[ ! -f /etc/broker/broker.env ]]; then
  install -m 0600 "$ENV_SRC" /etc/broker/broker.env
  echo "    EDIT /etc/broker/broker.env before starting!"
fi

echo "[5/6] systemd..."
install -m 0644 "$UNIT_SRC" /etc/systemd/system/broker.service
install -m 0644 "$TMPFILES_SRC" /etc/tmpfiles.d/broker.conf
systemd-tmpfiles --create
systemctl daemon-reload
systemctl enable broker

echo "[6/6] Done. Next steps:"
echo "  - edit /etc/broker/broker.env (domain, redis, jwt)"
echo "  - place JWKS public keys in /etc/broker/jwks/*.pub"
echo "  - place redis password in /etc/broker/redis.pass (0600)"
echo "  - systemctl start broker && journalctl -u broker -f"
echo "  - curl -fsS https://\$BROKER_ACME_DOMAIN/healthz"
