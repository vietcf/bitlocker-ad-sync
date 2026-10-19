#!/usr/bin/env bash
# Dong goi ban cai OFFLINE cho may chu trong mang LAN khong co internet.
#
# Chay tren may CO internet, tu thu muc goc cua repo:
#   bash tools/build-offline.sh            # co image PostgreSQL (cach B: DB trong Docker)
#   bash tools/build-offline.sh --no-db    # bo image PostgreSQL (cach A: DB ngoai)
#
# Ket qua: dist/offline/blk-offline-<phien-ban>.tar.gz gom
#   images.tar.gz        cac image Docker (app, nginx, [postgres])
#   SHA256SUMS           kiem tra file sau khi chep
#   load.sh              nap image tren may chu
#   docker-compose.prod.yml, nginx/nginx.conf, server/.env.example, server/db.env.example,
#   cert/generate-self-signed.sh, INSTALL.txt
# Phien ban lay tu server/package.json; image app co tag blk-server:<phien-ban> va blk-server:latest.
set -euo pipefail

WITH_DB=1
[[ "${1:-}" == "--no-db" ]] && WITH_DB=0

cd "$(cd "$(dirname "$0")/.." && pwd)"
command -v docker >/dev/null || { echo "Can Docker tren may nay." >&2; exit 1; }
[[ -f docker-compose.prod.yml && -f server/package.json ]] || { echo "Chay tu thu muc goc cua repo." >&2; exit 1; }

VERSION="$(sed -n 's/^  "version": "\(.*\)",/\1/p' server/package.json | head -1)"
[[ -n "$VERSION" ]] || { echo "Khong doc duoc version trong server/package.json" >&2; exit 1; }
export BLK_VERSION="$VERSION"
COMPOSE=(docker compose -f docker-compose.prod.yml)
echo "== Phien ban $VERSION =="

echo "== Build image app =="
"${COMPOSE[@]}" build
docker tag "blk-server:$VERSION" blk-server:latest

if [[ $WITH_DB -eq 1 ]]; then echo "== Tai image nginx va postgres =="; else echo "== Tai image nginx =="; fi
IMAGES=("blk-server:$VERSION" "blk-server:latest")
# Co san tren may thi dung luon; chua co thi tai (thu lai 3 lan neu mang chap chon).
ensure_image() {
  docker image inspect "$1" >/dev/null 2>&1 && return 0
  for try in 1 2 3; do docker pull "$1" && return 0; echo "Tai $1 loi, thu lai ($try/3)..." >&2; sleep 5; done
  echo "Khong tai duoc $1." >&2; return 1
}
# Danh sach image ben ngoai lay tu chinh file compose, de luon khop phien ban dang dung.
while IFS= read -r img; do
  case "$img" in
    blk-server:*) ;;
    postgres:*) [[ $WITH_DB -eq 1 ]] || continue; ensure_image "$img"; IMAGES+=("$img") ;;
    *) ensure_image "$img"; IMAGES+=("$img") ;;
  esac
done < <("${COMPOSE[@]}" --profile db config --images | sort -u)

OUT="dist/offline"
STAGE="$OUT/blk-offline-$VERSION"
rm -rf "$STAGE" && mkdir -p "$STAGE/nginx" "$STAGE/server" "$STAGE/cert"

echo "== Luu image: ${IMAGES[*]} =="
docker save "${IMAGES[@]}" | gzip -6 > "$STAGE/images.tar.gz"

cp docker-compose.prod.yml "$STAGE/"
cp nginx/nginx.conf "$STAGE/nginx/"
cp server/.env.example "$STAGE/server/"
# DB trong Docker: mau mat khau va script tao tai khoan o lan khoi tao dau (server/db/init)
if [[ $WITH_DB -eq 1 ]]; then
  cp server/db.env.example "$STAGE/server/"
  mkdir -p "$STAGE/server/db" && cp -r server/db/init "$STAGE/server/db/"
fi
cp cert/generate-self-signed.sh "$STAGE/cert/"
cp tools/offline-load.sh "$STAGE/load.sh"
cp tools/install.sh "$STAGE/install.sh"
cp CHANGELOG.md README.md "$STAGE/"

cat > "$STAGE/INSTALL.txt" <<EOF
BitLocker Key Management $VERSION - cai offline

1. Chep ca thu muc nay len may chu (USB, scp...). Giai nen: tar xzf blk-offline-$VERSION.tar.gz
2. Trong thu muc vua giai nen:   bash load.sh        (kiem tra SHA-256 roi nap image vao Docker)
3. Cai dat (hoi vai thong tin, tao server/.env dung, tao chung chi tu ky tam neu chua co, khoi dong):
     DB trong Docker:    bash install.sh --db docker
     DB ngoai:           bash install.sh --db external      (da tao DB blk, blk_owner, app_node theo README.md muc 3.2)
   Muon dung chung chi that: dat server.crt va server.key vao cert/ truoc khi chay. Xem: bash install.sh --help
Cap nhat ban moi: giai nen goi moi, chay load.sh, chay lai install.sh --db ... --up (khoa cu duoc giu, migration tu chay).
Rollback: nap goi cu roi: BLK_VERSION=<ban-cu> docker compose -f docker-compose.prod.yml up -d --no-build
EOF

( cd "$STAGE" && sha256sum images.tar.gz load.sh install.sh docker-compose.prod.yml nginx/nginx.conf > SHA256SUMS )

TAR="$OUT/blk-offline-$VERSION.tar.gz"
tar -C "$OUT" -czf "$TAR" "blk-offline-$VERSION"
( cd "$OUT" && sha256sum "blk-offline-$VERSION.tar.gz" > "blk-offline-$VERSION.tar.gz.sha256" )

echo
echo "Xong: $TAR ($(du -h "$TAR" | cut -f1))"
echo "SHA-256: $(cut -d' ' -f1 "$OUT/blk-offline-$VERSION.tar.gz.sha256")"
echo "Chep file .tar.gz sang may chu LAN va lam theo INSTALL.txt trong goi."
