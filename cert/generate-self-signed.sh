#!/usr/bin/env bash
# Tao chung chi TU KY cho moi truong dev / lab (KHONG dung cho production).
#   - ca.crt / ca.key        : CA noi bo cho dev (worker tin CA nay qua CaFile, trinh duyet co the import)
#   - server.crt / server.key: chung chi cua nginx, do CA tren ky, dung chung cho web (443) va ingest (8443)
#
# Chay tu thu muc goc cua repo:   bash cert/generate-self-signed.sh [ten-them ...]
# Vi du them ten may / IP:        bash cert/generate-self-signed.sh blk.example.local 192.168.11.10
# Mac dinh co: localhost, 127.0.0.1, blk.local, va ten may hien tai.
# Chay duoc voi OpenSSL tu 1.0.2 (CentOS/RHEL 7) tro len.
# Chay lai se tao chung chi server moi (giu CA cu neu da co, de worker / trinh duyet khong phai tin lai).
set -euo pipefail
export MSYS_NO_PATHCONV=1   # Git Bash tren Windows: khong doi "/CN=..." thanh duong dan

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
DAYS_CA=3650
DAYS_SERVER=825

names=(localhost blk.local "$(hostname | tr '[:upper:]' '[:lower:]')")
ips=(127.0.0.1)
for extra in "$@"; do
  if [[ "$extra" =~ ^[0-9.]+$ || "$extra" == *:* ]]; then ips+=("$extra"); else names+=("$extra"); fi
done

if [[ ! -f ca.key || ! -f ca.crt ]]; then
  echo "Tao CA dev (ca.crt, ca.key)..."
  # Dung file cau hinh thay cho -addext: OpenSSL cu (CentOS 7 / RHEL 7, ban 1.0.2) khong co -addext.
  cat > ca.cnf <<'EOF'
[req]
distinguished_name = dn
x509_extensions = ca_ext
prompt = no
[dn]
CN = BitLocker Key Mgmt DEV CA
[ca_ext]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
EOF
  openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days "$DAYS_CA" -keyout ca.key -out ca.crt -config ca.cnf
  rm -f ca.cnf
fi

san=""
i=1; for n in "${names[@]}"; do san+="DNS.$i = $n"$'\n'; i=$((i + 1)); done
i=1; for a in "${ips[@]}"; do san+="IP.$i = $a"$'\n'; i=$((i + 1)); done

cat > server.ext <<EOF
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt
[alt]
$san
EOF

echo "Tao chung chi server (server.crt, server.key) cho: ${names[*]} ${ips[*]}"
openssl req -new -newkey rsa:2048 -nodes -sha256 -keyout server.key -out server.csr -subj "/CN=${names[0]}"
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days "$DAYS_SERVER" -sha256 \
  -extfile server.ext -out server.crt
rm -f server.csr server.ext ca.srl
chmod 600 ca.key server.key 2>/dev/null || true

# Khong dung "x509 -ext" (OpenSSL < 1.1.1 khong co): doc SAN tu -text
openssl x509 -in server.crt -noout -subject -enddate
openssl x509 -in server.crt -noout -text | grep -A1 "Subject Alternative Name" || true
echo "Xong. Khoi dong lai nginx de nhan chung chi moi: docker compose restart nginx"
