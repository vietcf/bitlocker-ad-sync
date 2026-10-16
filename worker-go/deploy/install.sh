#!/usr/bin/env bash
# Installs or updates blk-sync on a systemd Linux host. Run as root from the folder holding the
# built binary (blk-sync), this script, blk-sync.service and config.example.json.
#
#   sudo ./install.sh            first install: user, folders, unit; then edit the config and secrets
#   sudo ./install.sh --update   replace the binary, check the config, restart (rolls back on failure)
set -euo pipefail

BIN_DIR=/opt/blk-sync
ETC_DIR=/etc/blk-sync
HERE="$(cd "$(dirname "$0")" && pwd)"
NEW_BIN="$HERE/blk-sync"

[[ $EUID -eq 0 ]] || { echo "Run as root (sudo)." >&2; exit 1; }
[[ -x "$NEW_BIN" ]] || { echo "Binary not found: $NEW_BIN (build it with: make linux)" >&2; exit 1; }

if [[ "${1:-}" == "--update" ]]; then
  echo "Updating blk-sync to $("$NEW_BIN" version)"
  # Check the new binary against the current config before touching the service.
  if ! "$NEW_BIN" --config "$ETC_DIR/config.json" check; then
    echo "check failed with the new version: nothing changed." >&2
    exit 1
  fi
  systemctl stop blk-sync
  cp -p "$BIN_DIR/blk-sync" "$BIN_DIR/blk-sync.previous"
  install -m 0755 "$NEW_BIN" "$BIN_DIR/blk-sync"
  systemctl start blk-sync
  sleep 5
  if ! systemctl is-active --quiet blk-sync; then
    echo "The service did not start: rolling back." >&2
    install -m 0755 "$BIN_DIR/blk-sync.previous" "$BIN_DIR/blk-sync"
    systemctl start blk-sync
    exit 1
  fi
  echo "Updated. Logs: journalctl -u blk-sync -f"
  exit 0
fi

id blk-sync &>/dev/null || useradd --system --no-create-home --shell /usr/sbin/nologin blk-sync
install -d -m 0755 "$BIN_DIR"
install -d -m 0750 -o root -g blk-sync "$ETC_DIR"
install -m 0755 "$NEW_BIN" "$BIN_DIR/blk-sync"
[[ -f "$HERE/README.md" ]] && install -m 0644 "$HERE/README.md" "$BIN_DIR/README.md"
if [[ ! -f "$ETC_DIR/config.json" ]]; then
  install -m 0640 -o root -g blk-sync "$HERE/config.example.json" "$ETC_DIR/config.json"
fi
install -m 0644 "$HERE/blk-sync.service" /etc/systemd/system/blk-sync.service
systemctl daemon-reload

cat <<'EOF'
Installed. Next:
  1. Edit /etc/blk-sync/config.json (servers, BaseDn, SearchBases, Username, BaseUrl).
  2. Store the secrets as encrypted systemd credentials (typed at a prompt, never on the command line):
       systemd-ask-password -n "AD password:"      | systemd-creds encrypt --name=ldap-password  - /etc/blk-sync/ldap-password.cred
       systemd-ask-password -n "Ingest API key:"   | systemd-creds encrypt --name=ingest-api-key - /etc/blk-sync/ingest-api-key.cred
  3. Test (runs with the same credentials as the service):
       systemd-run --pty --wait -p User=blk-sync -p LoadCredentialEncrypted=ldap-password:/etc/blk-sync/ldap-password.cred \
         -p LoadCredentialEncrypted=ingest-api-key:/etc/blk-sync/ingest-api-key.cred /opt/blk-sync/blk-sync --config /etc/blk-sync/config.json check
  4. Start:  systemctl enable --now blk-sync   and watch:  journalctl -u blk-sync -f
EOF
