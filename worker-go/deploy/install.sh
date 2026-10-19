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
# systemd cu (CentOS/RHEL 7 la 219) khong co credential ma hoa (v250+) va StateDirectory (v235): dung ban unit
# rieng va bi mat trong file. Hai ban chay cung mot binary tinh, khong can cai them thu vien.
SD_VER="$(systemctl --version 2>/dev/null | awk 'NR==1 {print $2}')"
if [[ ! "$SD_VER" =~ ^[0-9]+$ ]] || (( SD_VER < 250 )); then
  LEGACY=1
  install -m 0644 "$HERE/blk-sync-legacy.service" /etc/systemd/system/blk-sync.service
  install -d -m 0750 -o blk-sync -g blk-sync /var/lib/blk-sync
else
  LEGACY=0
  install -m 0644 "$HERE/blk-sync.service" /etc/systemd/system/blk-sync.service
fi
systemctl daemon-reload

if (( LEGACY )); then
cat <<'EOF'
Installed (old systemd: using the legacy unit). Next:
  1. Edit /etc/blk-sync/config.json (servers, BaseDn, SearchBases, Username, BaseUrl) and set
       "Password": "file:/etc/blk-sync/ldap-password"     (in the Ldap section)
       "ApiKey":   "file:/etc/blk-sync/ingest-api-key"    (in the Ingest section)
  2. Store the secrets in files only the service user can read (typed at a prompt, not on the command line):
       read -rsp "AD password: " p; echo; (umask 077; printf '%s' "$p" > /etc/blk-sync/ldap-password); chown blk-sync:blk-sync /etc/blk-sync/ldap-password; unset p
       read -rsp "Ingest API key: " p; echo; (umask 077; printf '%s' "$p" > /etc/blk-sync/ingest-api-key); chown blk-sync:blk-sync /etc/blk-sync/ingest-api-key; unset p
  3. Test as the service user:
       sudo -u blk-sync /opt/blk-sync/blk-sync --config /etc/blk-sync/config.json check
  4. Start:  systemctl enable --now blk-sync   and watch:  journalctl -u blk-sync -f
EOF
exit 0
fi

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
