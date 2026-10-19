#!/usr/bin/env bash
# Chay tren MAY CHU (khong can internet), trong thu muc da giai nen goi offline:
#   bash load.sh
# Kiem tra SHA-256 cua cac file, roi nap image vao Docker.
# (Script nay nam trong goi do tools/build-offline.sh tao ra, duoi ten load.sh.)
set -euo pipefail
cd "$(dirname "$0")"

command -v docker >/dev/null || { echo "Chua cai Docker tren may nay." >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Can Docker Compose v2 (lenh 'docker compose')." >&2; exit 1; }

echo "== Kiem tra SHA-256 =="
sha256sum -c SHA256SUMS

echo "== Nap image vao Docker (mat vai phut) =="
gunzip -c images.tar.gz | docker load

echo
echo "Da nap xong. Cac image BitLocker:"
docker image ls --format '  {{.Repository}}:{{.Tag}}  ({{.Size}})' | grep -E 'blk-server|nginx|postgres' || true
echo
echo "Tiep theo: tao server/.env (va server/db.env neu DB trong Docker), dat chung chi vao cert/, roi chay:"
echo "  docker compose -f docker-compose.prod.yml up -d --no-build"
echo "  (DB trong Docker: them --profile db)"
