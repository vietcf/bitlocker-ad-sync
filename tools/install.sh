#!/usr/bin/env bash
# Cai dat production bang Docker Compose: tao server/.env (va server/db.env neu DB trong Docker) voi gia tri DUNG,
# kiem tra, roi (tuy chon) khoi dong. Chay lai duoc nhieu lan:
#   - DB trong Docker, da co data/postgres: canh bao va THOAT (khong dong vao cau hinh hay database dang dung);
#     them --update de giu cau hinh va chi cap nhat / khoi dong lai.
#   - Chua co data/postgres: dung container cu cua project (neu con), xoa cau hinh cu (server/.env, server/db.env,
#     .env, nginx/redirect.conf), tao moi toan bo.
#   - DB ngoai: chay lai giu cau hinh va khoa bi mat da co.
#
#   bash tools/install.sh                       # hoi tung thong tin
#   bash tools/install.sh --db docker --up      # DB trong Docker, khoi dong luon
#   bash tools/install.sh --db docker --update --up   # da cai roi: giu cau hinh, cap nhat ban moi
#   bash tools/install.sh --db external --up    # DB ngoai (da tao san blk_owner, app_node, DB blk)
#   bash tools/install.sh --help
#
# Trong goi offline script nam o thu muc goc cua goi (install.sh), cung cho voi docker-compose.prod.yml.
set -euo pipefail

D="$(cd "$(dirname "$0")" && pwd)"
[[ -f "$D/docker-compose.prod.yml" ]] || D="$D/.."
cd "$D"

DB_MODE="" WORKER_IPS="" AD_SERVERS="" AD_DOMAIN="" AD_BASE_DN="" AD_PROTOCOL="" TZ_NAME=""
DB_HOST="" DB_PORT="" DB_NAME="" DB_SSL="" UP=0 UPDATE=0 YES=0 MAKE_CERT="" P_HTTPS="" P_INGEST="" P_HTTP=""
usage() { cat <<'EOF'
Cai dat production bang Docker Compose: tao server/.env (va server/db.env neu DB trong Docker) voi gia tri DUNG,
kiem tra, roi (tuy chon) khoi dong.

Cach dung:
  bash install.sh                                   hoi tung thong tin
  bash install.sh --db docker --up                  DB trong Docker, cai moi va khoi dong
  bash install.sh --db external --up                DB ngoai (da tao san blk_owner, app_node, DB blk)
  bash install.sh --db docker --update --up         DA CAI ROI: giu cau hinh, cap nhat ban moi
  bash install.sh --help

Chay lai (an toan, khong xoa nham du lieu):
  DB trong Docker, DA co data/postgres   canh bao va THOAT, khong dong vao cau hinh hay database.
                                         Cap nhat: them --update. Cai lai tu dau (MAT DATABASE):
                                         docker compose -f docker-compose.prod.yml --profile db down && rm -rf data
  DB trong Docker, CHUA co data/postgres dung cac container cu cua project (neu con), xoa cau hinh cu
                                         (server/.env, server/db.env, .env, nginx/redirect.conf), tao moi toan bo.
                                         Khong dong vao data/, backups/, cert/.
  DB ngoai                               chay lai giu cau hinh va khoa bi mat da co.

Tuy chon (bo trong thi script hoi):
  --db docker|external       DB trong Docker hoac PostgreSQL ngoai
  --update                   da cai roi (co data/postgres): giu cau hinh, chi cap nhat / khoi dong lai
  --worker-ips A,B           IP may chay worker duoc goi cong 8443 (de trong = cho moi IP, van can HTTPS va API key)
  --ad-servers dc1,dc2       may chu AD (de trong = chi dung tai khoan noi bo)
  --ad-domain corp.local     --ad-base-dn DC=corp,DC=local     --ad-protocol ldap|starttls|ldaps
  --db-host H --db-port P --db-name blk --db-ssl true|false      (DB ngoai)
  Mat khau DB ngoai: bien moi truong BLK_APP_PASSWORD, BLK_OWNER_PASSWORD (hoac nhap khi duoc hoi)
  --https-port 443 --ingest-port 8443 --http-port 80     cong ra ngoai (doi khi cong chuan bi chiem)
  --tz Asia/Ho_Chi_Minh      --up (khoi dong luon)      --yes (khong hoi, dung gia tri mac dinh)

Trong goi offline script nam o thu muc goc cua goi (install.sh), cung cho voi docker-compose.prod.yml.
EOF
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --db) DB_MODE="$2"; shift 2 ;;
    --worker-ips) WORKER_IPS="$2"; shift 2 ;;
    --ad-servers) AD_SERVERS="$2"; shift 2 ;;
    --ad-domain) AD_DOMAIN="$2"; shift 2 ;;
    --ad-base-dn) AD_BASE_DN="$2"; shift 2 ;;
    --ad-protocol) AD_PROTOCOL="$2"; shift 2 ;;
    --db-host) DB_HOST="$2"; shift 2 ;;
    --db-port) DB_PORT="$2"; shift 2 ;;
    --db-name) DB_NAME="$2"; shift 2 ;;
    --db-ssl) DB_SSL="$2"; shift 2 ;;
    --https-port) P_HTTPS="$2"; shift 2 ;;
    --ingest-port) P_INGEST="$2"; shift 2 ;;
    --http-port) P_HTTP="$2"; shift 2 ;;
    --tz) TZ_NAME="$2"; shift 2 ;;
    --up) UP=1; shift ;;
    --update) UPDATE=1; shift ;;
    --yes|-y) YES=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Tuy chon la: $1 (xem --help)" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
die() { printf 'LOI: %s\n' "$*" >&2; exit 1; }
interactive() { [[ $YES -eq 0 && -t 0 ]]; }

# ask VAR "cau hoi" "mac dinh": bien da co (tu tuy chon) thi giu; khong hoi duoc thi lay mac dinh
ask() {
  local var="$1" prompt="$2" def="${3:-}" cur="${!1:-}"
  [[ -n "$cur" ]] && return 0
  if interactive; then
    local shown="${def:+ [$def]}"
    read -r -p "$prompt$shown: " cur || true
  fi
  printf -v "$var" '%s' "${cur:-$def}"
}
ask_secret() {
  local var="$1" prompt="$2" cur="${!1:-}"
  [[ -n "$cur" ]] && return 0
  interactive || die "Thieu $var (dat bien moi truong $var khi chay khong tuong tac)."
  read -r -s -p "$prompt: " cur; echo
  printf -v "$var" '%s' "$cur"
}

command -v docker >/dev/null || die "Chua cai Docker."
docker compose version >/dev/null 2>&1 || die "Can Docker Compose v2 (lenh 'docker compose')."
[[ -f server/.env.example ]] || die "Khong thay server/.env.example (chay trong thu muc cai dat)."

rand() { if command -v openssl >/dev/null; then openssl rand -hex "$1"; else od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; fi; }
urlenc() { local s="$1" out="" c i; for ((i = 0; i < ${#s}; i++)); do c="${s:i:1}"; case "$c" in [a-zA-Z0-9._~-]) out+="$c" ;; *) out+=$(printf '%%%02X' "'$c") ;; esac; done; printf '%s' "$out"; }
get_env() { grep -E "^$2=" "$1" 2>/dev/null | head -1 | cut -d= -f2- || true; }
set_env() {
  local f="$1" k="$2" v="$3"
  if grep -q "^$k=" "$f"; then
    local esc; esc=$(printf '%s' "$v" | sed -e 's/[\\|&]/\\&/g')
    sed -i "s|^$k=.*|$k=$esc|" "$f"
  else printf '%s=%s\n' "$k" "$v" >> "$f"; fi
}
mask() { sed -E 's#(://[^:/@]+:)[^@]*@#\1***@#'; }

# --- 0. Chay lai: da co database thi KHONG cai lai (tranh doi khoa / mat khau cua DB dang dung); chua co thi lam moi tu dau ---
[[ -z "$DB_MODE" ]] && ask DB_MODE "Database: docker (trong Docker) hay external (PostgreSQL ngoai)" "docker"
if [[ "$DB_MODE" == docker && $UPDATE -eq 0 ]]; then
  if [[ -d data/postgres && -n "$(ls -A data/postgres 2>&1)" ]]; then
    say "CANH BAO: da co database trong data/postgres, khong cai lai (se doi khoa va mat khau cua database dang dung)."
    say "  Cap nhat ban moi, giu cau hinh:   bash install.sh --db docker --update --up"
    say "  Cai lai tu dau (MAT TOAN BO DATABASE):  docker compose -f docker-compose.prod.yml --profile db down && rm -rf data, roi chay lai install.sh"
    exit 1
  fi
  # Chua co database ma van con container cua project nay (cai do, hoac chay cau hinh cu): dung truoc khi lam moi.
  # Phai dung truoc khi xoa .env (.env ghim ten project Compose). Khong xoa volume, khong dong vao project khac.
  PN="$(get_env .env COMPOSE_PROJECT_NAME)"
  [[ -n "$PN" ]] || PN="$(basename "$PWD" | tr 'A-Z' 'a-z' | sed 's/[^a-z0-9_-]//g; s/^[-_]*//')"
  CIDS="$(docker ps -aq --filter "label=com.docker.compose.project=$PN" 2>/dev/null || true)"
  if [[ -n "$CIDS" ]]; then
    say "Chua co database nhung con container cu cua project '$PN': dang dung truoc khi cai moi ..."
    docker compose -f docker-compose.prod.yml --profile db down >/dev/null 2>&1 || true
    CIDS="$(docker ps -aq --filter "label=com.docker.compose.project=$PN" 2>/dev/null || true)"   # con sot (down loi, hoac container ngoai file compose)
    [[ -z "$CIDS" ]] || docker rm -f $CIDS >/dev/null 2>&1 || true
  fi
  old=()
  for f in server/.env server/db.env .env nginx/redirect.conf; do [[ -e $f ]] && old+=("$f"); done
  if (( ${#old[@]} )); then rm -f "${old[@]}"; say "Chua co database: da xoa cau hinh cu (${old[*]}), tao moi toan bo."; fi
fi

ENV=server/.env DBENV=server/db.env
if [[ ! -f $ENV ]]; then cp server/.env.example "$ENV"; say "Tao $ENV tu file mau."; else say "Giu $ENV hien co (chi cap nhat cac gia tri can thiet)."; fi
chmod 600 "$ENV"

# --- 1. Khoa bi mat: chi sinh khi chua co hoac con la gia tri mau (khong doi khoa da dung, mat khoa se mat mat khau da ma hoa) ---
for k in SESSION_SECRET SECRET_KEY INGEST_API_KEY; do
  cur="$(get_env "$ENV" "$k")"
  if [[ -z "$cur" || "$cur" == dev-only* || "$cur" =~ ^0+1?$ ]]; then set_env "$ENV" "$k" "$(rand 32)"; say "Da sinh $k."; else say "Giu $k hien co."; fi
done

# --- 2. Database ---
[[ -z "$DB_MODE" ]] && ask DB_MODE "Database: docker (trong Docker) hay external (PostgreSQL ngoai)" "docker"
case "$DB_MODE" in
  docker)
    [[ -f $DBENV ]] || { cp server/db.env.example "$DBENV"; }
    chmod 600 "$DBENV"
    for k in POSTGRES_PASSWORD BLK_OWNER_PASSWORD APP_NODE_PASSWORD BLK_BACKUP_PASSWORD; do
      [[ -n "$(get_env "$DBENV" "$k")" ]] || { set_env "$DBENV" "$k" "$(rand 24)"; say "Da sinh $k (server/db.env)."; }
    done
    A="$(get_env "$DBENV" APP_NODE_PASSWORD)"; O="$(get_env "$DBENV" BLK_OWNER_PASSWORD)"
    set_env "$ENV" DATABASE_URL "postgres://app_node:$A@db:5432/blk"
    set_env "$ENV" MIGRATION_DATABASE_URL "postgres://blk_owner:$O@db:5432/blk"
    set_env "$ENV" DB_SSL false
    # Sao luu database (pg_dump): tai khoan chi doc blk_backup, do script khoi tao DB tao san
    set_env "$ENV" BACKUP_DATABASE_URL "postgres://blk_backup:$(get_env "$DBENV" BLK_BACKUP_PASSWORD)@db:5432/blk"
    PROFILE=(--profile db)
    ;;
  external)
    ask DB_HOST "May chu PostgreSQL (ten hoac IP)" ""
    [[ -n "$DB_HOST" ]] || die "Chua nhap may chu PostgreSQL."
    ask DB_PORT "Cong" "5432"; ask DB_NAME "Ten database" "blk"; ask DB_SSL "Bat TLS toi PostgreSQL (true/false)" "true"
    ask_secret BLK_APP_PASSWORD "Mat khau tai khoan app_node"; ask_secret BLK_OWNER_PASSWORD "Mat khau tai khoan blk_owner"
    set_env "$ENV" DATABASE_URL "postgres://app_node:$(urlenc "$BLK_APP_PASSWORD")@$DB_HOST:$DB_PORT/$DB_NAME"
    set_env "$ENV" MIGRATION_DATABASE_URL "postgres://blk_owner:$(urlenc "$BLK_OWNER_PASSWORD")@$DB_HOST:$DB_PORT/$DB_NAME"
    set_env "$ENV" DB_SSL "$DB_SSL"
    # Sao luu database (pg_dump): nen dung tai khoan chi doc blk_backup (README muc 6.8); khong co thi dung blk_owner
    if [[ -z "${BLK_BACKUP_PASSWORD:-}" ]] && interactive; then
      read -r -s -p "Mat khau tai khoan blk_backup cho sao luu (Enter de trong = dung blk_owner): " BLK_BACKUP_PASSWORD; echo
    fi
    SSLQ=""; [[ "$DB_SSL" == true ]] && SSLQ="?sslmode=require"
    if [[ -n "${BLK_BACKUP_PASSWORD:-}" ]]; then
      set_env "$ENV" BACKUP_DATABASE_URL "postgres://blk_backup:$(urlenc "$BLK_BACKUP_PASSWORD")@$DB_HOST:$DB_PORT/$DB_NAME$SSLQ"
    else
      set_env "$ENV" BACKUP_DATABASE_URL "postgres://blk_owner:$(urlenc "$BLK_OWNER_PASSWORD")@$DB_HOST:$DB_PORT/$DB_NAME$SSLQ"
      say "LUU Y: sao luu dang dung tai khoan blk_owner (quyen cao). Nen tao blk_backup chi doc (README muc 6.8) roi chay lai voi BLK_BACKUP_PASSWORD."
    fi
    PROFILE=()
    ;;
  *) die "--db phai la docker hoac external." ;;
esac

# --- 3. Worker, AD, mui gio ---
ask WORKER_IPS "IP may chay worker (cach nhau dau phay; de trong = cho moi IP, van can HTTPS va API key)" ""
if [[ -z "$WORKER_IPS" ]]; then
  WORKER_IPS="$(get_env "$ENV" INGEST_ALLOWED_IPS)"
  [[ "$WORKER_IPS" == "127.0.0.1,::1" ]] && WORKER_IPS=""   # gia tri mau cua file .env.example, khong phai lua chon
  [[ -z "$WORKER_IPS" ]] && say "LUU Y: khong loc theo IP worker (moi IP deu goi duoc, van can HTTPS va API key). Muon gioi han: bash install.sh --worker-ips <IP>"
fi
set_env "$ENV" INGEST_ALLOWED_IPS "$WORKER_IPS"
# Worker cai tren CUNG may voi Docker: server thay nguon la gateway cua mang Docker (thuong 172.18.0.1), khong phai IP that.
has_local_ip() {
  local ip
  [[ ",$WORKER_IPS," == *",127.0.0.1,"* ]] && return 0
  for ip in $(hostname -I 2>/dev/null || true); do [[ ",$WORKER_IPS," == *",$ip,"* ]] && return 0; done
  return 1
}
if has_local_ip; then
  say "LUU Y: worker cung may voi Docker thi server thay IP nguon la gateway mang Docker, khong phai IP may nay."
  say "       Sau khi chay, xem gateway: docker network inspect <ten-thu-muc>_default --format '{{(index .IPAM.Config 0).Gateway}}'"
  say "       roi them vao danh sach: bash install.sh --db ... --worker-ips <gateway>[,<ip-khac>] --up"
fi
ask TZ_NAME "Mui gio" "Asia/Ho_Chi_Minh"; set_env "$ENV" APP_TZ "$TZ_NAME"
ask AD_SERVERS "May chu AD (vi du dc01.corp.local,dc02.corp.local; de trong = chi dung tai khoan noi bo)" ""
if [[ -n "$AD_SERVERS" ]]; then
  ask AD_DOMAIN "Ten mien AD (vi du corp.local)" ""; ask AD_BASE_DN "Base DN (vi du DC=corp,DC=local)" ""
  ask AD_PROTOCOL "Giao thuc AD: ldap (389), starttls (389+TLS), ldaps (636)" "ldap"
  [[ -n "$AD_DOMAIN" && -n "$AD_BASE_DN" ]] || die "Dang nhap AD can ca ten mien va Base DN."
  set_env "$ENV" LDAP_SERVERS "$AD_SERVERS"; set_env "$ENV" LDAP_DOMAIN "$AD_DOMAIN"
  set_env "$ENV" LDAP_BASE_DN "$AD_BASE_DN"; set_env "$ENV" LDAP_PROTOCOL "$AD_PROTOCOL"
fi
set_env "$ENV" LOCAL_LOGIN_ENABLED true

# --- 4. Chung chi HTTPS, thu muc sao luu ---
mkdir -p cert backups; chmod 700 backups
# quyen ghi cho user cua app do dich vu backups-init trong docker-compose.prod.yml dam bao (khong can chown tay)
if [[ ! -f cert/server.crt || ! -f cert/server.key ]]; then
  say "Chua co cert/server.crt va cert/server.key."
  default_names="$(hostname -f 2>/dev/null || hostname)"
  ask MAKE_CERT "Tao chung chi TU KY de dung tam (khuyen dung chung chi that o production)? (y/n)" "y"
  if [[ "$MAKE_CERT" =~ ^[yY] ]]; then
    ask CERT_NAMES "Ten/IP truy cap (cach nhau dau cach)" "$default_names"
    # shellcheck disable=SC2086
    if ! out="$(bash cert/generate-self-signed.sh $CERT_NAMES 2>&1)"; then printf '%s
' "$out" >&2; die "Khong tao duoc chung chi tu ky (can openssl)."; fi
    say "Da tao chung chi tu ky trong cert/."
  else say "Dat server.crt va server.key vao cert/ truoc khi khoi dong."; fi
fi

# --- 4b. Cong ra ngoai (mac dinh 443 / 8443 / 80). Ghi vao .env canh docker-compose.prod.yml, compose tu doc ---
PENV=.env
getp() { [[ -f $PENV ]] && { grep -E "^$1=" "$PENV" | head -1 | cut -d= -f2- || true; }; true; }
P_HTTPS="${P_HTTPS:-$(getp HTTPS_PORT)}"; P_HTTPS="${P_HTTPS:-443}"
P_INGEST="${P_INGEST:-$(getp INGEST_PUBLIC_PORT)}"; P_INGEST="${P_INGEST:-8443}"
P_HTTP="${P_HTTP:-$(getp HTTP_PORT)}"; P_HTTP="${P_HTTP:-80}"
for p in "$P_HTTPS" "$P_INGEST" "$P_HTTP"; do
  [[ "$p" =~ ^[0-9]+$ ]] && (( p >= 1 && p <= 65535 )) || die "Cong khong hop le: $p (1-65535)."
done
[[ "$P_HTTPS" != "$P_INGEST" && "$P_HTTPS" != "$P_HTTP" && "$P_INGEST" != "$P_HTTP" ]] || die "Ba cong (web, ingest, http) phai khac nhau."
[[ -f $PENV ]] || : > "$PENV"
set_env "$PENV" HTTPS_PORT "$P_HTTPS"; set_env "$PENV" INGEST_PUBLIC_PORT "$P_INGEST"; set_env "$PENV" HTTP_PORT "$P_HTTP"
# Ghim ten project Compose: volume database ten theo project (= ten thu muc), doi ten thu muc ma khong ghim thi
# Compose tao database TRONG moi (volume cu van con nhung khong con duoc gan). May da cai truoc do: ghim dung ten dang dung.
if ! grep -q '^COMPOSE_PROJECT_NAME=' "$PENV"; then
  CUR=$(basename "$PWD" | tr 'A-Z' 'a-z' | sed 's/[^a-z0-9_-]//g; s/^[-_]*//')
  if [[ -n "$CUR" ]] && { docker volume inspect "${CUR}_blk-pg" >/dev/null 2>&1 || [[ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$CUR" 2>/dev/null)" ]]; }; then
    set_env "$PENV" COMPOSE_PROJECT_NAME "$CUR"; say "May da cai truoc do: ghim ten project Compose = $CUR (doi ten thu muc khong lam mat database)."
  else set_env "$PENV" COMPOSE_PROJECT_NAME blk; fi
fi
# Cong 80 chuyen sang HTTPS: giu cong HTTPS khi khac 443.
mkdir -p nginx
if [[ "$P_HTTPS" == 443 ]]; then printf 'return 301 https://$host$request_uri;\n' > nginx/redirect.conf
else printf 'return 301 https://$host:%s$request_uri;\n' "$P_HTTPS" > nginx/redirect.conf; fi
SUFFIX=""; [[ "$P_HTTPS" == 443 ]] || SUFFIX=":$P_HTTPS"

# --- 5. Kiem tra ---
bad=0
for k in DATABASE_URL MIGRATION_DATABASE_URL SESSION_SECRET SECRET_KEY INGEST_API_KEY; do
  [[ -n "$(get_env "$ENV" "$k")" ]] || { say "THIEU: $k trong $ENV"; bad=1; }
done
[[ "$(get_env "$ENV" SECRET_KEY)" =~ ^[0-9a-fA-F]{64}$ ]] || { say "SAI: SECRET_KEY phai la 64 ky tu hex"; bad=1; }
if [[ "$DB_MODE" == docker ]] && get_env "$ENV" DATABASE_URL | grep -q '@127\.0\.0\.1\|@localhost'; then say "SAI: DATABASE_URL tro 127.0.0.1 trong khi DB o container 'db'"; bad=1; fi
[[ $bad -eq 0 ]] || die "Cau hinh chua day du, sua theo cac dong tren roi chay lai."

say ""; say "Cau hinh ($ENV, mat khau da che):"
grep -E '^(DATABASE_URL|MIGRATION_DATABASE_URL|BACKUP_DATABASE_URL|DB_SSL|INGEST_ALLOWED_IPS|APP_TZ|LDAP_SERVERS|LDAP_DOMAIN|LDAP_BASE_DN|LDAP_PROTOCOL|LOCAL_LOGIN_ENABLED)=' "$ENV" | mask | sed 's/^/  /'
say "  (Cac khoa da tu sinh. INGEST_API_KEY: dan vao cau hinh worker. SECRET_KEY: cat mot ban sao o kho mat khau)"

final_info() {
  say ""
  say "Web:    https://<ten-may-chu>$SUFFIX/   (dang nhap admin / admin, bat buoc doi mat khau lan dau)"
  say "Worker: Ingest.BaseUrl = https://<ten-may-chu>:$P_INGEST/api/ingest   (ten phai co trong chung chi)"
  if [[ -f cert/ca.crt ]]; then
    say "Chung chi TU KY: chep cert/ca.crt sang may worker, dat Ingest.CaFile = duong dan file do"
    say "                (hoac Ingest.SkipCertificateValidation=true khi chi thu; khong nen dung lau dai)."
  fi
  say "Cong can mo tren tuong lua: $P_HTTPS (web), $P_INGEST (chi cho IP may worker), $P_HTTP (chuyen huong)."
}

# --- 6. Khoi dong ---
COMPOSE=(docker compose -f docker-compose.prod.yml ${PROFILE[@]+"${PROFILE[@]}"})
BUILD_FLAG=--no-build; [[ -f server/Dockerfile ]] && BUILD_FLAG=--build
CMD=("${COMPOSE[@]}" up -d "$BUILD_FLAG")
if [[ $UP -eq 0 ]]; then
  if interactive; then read -r -p "Khoi dong ngay? (y/n) [y]: " go || true; [[ "${go:-y}" =~ ^[yY] ]] && UP=1; fi
fi
if [[ $UP -eq 0 ]]; then
  say ""; say "Khoi dong khi san sang:"; say "  ${CMD[*]}"; final_info; exit 0
fi
say ""; say "Khoi dong: ${CMD[*]}"
START_LOG="$(mktemp)"
if ! "${CMD[@]}" 2>&1 | tee "$START_LOG"; then
  # Container cu tham chieu mang Docker da bi xoa ("network ... not found"): xoa cac container cua project nay
  # (khong dong vao data/, backups/, cert/) roi khoi dong lai mot lan.
  if grep -qi 'network .* not found' "$START_LOG"; then
    PN="$(get_env .env COMPOSE_PROJECT_NAME)"
    [[ -n "$PN" ]] || PN="$(basename "$PWD" | tr 'A-Z' 'a-z' | sed 's/[^a-z0-9_-]//g; s/^[-_]*//')"
    CIDS="$(docker ps -aq --filter "label=com.docker.compose.project=$PN" 2>/dev/null || true)"
    say "Container cu tro toi mang Docker khong con: xoa container cu cua project '$PN' roi khoi dong lai (du lieu trong data/ giu nguyen) ..."
    [[ -z "$CIDS" ]] || docker rm -f $CIDS >/dev/null 2>&1 || true
    "${CMD[@]}"
  else
    rm -f "$START_LOG"; die "Khoi dong loi (xem thong bao tren)."
  fi
fi
rm -f "$START_LOG"
URL="${BLK_HEALTH_URL:-https://localhost$SUFFIX/healthz}"
say "Doi he thong san sang ($URL) ..."
for _ in $(seq 1 45); do
  body="$(curl -sk --max-time 3 "$URL" 2>/dev/null || true)"
  if [[ "$body" == *'"dbOk":true'* ]]; then say "OK: $body"; final_info; exit 0; fi
  sleep 2
done
say "Chua san sang sau ~90 giay. Xem nguyen nhan:"
say "  ${COMPOSE[*]} ps"
say "  ${COMPOSE[*]} logs migrate server | tail -40"
exit 1
