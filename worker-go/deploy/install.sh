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

# systemd cu (CentOS/RHEL 7 la 219) khong co credential ma hoa (v250+) va StateDirectory (v235): dung ban unit
# rieng va bi mat trong file. Hai ban chay cung mot binary tinh, khong can cai them thu vien.
SD_VER="$(systemctl --version 2>/dev/null | awk 'NR==1 {print $2}')"
if [[ ! "$SD_VER" =~ ^[0-9]+$ ]] || (( SD_VER < 250 )); then LEGACY=1; UNIT_SRC="$HERE/blk-sync-legacy.service"; else LEGACY=0; UNIT_SRC="$HERE/blk-sync.service"; fi

# Thu muc trang thai: neu thieu, worker khong luu duoc moc USN va moi luot deu chay full. Tao ca khi cap nhat.
ensure_state_dir() {
  id blk-sync &>/dev/null || return 0
  install -d -m 0750 -o blk-sync -g blk-sync /var/lib/blk-sync
}

# Cap nhat unit neu ban trong goi khac ban dang cai (ban cu duoc giu lai thanh .previous).
refresh_unit() {
  local dest=/etc/systemd/system/blk-sync.service
  [[ -f "$UNIT_SRC" ]] || return 0
  if [[ -f "$dest" ]] && cmp -s "$UNIT_SRC" "$dest"; then return 0; fi
  [[ -f "$dest" ]] && cp -p "$dest" "$dest.previous"
  install -m 0644 "$UNIT_SRC" "$dest"
  systemctl daemon-reload
  echo "Unit updated ($( (( LEGACY )) && echo 'legacy, for old systemd' || echo 'standard' )); previous copy: $dest.previous"
}

if [[ "${1:-}" == "--update" ]]; then
  echo "Updating blk-sync to $("$NEW_BIN" version)"
  ensure_state_dir
  # Check the new binary against the current config before touching the service.
  if ! "$NEW_BIN" --config "$ETC_DIR/config.json" check; then
    echo "check failed with the new version: nothing changed." >&2
    exit 1
  fi
  systemctl stop blk-sync
  cp -p "$BIN_DIR/blk-sync" "$BIN_DIR/blk-sync.previous"
  install -m 0755 "$NEW_BIN" "$BIN_DIR/blk-sync"
  refresh_unit
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
install -m 0644 "$UNIT_SRC" /etc/systemd/system/blk-sync.service
ensure_state_dir
systemctl daemon-reload

cat <<'EOF'
Installed$( (( LEGACY )) && echo ' (old systemd: using the legacy unit)' || true). Next:
  1. Edit /etc/blk-sync/config.json: servers, BaseDn, SearchBases, Username, Password (AD password),
     BaseUrl and ApiKey (INGEST_API_KEY of the server). The secrets are written straight into this file;
     it is readable only by root and the service user (mode 0640).
  2. Test as the service user:
       sudo -u blk-sync /opt/blk-sync/blk-sync --config /etc/blk-sync/config.json check
  3. Start:  systemctl enable --now blk-sync   and watch:  journalctl -u blk-sync -f
EOF
