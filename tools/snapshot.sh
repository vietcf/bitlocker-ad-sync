#!/bin/bash
# Danh dau ban dang chay tot: gan nhan image `last-good` va luu ma nguon (da qua test) vao _last-good/.
# Chay truoc moi lan trien khai ban moi. Quay lai: bash tools/rollback.sh
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p _last-good
docker tag bitlocker-management-server:latest bitlocker-management-server:last-good
tar --exclude=node_modules --exclude=backups --exclude=.env -czf _last-good/server-src.tgz server worker-go/internal worker-go/cmd docker-compose.yml nginx
date -Iseconds > _last-good/saved-at.txt
echo "Da luu ban chay tot: $(cat _last-good/saved-at.txt)"
