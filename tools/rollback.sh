#!/bin/bash
# Quay ve ban chay tot gan nhat (xem snapshot.sh): chay lai container server tu image `last-good`.
# Khong dung toi du lieu. Migration chi them (khong xoa), nen ban cu van chay tren DB moi.
# Ma nguon cu nam trong _last-good/server-src.tgz (giai nen neu can sua lai ma).
set -euo pipefail
cd "$(dirname "$0")/.."
docker image inspect bitlocker-management-server:last-good >/dev/null
docker tag bitlocker-management-server:last-good bitlocker-management-server:latest
docker compose up -d --no-build --no-deps server
echo "Da quay ve ban chay tot (server chay tu image last-good)."
