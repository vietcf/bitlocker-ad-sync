# Hệ thống quản lý BitLocker Recovery Key

Hệ thống đồng bộ BitLocker recovery key từ Active Directory (AD) về một database riêng. IT chi nhánh
chỉ thấy key của máy thuộc chi nhánh mình. Mỗi lần hiện key phải chọn lý do và được ghi vào nhật ký
chỉ thêm, không sửa hay xóa được.

| Thư mục | Nội dung |
| --- | --- |
| `server/` | Ứng dụng Node.js (Express, JavaScript thuần): trang web (EJS), JSON API, ingest API cho worker, job nền |
| `worker/` | Sync worker .NET (Windows Service): đọc AD qua LDAP(S) rồi đẩy dữ liệu lên ingest API |
| `worker-go/` | Sync worker Go (Linux, systemd): cùng chức năng và giao thức với bản .NET. Chọn **một** trong hai |
| `docker-compose.yml`, `docker-compose.prod.yml` | Dev (secret dev, có `--watch`) và production (cấu hình ở `server/.env`, mật khẩu tạo DB ở `server/db.env`, DB trong Docker tùy chọn bằng `--profile db`) |

Mục lục:

1. [Kiến trúc tóm tắt](#1-kiến-trúc-tóm-tắt)
2. [Cài đặt dev](#2-cài-đặt-dev)
3. [Cài đặt production](#3-cài-đặt-production) (docker-compose hoặc không; DB trong Docker hoặc ngoài)
4. [Cài sync worker trên Windows](#4-cài-sync-worker-trên-windows) (bản .NET) **hoặc**
   [4B. Cài sync worker trên Linux](#4b-cài-sync-worker-trên-linux-bản-go) (bản Go)
5. [Cấu hình lần đầu trong ứng dụng](#5-cấu-hình-lần-đầu-trong-ứng-dụng)
6. [Vận hành hằng ngày](#6-vận-hành-hằng-ngày)
7. [Xử lý sự cố](#7-xử-lý-sự-cố)
8. [Tham chiếu: biến môi trường, API, cấu trúc code](#8-tham-chiếu)

---

## 1. Kiến trúc tóm tắt

```
 Active Directory ──LDAP(S)──> Sync worker (.NET trên Windows, hoặc Go trên Linux)
                                   │ HTTPS 8443 + API key (từ IP được phép)
                                   ▼
 Trình duyệt ──HTTPS 443──> nginx (một chứng chỉ) ──> Node.js server ──> PostgreSQL 17
                              ├─ 443  -> server:3000  web + /api (người dùng)
                              └─ 8443 -> server:8443  /api/ingest (chỉ worker)
```

- **Worker** chỉ đọc AD và gửi dữ liệu lên. Mọi quyết định nằm ở server: máy thuộc chi nhánh nào,
  key nào còn hiệu lực, máy nào không còn trong phạm vi giám sát, lượt sync nào bất thường.
- **Máy** được nhận diện bằng `objectGUID` của AD, nên đổi tên hay chuyển OU vẫn là cùng một máy.
  **Key** được nhận diện bằng Key ID (`msFVE-RecoveryGuid`). Một máy có thể có nhiều ổ được mã hóa,
  mỗi ổ một hoặc nhiều key (`msFVE-VolumeGuid` cho biết key thuộc ổ nào).
- **Không có gì bị xóa.** Máy không còn trong phạm vi giám sát chỉ được gắn nhãn "Không còn trong phạm vi giám sát" và key vẫn
  được giữ để mở ổ cứng cũ.
- **Phân quyền** nằm trong app, không lấy từ group AD. Người dùng đăng nhập bằng tài khoản AD (kiểm
  tra mật khẩu qua LDAP/LDAPS) hoặc tài khoản local.
- **Ngôn ngữ:** giao diện web bằng tiếng Việt. Thông báo trong API và log bằng tiếng Anh; client dựa
  vào mã lỗi `error`, không dựa vào câu chữ. Nội dung email và cảnh báo lấy từ file mẫu email (mục
  6.6), hiện viết bằng tiếng Việt.

---

## 2. Cài đặt dev

Chạy thử trên máy cá nhân bằng Docker. Dữ liệu và secret là giá trị dev, không dùng cho production (mục 3).

### 2.1. Yêu cầu

Docker Desktop (Windows/macOS) hoặc Docker Engine + Compose v2.24 trở lên (Linux). Node.js 24 chỉ cần khi chạy test ngoài Docker; .NET SDK 10 chỉ cần khi chạy worker.

### 2.2. Khởi động

```bash
cd bitlocker-management
bash cert/generate-self-signed.sh      # lần đầu: chứng chỉ tự ký cho HTTPS (thử nghiệm: chứng chỉ tự ký)
docker compose up --build --watch
```

Compose dựng `db` (PostgreSQL 17, có DB `blk` và `blk_test`; lần đầu tạo hai tài khoản `blk_owner`, `app_node`), `migrate` (chạy migration rồi thoát), `server` (app, không mở cổng ra ngoài; `--watch` tự cập nhật khi sửa `server/src`, `public`, `openapi`) và `nginx` (HTTPS cho web 443 và ingest 8443, cổng 80 chuyển sang HTTPS).

- https://localhost: web và `/api`. https://localhost/api/docs: Swagger API người dùng (đăng nhập web trước).
- https://localhost:8443/api/ingest: ingest API cho worker. https://localhost:8443/docs: Swagger ingest (cần API key).
- `localhost:5432`: PostgreSQL, tài khoản dev `postgres` / `dev_postgres_pw`.

Trình duyệt báo "không an toàn" vì chứng chỉ tự ký, tới khi bạn tin `cert/ca.crt` (mục 3.5 nói cách dùng chứng chỉ thật). Cổng 443/80 bị chiếm thì đổi: `HTTPS_PORT=8444 HTTP_PORT=8080 docker compose up -d`. Mặc định chỉ máy này truy cập được; cho máy khác vào: `BIND_ADDR=0.0.0.0`.

### 2.3. Đăng nhập lần đầu

Khi DB chưa có user, app tạo tài khoản local **`admin` / `admin`** (Admin HQ) và bắt đổi mật khẩu ngay lần đăng nhập đầu (mặc định tối thiểu 12 ký tự). Quên mật khẩu hoặc bị khóa:

```bash
docker compose exec server node src/cli/users.js reset-password admin
docker compose exec server node src/cli/users.js unlock admin
docker compose exec server node src/cli/users.js disable-2fa admin   # mất 2 bước; đủ các lệnh ở mục 6.9
```

### 2.4. Cấu hình và lệnh hay dùng

LDAP, API key worker, cảnh báo... đặt trong `server/.env` (DB, cổng, secret dev đã có sẵn trong `docker-compose.yml`). Sau khi sửa `.env` phải tạo lại container:

```bash
cp server/.env.example server/.env
docker compose up -d --force-recreate server

docker compose exec server node src/db/seed-dev.js   # dữ liệu giả: 3 chi nhánh, ~20 máy
docker compose run --rm migrate                      # áp dụng migration mới
docker compose logs -f server                        # xem log
docker compose down -v                               # xóa sạch, kể cả database
```

### 2.5. Chạy test

```bash
docker compose up -d db
cd server && npm install
npm test            # toàn bộ; npm run test:unit (không cần DB); npm run test:int (DB blk_test)
cd ../worker && dotnet test
```

---

## 3. Cài đặt production

### 3.1. Chọn cách cài

Chọn **một** trong ba cách, rồi làm lần lượt từng bước của cách đó (mỗi cách tự đủ, không cần đọc cách khác).

| Cách | App chạy bằng | Database | Dùng khi |
| --- | --- | --- | --- |
| **A** | Docker Compose | PostgreSQL 17 **ngoài** (máy riêng) | Khuyên dùng cho production |
| **B** | Docker Compose | PostgreSQL **trong Docker** cùng máy | Máy nhỏ, thử nghiệm, đã có cách sao lưu volume |
| **C** | Node.js + systemd (không Docker) | PostgreSQL 17 ngoài | Không dùng được Docker |

Cổng cần mở: **443** cho người dùng, **8443** chỉ cho IP máy worker. Cần một tên miền nội bộ trỏ về máy chủ (ví dụ `blk.corp.local`).

### 3.2. Cách A: Docker Compose + PostgreSQL ngoài

**Chuẩn bị:** máy chủ Linux đã cài Docker (có `docker compose`) và `git`; một máy PostgreSQL 17 mà máy chủ này truy cập được.

**Bước 1. Lấy mã nguồn**

```bash
git clone git@github.com:vietcf/bitlocker-ad-sync.git blk && cd blk
```

**Bước 2. Tạo database.** Đăng nhập PostgreSQL bằng superuser, chạy (thay hai mật khẩu bằng mật khẩu mạnh của bạn, ghi lại để nhập khi chạy script ở Bước 3):

```sql
CREATE ROLE blk_owner LOGIN NOSUPERUSER NOCREATEROLE NOBYPASSRLS PASSWORD '<mật-khẩu-owner>';
CREATE ROLE app_node  LOGIN NOSUPERUSER NOCREATEROLE NOBYPASSRLS PASSWORD '<mật-khẩu-app>';
CREATE DATABASE blk OWNER blk_owner;
\c blk
ALTER SCHEMA public OWNER TO blk_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO app_node;
```

`blk_owner` chỉ dùng để tạo bảng khi nâng cấp. `app_node` là tài khoản duy nhất app dùng khi chạy, và luôn bị giới hạn theo chi nhánh. Đừng cho `app_node` quyền superuser.

**Bước 3. Cài đặt**

```bash
bash tools/install.sh --db external
```

Script hỏi vài thông tin (máy chủ PostgreSQL, mật khẩu `app_node` và `blk_owner` của Bước 2, IP máy worker, máy chủ AD, múi giờ) rồi tự tạo `server/.env`, khóa bí mật, chứng chỉ tự ký tạm và khởi động. Chạy lại bất cứ lúc nào đều an toàn (giữ khóa cũ).

**Bước 4. Kiểm tra.** Script in `OK` khi chạy được. Mở `https://<tên máy chủ>/`, đăng nhập `admin` / `admin`, đổi mật khẩu ngay.

**Bước 5. Làm tiếp.** Lưu `SECRET_KEY` và `INGEST_API_KEY` vào kho mật khẩu (`grep -E '^(SECRET_KEY|INGEST_API_KEY)=' server/.env`; `INGEST_API_KEY` dán vào cấu hình worker). Rồi cài worker (mục 4 hoặc 4B) và cấu hình trong ứng dụng (mục 5).

**Tùy chọn** (đầy đủ: `bash tools/install.sh --help`):
- Chứng chỉ thật: đặt `server.crt`, `server.key` vào `cert/` trước khi chạy (mục 3.5).
- Chứng chỉ tự ký: nhập đúng tên truy cập khi script hỏi; worker cần tin `cert/ca.crt` (`Ingest.CaFile`).
- Cổng khác: `--https-port 8444 --ingest-port 9443 --http-port 8080` (mặc định 443, 8443, 80).
- Sao lưu: nên dùng tài khoản chỉ đọc `blk_backup` (SQL ở mục 6.8), chạy script với `BLK_BACKUP_PASSWORD=...`; để trống thì dùng tạm `blk_owner`.
- Không cần gõ: `BLK_APP_PASSWORD=... BLK_OWNER_PASSWORD=... bash tools/install.sh --db external --db-host db.corp.local --worker-ips 10.0.5.21 --yes --up`.

### 3.3. Cách B: Docker Compose + PostgreSQL trong Docker

**Chuẩn bị:** máy chủ Linux đã cài Docker (có `docker compose`) và `git`. Không cần PostgreSQL riêng: Compose tự dựng một container PostgreSQL 17 và lưu dữ liệu trong volume `blk-pg`.

**Bước 1. Lấy mã nguồn**

```bash
git clone git@github.com:vietcf/bitlocker-ad-sync.git blk && cd blk
```

**Bước 2. Cài đặt**

```bash
bash tools/install.sh --db docker
```

Script hỏi IP máy worker, máy chủ AD (có thể để trống), múi giờ rồi tự làm hết: mật khẩu database tự sinh ở `server/db.env`, `server/.env`, khóa bí mật, chứng chỉ tự ký tạm, khởi động. Chạy lại an toàn (giữ khóa và mật khẩu cũ). Từ nay mọi lệnh `docker compose` của cách này cần thêm `--profile db`.

**Bước 3. Kiểm tra.** Script in `OK` khi chạy được. Mở `https://<tên máy chủ>/`, đăng nhập `admin` / `admin`, đổi mật khẩu ngay.

**Bước 4. Làm tiếp.** Lưu `SECRET_KEY` (`grep ^SECRET_KEY= server/.env`) và `server/db.env` vào kho mật khẩu; `INGEST_API_KEY` dán vào cấu hình worker. Rồi cài worker (mục 4 hoặc 4B) và cấu hình trong ứng dụng (mục 5).

**Tùy chọn** (đầy đủ: `bash tools/install.sh --help`): chứng chỉ thật (`server.crt`, `server.key` vào `cert/` trước khi chạy, mục 3.5); chứng chỉ tự ký (nhập đúng tên truy cập, worker tin `cert/ca.crt` qua `Ingest.CaFile`); cổng khác (`--https-port 8444 --ingest-port 9443 --http-port 8080`); không cần gõ (`bash tools/install.sh --db docker --worker-ips 10.0.5.21 --yes --up`).

### 3.4. Cách C: Không Docker (Node.js + systemd + nginx)

**Chuẩn bị:** máy chủ Linux có quyền root; một máy PostgreSQL 17 mà máy chủ này truy cập được; cài **Node.js 24**, **nginx** và `git`. Muốn dùng chức năng sao lưu database thì cài thêm `pg_dump` bản 17 (gói `postgresql-client-17`).

**Bước 1. Lấy mã nguồn và cài thư viện**

```bash
sudo git clone git@github.com:vietcf/bitlocker-ad-sync.git /opt/blk
cd /opt/blk/server && sudo npm ci --omit=dev
```

**Bước 2. Tạo database:** làm đúng như Bước 2 của cách A (cùng đoạn SQL, chạy bằng superuser trên PostgreSQL ngoài).

**Bước 3. Tạo `server/.env` và khóa bí mật**

```bash
cd /opt/blk && sudo cp server/.env.example server/.env && sudo chmod 600 server/.env
set_env() { if sudo grep -q "^$2=" "$1"; then sudo sed -i "s|^$2=.*|$2=$3|" "$1"; else echo "$2=$3" | sudo tee -a "$1" >/dev/null; fi; }
for k in SESSION_SECRET SECRET_KEY INGEST_API_KEY; do set_env server/.env $k $(openssl rand -hex 32); done
```

**Bước 4. Điền cấu hình vào `server/.env`.** `server/.env.example` đã có sẵn nhiều dòng với giá trị dùng cho máy dev (ví dụ `NODE_ENV=development`, `USER_HOST=127.0.0.1`). Vì vậy **không dán thêm vào cuối file** (sẽ bị trùng dòng): hàm `set_env <file> <KHÓA> <giá-trị>` dưới đây **đổi giá trị nếu dòng đã có, thêm dòng mới nếu chưa có**. Cứ dán nguyên khối lệnh vào terminal. Khác cách A ở chỗ app chỉ nghe trên `127.0.0.1` (nginx đứng trước, cùng máy) và cổng ingest là 8444 (để nhường cổng 8443 cho nginx). Sửa các giá trị ở phần "đổi cho đúng môi trường" rồi dán cả khối:

```bash
E=server/.env
# --- cách C (giữ nguyên) ---
set_env $E NODE_ENV production
set_env $E USER_HOST 127.0.0.1
set_env $E USER_PORT 3000
set_env $E INGEST_HOST 127.0.0.1
set_env $E INGEST_PORT 8444
set_env $E TRUST_PROXY 1
set_env $E INGEST_TRUST_PROXY 1
set_env $E COOKIE_SECURE true
set_env $E APP_TZ Asia/Ho_Chi_Minh
set_env $E BACKUP_DIR /opt/blk/backups
# --- đổi cho đúng môi trường của bạn ---
set_env $E INGEST_ALLOWED_IPS 10.0.5.21
set_env $E DATABASE_URL "postgres://app_node:MẬT_KHẨU_APP@db.corp.local:5432/blk"
set_env $E MIGRATION_DATABASE_URL "postgres://blk_owner:MẬT_KHẨU_OWNER@db.corp.local:5432/blk"
set_env $E DB_SSL true
set_env $E LDAP_SERVERS dc01.corp.local,dc02.corp.local
set_env $E LDAP_PROTOCOL ldap
set_env $E LDAP_DOMAIN corp.local
set_env $E LDAP_BASE_DN "DC=corp,DC=local"
set_env $E LOCAL_LOGIN_ENABLED true
```

**Bước 5. Tạo bảng (migration)**

```bash
cd /opt/blk/server && sudo npm run migrate
```

**Bước 6. Chạy app bằng systemd.** Tạo `/etc/systemd/system/blk.service`:

```ini
[Unit]
Description=BitLocker Key Management
After=network-online.target

[Service]
WorkingDirectory=/opt/blk/server
# Đường dẫn node: kiểm tra bằng which node
ExecStart=/usr/bin/node --env-file=.env src/index.js
Restart=always
User=blk
Group=blk

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd --system --home /opt/blk --shell /usr/sbin/nologin blk
sudo mkdir -p /opt/blk/backups && sudo chown -R blk:blk /opt/blk/backups /opt/blk/server/.env
sudo systemctl daemon-reload && sudo systemctl enable --now blk
```

**Bước 7. Chứng chỉ HTTPS và nginx.** Đặt `server.crt` (kèm chuỗi CA trung gian) và `server.key` vào `/etc/nginx/cert/`. Chưa có chứng chỉ thật thì tạo tạm bằng `bash /opt/blk/cert/generate-self-signed.sh blk.corp.local 10.0.5.10` rồi chép hai file `server.crt`, `server.key` trong `/opt/blk/cert/` sang `/etc/nginx/cert/`. Dùng cấu hình mẫu của dự án, đổi hai địa chỉ app:

```bash
sudo mkdir -p /etc/nginx/cert
sudo cp /opt/blk/nginx/nginx.conf /etc/nginx/nginx.conf
sudo sed -i 's/server server:3000;/server 127.0.0.1:3000;/; s/server server:8443;/server 127.0.0.1:8444;/; s|access_log /dev/stdout main;|access_log /var/log/nginx/blk-access.log main;|; s|error_log  /dev/stderr warn;|error_log /var/log/nginx/blk-error.log warn;|' /etc/nginx/nginx.conf
sudo nginx -t && sudo systemctl enable --now nginx && sudo systemctl reload nginx
```

**Bước 8. Kiểm tra**

```bash
curl -k https://localhost/healthz
```

Phải trả HTTP 200 và có `"dbOk": true`. Rồi mở `https://<tên máy chủ>/`, đăng nhập `admin` / `admin` (**bắt buộc đổi ngay**). Log app: `journalctl -u blk -f`.

**Bước 9. Làm tiếp:** cài sync worker (mục 4 cho Windows hoặc 4B cho Linux) và cấu hình trong ứng dụng (mục 5). Cách này cập nhật phiên bản bằng tay (`git pull`, `npm ci --omit=dev`, `npm run migrate`, `systemctl restart blk`); đây là cách ít được hỗ trợ nhất, nên ưu tiên cách A.

### 3.5. Chứng chỉ HTTPS thật

nginx dùng **một chứng chỉ** cho cả web (cổng 443) và ingest API (cổng 8443), gồm hai file: `server.crt` (PEM, **kèm chuỗi CA trung gian** nếu có) và `server.key`. Làm lần lượt:

1. Tạo bản ghi DNS cho tên truy cập, rồi tạo khóa và yêu cầu chứng chỉ (CSR) **trên máy chủ app** (khóa không rời máy):

   ```bash
   openssl req -new -newkey rsa:3072 -nodes -keyout server.key -out server.csr \
     -subj "/CN=blk.corp.local" -addext "subjectAltName=DNS:blk.corp.local"
   ```

2. Gửi `server.csr` cho CA (AD CS template *Web Server*, hoặc CA công cộng). Nhận về chứng chỉ; nếu có chứng chỉ trung gian riêng thì ghép: `cat blk.corp.local.crt intermediate.crt > server.crt`.
3. Chép `server.crt`, `server.key` vào thư mục `cert/` (cách C: `/etc/nginx/cert/`), đặt quyền `chmod 644 server.crt && chmod 600 server.key`, rồi nạp lại nginx không gián đoạn:

   ```bash
   docker compose -f docker-compose.prod.yml exec nginx nginx -t && docker compose -f docker-compose.prod.yml exec nginx nginx -s reload   # cách A, B
   sudo nginx -t && sudo systemctl reload nginx                                                                                              # cách C
   ```

4. Kiểm tra từ máy khác, cả hai cổng phải in `Verify return code: 0 (ok)`:

   ```bash
   openssl s_client -connect blk.corp.local:443 -servername blk.corp.local </dev/null | grep "Verify return"
   openssl s_client -connect blk.corp.local:8443 -servername blk.corp.local </dev/null | grep "Verify return"
   ```

5. Worker: đặt `Ingest.BaseUrl` = `https://blk.corp.local:8443/api/ingest` (đúng tên trong chứng chỉ, không dùng IP). Máy worker đã tin CA của công ty (thường là CA của AD CS) thì để trống `CaFile`; chưa tin thì đặt `CaFile` là file CA.
6. **Gia hạn:** lặp lại từ bước 1 trước ngày hết hạn (xem ngày: `openssl x509 -in server.crt -noout -enddate`); chỉ cần nạp lại nginx, không khởi động lại app hay worker.

| Lỗi | Nguyên nhân / cách xử lý |
| --- | --- |
| `nginx -t`: `key values mismatch` | `server.key` không khớp chứng chỉ: dùng đúng khóa đã tạo CSR |
| Trình duyệt báo sai tên | Tên truy cập không có trong SAN: xin cấp lại |
| Worker `x509: unknown authority` / .NET `RemoteCertificateChainErrors` | Máy worker không tin CA: đặt `Ingest.CaFile` |
| `s_client`: `unable to get local issuer certificate` | `server.crt` thiếu chứng chỉ trung gian: ghép lại cho đủ chuỗi |

### 3.6. Cập nhật phiên bản

Sao lưu database trước (trong ứng dụng: Quản trị > Sao lưu). Dùng Docker Compose thì **migration tự chạy**: bản mới được dựng, tạo bảng mới xong mới khởi động; migration lỗi thì server không lên và bản cũ giữ nguyên. Migration chỉ thêm, không sửa file cũ. Làm trong thư mục dự án:

```bash
git pull
# Cách A (DB ngoài):
docker compose -f docker-compose.prod.yml up -d --build
# Cách B (DB trong Docker):
docker compose -f docker-compose.prod.yml --profile db up -d --build
```

Mỗi bản có ghi chú trong `CHANGELOG.md`, mục **Khi nâng cấp** cho biết có cần sửa `.env` hay không.

**Phiên bản.** Theo [Semantic Versioning](https://semver.org/lang/vi/) (`MAJOR.MINOR.PATCH`), ghi trong [CHANGELOG.md](CHANGELOG.md) và hiện ở chân trang. Phát hành (người bảo trì):

```bash
# 1. sửa "version" trong server/package.json (và package-lock.json), ghi CHANGELOG.md; chạy hết test
# 2. commit, gắn tag (bản thử dùng hậu tố -rc.1) rồi push
git commit -am "release: 1.0.0" && git tag -a v1.0.0 -m "1.0.0" && git push origin main v1.0.0
```


### 3.7. Cài trên máy chủ không có internet (mạng LAN)

Build sẵn image trên một máy có internet, đóng thành một file, chép sang máy chủ rồi nạp vào Docker. Máy chủ chỉ cần có Docker (kèm `docker compose`), không cần `git`, mã nguồn hay internet. Hai máy phải cùng kiến trúc CPU (cùng amd64 hoặc cùng arm64).

**Trên máy có internet** (cần Docker và `git`):

1. Lấy mã nguồn và (nếu muốn bản cụ thể) chọn tag:

   ```bash
   git clone git@github.com:vietcf/bitlocker-ad-sync.git blk && cd blk
   git checkout v2.0.2        # tag phiên bản cần cài; bỏ dòng này để lấy bản mới nhất
   ```

2. Đóng gói:

   ```bash
   bash tools/build-offline.sh           # có image PostgreSQL (cách B: DB trong Docker)
   bash tools/build-offline.sh --no-db   # không có (cách A: DB ngoài, nhỏ hơn)
   ```

   Script build image app, tải image nginx (và PostgreSQL), rồi tạo `dist/offline/blk-offline-<phiên-bản>.tar.gz` (khoảng 240 MB) cùng file `.sha256`. Trong gói có image, `docker-compose.prod.yml`, `nginx/nginx.conf`, file mẫu `.env`, script nạp `load.sh`, `README.md` và `INSTALL.txt`.

3. Chép file `blk-offline-<phiên-bản>.tar.gz` sang máy chủ (USB, `scp`...). Có file `.sha256` thì chép theo để kiểm tra: `sha256sum -c blk-offline-<phiên-bản>.tar.gz.sha256`.

**Trên máy chủ LAN:**

4. Giải nén và nạp image (script tự kiểm tra SHA-256 các file trong gói):

   ```bash
   tar xzf blk-offline-2.0.2.tar.gz && cd blk-offline-2.0.2
   bash load.sh
   ```

5. Cài đặt (script hỏi vài thông tin, tạo `server/.env` đúng giá trị, đề nghị tạo chứng chỉ tự ký tạm nếu chưa có chứng chỉ, rồi khởi động với `--no-build` để Compose không tìm cách build hay tải gì từ mạng):

   ```bash
   bash install.sh --db external     # cách A: PostgreSQL ngoài (đã tạo database như Bước 2 của mục 3.2)
   bash install.sh --db docker       # cách B: PostgreSQL trong Docker
   ```

   Muốn dùng chứng chỉ thật thì đặt `server.crt`, `server.key` vào `cert/` trước khi chạy. Các tùy chọn khác: `bash install.sh --help`.

6. Kiểm tra: script tự in `OK` khi `healthz` trả `"dbOk": true`; hoặc `curl -k https://localhost/healthz`.

**Cập nhật lên bản mới** (máy chủ không có internet). Giải nén **đè vào chính thư mục đang chạy**, đừng tạo thư mục mới: Docker Compose đặt tên project và volume database theo tên thư mục, đổi thư mục là DB mới trống và cổng bị trùng với container cũ.

1. Trên máy có internet: lấy tag mới (`git fetch --tags && git checkout vX.Y.Z`), chạy `bash tools/build-offline.sh` (thêm `--no-db` nếu DB ngoài Docker), chép `blk-offline-X.Y.Z.tar.gz` sang máy chủ. Build lại gói cho mỗi bản, vì gói mang cả image và `install.sh` mới.
2. Trên máy chủ: **sao lưu database trước** (Quản trị > Sao lưu > chạy ngay).
3. Vào thư mục đang chạy (nơi có `server/.env`), giải nén đè lên. Gói chỉ chứa file mẫu (`.env.example`...), không ghi đè `server/.env`, `server/db.env`, `cert/server.*` của bạn (nhưng `docker-compose.prod.yml` và `nginx/*.conf` được thay bằng bản mới: nếu đã sửa tay thì lưu bản sao trước). Rồi nạp image:

   ```bash
   cd /duong/dan/thu-muc-dang-chay
   tar xzf /noi/chua/blk-offline-X.Y.Z.tar.gz --strip-components=1
   bash load.sh
   ```

4. Chạy lại installer: giữ nguyên các khóa cũ, chỉ bổ sung dòng còn thiếu (ví dụ `BACKUP_DATABASE_URL`), rồi khởi động bằng image vừa nạp (không build):

   ```bash
   bash install.sh --db docker --up     # DB ngoài Docker: --db external
   ```

5. Kiểm tra: `docker compose -f docker-compose.prod.yml --profile db ps` (`db`, `server`, `nginx` là `Up (healthy)`, `migrate` là `Exited (0)`) và log server hiện đúng phiên bản (`docker compose -f docker-compose.prod.yml logs --tail=20 server`). Migration tự chạy khi `migrate` chạy.

6. **Cập nhật worker** (làm sau server): máy build chạy `cd worker-go && make package VERSION=X.Y.Z`, chép `worker-go/dist/blk-sync-X.Y.Z-linux-amd64.tar.gz` sang máy worker, rồi:

   ```bash
   mkdir /tmp/blk-sync && tar -C /tmp/blk-sync -xzf /tmp/blk-sync-X.Y.Z-linux-amd64.tar.gz
   cd /tmp/blk-sync && sudo ./install.sh --update
   ```

   Worker .NET trên Windows: mục 4.7. Chi tiết: mục 4B.9.
7. Nếu bản mới có thêm dữ liệu lấy từ AD (ví dụ đăng nhập AD gần nhất từ server 2.7.0 và worker 1.2.0): vào **Quản trị > Sync AD**, bấm **Sync full** (hoặc chờ 01:00) để điền đủ dữ liệu cho mọi máy.

Không dùng `down -v`: `-v` xóa cả volume, mất toàn bộ database.

**Quay về bản cũ (rollback):** image bản cũ vẫn còn trong Docker nếu bạn chưa xóa. Chạy `BLK_VERSION=2.0.1 docker compose -f docker-compose.prod.yml up -d --no-build` (đổi `2.0.1` thành tag cũ). Lưu ý migration của bản mới đã chạy và không tự hoàn tác, nên chỉ quay về nếu bản cũ chạy được với schema mới, hoặc khôi phục database từ bản sao lưu trước khi nâng cấp.

---

### 3.8. Thao tác hay dùng (Docker, chạy ở thư mục gốc dự án)

Đặt tạm cho gọn: `C="docker compose -f docker-compose.prod.yml --profile db"` (DB ngoài Docker thì bỏ `--profile db`).

| Việc | Lệnh |
|---|---|
| Bật tất cả | `$C up -d` |
| Tắt tất cả (giữ dữ liệu) | `$C down` |
| Xem trạng thái | `$C ps` |
| Xem log server | `$C logs -f --tail=100 server` |
| Khởi động lại server (sau khi sửa `server/.env`) | `$C up -d --force-recreate server` |
| Cập nhật bản mới | `git fetch --tags && git checkout vX.Y.Z` rồi `BLK_VERSION=X.Y.Z $C up -d --build` |
| Kiểm tra sức khỏe | `curl -k https://localhost/healthz` |

Trạng thái bình thường: `db`, `server`, `nginx` là `Up (healthy)`; `migrate` là `Exited (0)` (chạy xong tự thoát).

**Không** dùng `down -v`: `-v` xóa cả volume, mất toàn bộ database.

## 4. Cài sync worker trên Windows

Có hai bản worker, làm cùng một việc. Chỉ cài **một** bản:

- **Windows (.NET)**: mục này. Hỗ trợ gMSA, Kerberos tự mã hóa phiên trên cổng 389.
- **Linux (Go)**: mục [4B](#4b-cài-sync-worker-trên-linux-bản-go). Một file chạy, systemd.
  Mặc định LDAP thường (389, không mã hóa); mã hóa (LDAPS) cần DC có chứng chỉ.

### 4.1. Cấp quyền AD cho tài khoản worker

Nên dùng gMSA. Tài khoản này cần đọc được computer object (mặc định ai trong domain cũng đọc được)
và thuộc tính confidential `msFVE-RecoveryPassword`, **chỉ trong các OU máy tính**. Không cấp Domain
Admin.

```powershell
# Tạo gMSA (một lần, trên máy có RSAT AD)
New-ADServiceAccount gmsa-blk -DNSHostName gmsa-blk.corp.local `
  -PrincipalsAllowedToRetrieveManagedPassword 'BLK-SYNC-01$'

# Cấp quyền đọc object và thuộc tính chứa key (làm cho từng OU máy tính)
dsacls "OU=Computers,DC=corp,DC=local" /I:S /G "CORP\gmsa-blk$:RP;;msFVE-RecoveryInformation"
dsacls "OU=Computers,DC=corp,DC=local" /I:S /G "CORP\gmsa-blk$:CA;msFVE-RecoveryPassword;msFVE-RecoveryInformation"

# Trên máy chủ worker
Install-ADServiceAccount gmsa-blk
```

Không dùng gMSA thì tạo một tài khoản domain thường dành riêng cho worker, ví dụ `CORP\svc-blk`,
rồi chạy hai lệnh `dsacls` trên với `CORP\svc-blk` thay cho `CORP\gmsa-blk$`. Không dùng tài khoản
cá nhân hay tài khoản admin. Cách chạy service với tài khoản này xem mục 4.6.

### 4.2. Build và chép lên máy chủ worker

Trên máy có .NET SDK 10:

```powershell
cd worker
dotnet publish src/BitlockerSync.Worker -c Release -o .\publish
```

Chép thư mục `publish` (kèm thư mục `scripts`) lên máy worker, ví dụ vào `C:\BitlockerSync`.

### 4.3. Mã hóa secret bằng DPAPI

Không ghi mật khẩu hay API key dạng rõ vào file cấu hình. Mã hóa trên **chính máy worker**: chuỗi
mã hóa chỉ giải được trên máy đó.

```powershell
cd C:\BitlockerSync
.\BitlockerSync.Worker.exe protect
# Nhập secret (không hiện ra màn hình) -> nhận chuỗi dpapi:AQAAANCMnd8B...
```

Dán chuỗi `dpapi:...` vào `Ingest:ApiKey`, và vào `Ldap:Password` nếu dùng user + mật khẩu thay
vì gMSA.

### 4.4. Sửa `C:\BitlockerSync\appsettings.json`

```jsonc
{
  "Ldap": {
    "Source": "Ldap",
    "Servers": [ "dc01.corp.local", "dc02.corp.local" ],   // DC đầu là DC chính, các DC sau dự phòng
    "Protocol": "Ldaps",          // Ldaps (636, khuyến nghị) | StartTls (389 + TLS) | Ldap (389)
    "Auth": "Negotiate",          // Negotiate: dùng tài khoản chạy service (gMSA) hoặc Username/Password
                                  // Basic: simple bind bằng Username/Password
    "Username": "",               // để trống khi dùng gMSA; ví dụ "CORP\\svc-blk"
    "Password": "",               // "dpapi:..." nếu có Username
    "BaseDn": "DC=corp,DC=local",
    "SearchBases": [],            // để trống = cả BaseDn; hoặc danh sách OU được cấp quyền đọc (xem dưới)
    "ExcludeOperatingSystems": [],  // tùy chọn: bỏ qua máy theo hệ điều hành, ví dụ ["Windows Server*"] (xem dưới)
    "PageSize": 1000,
    "TimeoutSeconds": 60,
    "AllowInsecure": false
  },
  "Ingest": {
    "BaseUrl": "https://blk.corp.local:8443/api/ingest",
    "ApiKey": "dpapi:...",               // giá trị INGEST_API_KEY đã mã hóa (cách xác thực duy nhất)
    "CaFile": "",                        // CA gốc dạng PEM nếu Windows chưa tin chứng chỉ của server
    "BatchSize": 500,
    "RetryForMinutes": 60
  },
  "Schedule": {
    "DeltaEveryMinutes": 15,      // delta sync: chỉ đọc object thay đổi
    "FullAt": "01:00",            // full sync hằng đêm
    "HeartbeatEveryMinutes": 5,
    "WorkerId": ""                // để trống = tên máy
  }
}
```

**Đọc nhiều OU (`SearchBases`).** Khi tài khoản worker chỉ được đọc vài OU, liệt kê chúng (OU phải nằm trong `BaseDn`; OU trùng hoặc OU con của OU đã có thì bỏ qua):

```jsonc
"SearchBases": [ "OU=Computers,OU=HN,DC=corp,DC=local", "OU=Computers,OU=HCM,DC=corp,DC=local" ]
```

**Bỏ qua Server (tùy chọn, `ExcludeOperatingSystems`).** Mặc định worker đọc mọi computer object trong phạm vi, kể cả Windows Server. Muốn chỉ theo dõi máy trạm mà các Server nằm lẫn trong cùng OU, liệt kê mẫu hệ điều hành cần bỏ qua (`*` là ký tự đại diện, không phân biệt hoa thường):

```jsonc
"ExcludeOperatingSystems": [ "Windows Server*" ]
```

Máy khớp mẫu bị bỏ qua cùng key của nó; máy chưa có thuộc tính hệ điều hành trong AD vẫn được đọc. Để trống (mặc định) là đọc tất cả. Cách đơn giản hơn là chỉ đưa các OU máy trạm vào `SearchBases`. Lưu ý khi bật tùy chọn trên hệ thống đã chạy: Server đã đồng bộ trước đó sẽ bị coi là "Không còn trong phạm vi giám sát" ở lượt full kế tiếp (dữ liệu và key vẫn được giữ), và nếu có nhiều máy thì lượt đó có thể bị giữ lại chờ duyệt: vào Quản trị > Đồng bộ AD để chấp nhận. Tùy chọn này không áp dụng cho nguồn `JsonFile` (chỉ dùng khi phát triển).

- Mỗi lượt đọc lần lượt từng OU và gửi server như một lượt.
- Một OU không đọc được (không tồn tại, thiếu quyền) thì **cả lượt dừng** với `ldap_search_base_failed` và tên OU trong log, không bỏ qua, vì bỏ qua sẽ làm lượt full coi mọi máy trong OU là "ngoài phạm vi".
- Máy ngoài mọi OU trong danh sách thì worker không thấy và sau lượt full bị gắn nhãn "Không còn trong phạm vi giám sát"; thêm OU vào thì máy tự trở lại.

Bảng chọn kết nối LDAP:

| Protocol | Auth | Dùng khi |
| --- | --- | --- |
| `Ldaps` | `Negotiate` | **Khuyến nghị cho production**: dùng gMSA và kênh mã hóa TLS |
| `Ldaps` / `StartTls` | `Basic` | Dùng user + mật khẩu qua kênh TLS |
| `Ldap` | `Negotiate` | Lab, khi DC chưa có chứng chỉ. Kerberos signing + sealing mã hóa phiên |
| `Ldap` | `Basic` | Gửi mật khẩu và key dạng rõ. Worker từ chối chạy trừ khi `AllowInsecure: true` (chỉ dùng cho lab) |

### 4.5. Kiểm tra trước khi cài service

```powershell
.\BitlockerSync.Worker.exe check
```

Lệnh kết nối DC, đọc RootDSE, rồi đọc thử vài máy và key của **từng OU** trong `SearchBases` và in `OK` / `FAIL` kèm lý do (có `FAIL` thì thoát mã 4). Lệnh cũng báo hạn chứng chỉ LDAPS và cảnh báo key không đọc được mật khẩu (thiếu quyền ở 4.1). Lệnh chạy bằng tài khoản đang đăng nhập nên quyền có thể khác tài khoản service (gMSA); không gọi server (kiểm tra kết nối server bằng `run-once`).

Chạy thử một lượt full (không cần cài service):

```powershell
.\BitlockerSync.Worker.exe run-once full
```

### 4.6. Cài Windows Service

Chọn một trong ba cách đọc AD, sửa `appsettings.json` cho khớp, rồi chạy `scripts\install-service.ps1` (đã có trong gói worker) trong PowerShell với quyền Administrator.

| Cách | Service chạy bằng | `Ldap:Auth` | `Ldap:Username` / `Ldap:Password` | Mật khẩu nằm ở đâu |
| --- | --- | --- | --- | --- |
| **A. gMSA** (khuyến nghị) | `CORP\gmsa-blk$` | `Negotiate` | để trống | AD tự quản lý và đổi |
| **B. Tài khoản domain chạy service** | `CORP\svc-blk` | `Negotiate` | để trống | Windows lưu khi cài service |
| **C. User + mật khẩu trong file cấu hình** | `NT SERVICE\BitlockerSync` (tài khoản ảo) | `Negotiate` hoặc `Basic` | `CORP\svc-blk` / `dpapi:...` | `appsettings.json`, mã hóa DPAPI |

**Cách A (gMSA)** và **cách B (tài khoản domain)**:

```powershell
C:\BitlockerSync\scripts\install-service.ps1 -Account 'CORP\gmsa-blk$' -InstallDir C:\BitlockerSync   # A
C:\BitlockerSync\scripts\install-service.ps1 -Account 'CORP\svc-blk'   -InstallDir C:\BitlockerSync   # B (script hỏi mật khẩu)
Start-Service BitlockerSync
```

Cách B cần lưu ý:

- Tài khoản cần quyền **Log on as a service**. `Start-Service` báo lỗi 1069 thì cấp tại `secpol.msc` > User Rights Assignment (nếu GPO quản lý quyền này thì thêm vào GPO, vì thêm ở máy sẽ bị GPO ghi đè).
- Đổi mật khẩu `svc-blk` trên AD thì chạy lại script (hoặc `services.msc` > BitlockerSync > Log On) rồi khởi động lại service; quên thì watchdog cảnh báo "Sync worker không gửi heartbeat".
- Đặt mật khẩu dài ngẫu nhiên, bỏ quyền đăng nhập tương tác (Deny log on locally / through Remote Desktop).

**Cách C (user + mật khẩu trong `appsettings.json`)**: service chạy bằng tài khoản ảo, không cần mật khẩu; worker bind LDAP bằng user và mật khẩu trong file. Cũng là cách duy nhất khi máy worker **không join domain**.

1. Mã hóa mật khẩu trên chính máy worker: `cd C:\BitlockerSync` rồi `.\BitlockerSync.Worker.exe protect` (nhập mật khẩu, nhận chuỗi `dpapi:...`).
2. Sửa `appsettings.json`:

   ```jsonc
   "Ldap": {
     "Protocol": "Ldaps",
     "Auth": "Negotiate",            // hoặc "Basic" (simple bind, bắt buộc Ldaps hoặc StartTls)
     "Username": "CORP\\svc-blk",    // hoặc "svc-blk@corp.local"; trong JSON phải viết \\
     "Password": "dpapi:AQAAANCMnd8B...",
     ...
   }
   ```

3. Cài service: `C:\BitlockerSync\scripts\install-service.ps1 -Account 'NT SERVICE\BitlockerSync' -InstallDir C:\BitlockerSync`, rồi `Start-Service BitlockerSync`.

- Chuỗi `dpapi:` chỉ giải mã được trên đúng máy đã mã hóa nhưng mọi tiến trình trên máy đó đều giải mã được, nên script khóa quyền `appsettings.json` (chỉ Administrators, SYSTEM và tài khoản service). Chép cấu hình sang máy khác thì chạy lại `protect`.
- Đổi mật khẩu `svc-blk` trên AD: chạy lại `protect`, dán chuỗi mới vào `Ldap:Password`, `Restart-Service BitlockerSync`.
- Máy không join domain: dùng `Ldaps`, đặt `Ldap:Servers` là tên DC phân giải được, và import CA đã cấp chứng chỉ LDAPS của DC vào `LocalMachine\Trusted Root Certification Authorities`.

**Sau khi cài (cả ba cách)**

- Script cấp quyền ghi `C:\ProgramData\BitlockerSync` cho tài khoản service rồi chạy `check` bằng tài khoản Administrator đang dùng; với cách A, B quyền đọc AD của service có thể khác kết quả `check`. Xem log sau lượt full đầu: có key không đọc được mật khẩu thì kiểm tra quyền ở mục 4.1.
- Đổi cách chạy (ví dụ B sang A): chạy lại script với `-Account` mới, script cập nhật service đang có.
- Log ở Event Viewer > Windows Logs > Application, source `BitlockerSync` (không bao giờ chứa key).
- Lịch: heartbeat mỗi 5 phút, delta mỗi 15 phút, full lúc 01:00 và ngay lần đầu khởi động. Admin HQ cũng bấm yêu cầu sync ở Quản trị > Đồng bộ AD; worker chạy ở lần heartbeat kế tiếp.

### 4.7. Cập nhật worker lên phiên bản mới

Cập nhật **server trước, worker sau** (server mới nhận được dữ liệu từ worker cũ; ngược lại thì không chắc).

1. Build trên máy có .NET SDK 10 và chép `publish-1.1` lên máy worker (ví dụ `D:\drop\BitlockerSync-1.1`):

   ```powershell
   cd worker
   dotnet publish src/BitlockerSync.Worker -c Release -o .\publish-1.1
   Copy-Item .\scripts .\publish-1.1\scripts -Recurse
   ```

2. Trên máy worker, PowerShell quyền Administrator (nên dùng script của bản mới):

   ```powershell
   D:\drop\BitlockerSync-1.1\scripts\update-worker.ps1 -Source D:\drop\BitlockerSync-1.1 -InstallDir C:\BitlockerSync
   ```

   Script: sao lưu `C:\BitlockerSync` sang `.bak-<ngày-giờ>`; dừng service (lượt đang dở được đóng với mã `cancelled`, không cảnh báo, lượt sau đọc lại phần thiếu); chép bản mới đè lên **trừ `appsettings.json`** (giữ cấu hình, secret và phân quyền; bản mẫu mới lưu thành `appsettings.new.json`); chạy `check` (lỗi thì **để service dừng** để bạn sửa hoặc quay lại); khởi động lại. Trạng thái sync (`state.json`) không đổi nên delta tiếp tục từ mốc cũ; không cần chạy lại `install-service.ps1` hay `protect`.

3. Kiểm tra: so `appsettings.new.json` với `appsettings.json`, chép tay thiết lập mới cần dùng rồi `Restart-Service BitlockerSync` (thiết lập vắng mặt dùng mặc định); lượt sync kế tiếp báo `success` (Event Viewer, source `BitlockerSync`) và Quản trị > Sync AD có heartbeat mới (bấm yêu cầu sync để kiểm tra ngay). Nếu bản mới đọc thêm thuộc tính AD, dữ liệu cũ chỉ được bổ sung ở lượt **full** tới (01:00) trừ khi bạn bấm yêu cầu sync full.

**Quay lại bản cũ** nếu có lỗi:

```powershell
Stop-Service BitlockerSync
Rename-Item C:\BitlockerSync C:\BitlockerSync.failed
Rename-Item C:\BitlockerSync.bak-20261013-0930 C:\BitlockerSync    # đúng tên thư mục backup
Start-Service BitlockerSync
```

Xóa bớt thư mục `.bak-*` cũ khi đã ổn định (chúng chứa `appsettings.json` có secret).

---

## 4B. Cài sync worker trên Linux (bản Go)

Hướng dẫn này độc lập với mục 4 (worker .NET). Chi tiết thêm ở [worker-go/README.md](worker-go/README.md),
tham chiếu mọi khóa cấu hình ở [worker-go/docs/configuration.md](worker-go/docs/configuration.md).

### 4B.1. Yêu cầu

| Thành phần | Yêu cầu |
| --- | --- |
| Máy chủ worker | Linux 64-bit có systemd, amd64 hoặc arm64: Ubuntu 22.04+, Debian 12+, RHEL/Rocky 9+, và cả **CentOS/RHEL 7** (systemd 219, script cài tự dùng bản unit riêng). **Không cần cài thư viện hay Go**: binary là bản tĩnh |
| Mạng | Tới DC: 636 (LDAPS) hoặc 389 (StartTls / Ldap). Tới server: cổng ingest (mặc định 8443) |
| Máy build | Go 1.26+, chỉ cần ở máy build. Build trên máy nào cũng được (Windows, Linux kể cả CentOS 7.6) rồi chép gói sang máy chủ worker |
| AD | Một tài khoản dịch vụ thường (bản Go không dùng được gMSA) |

### 4B.2. Chọn cách kết nối AD

| `Ldap.Protocol` | Cổng | Mã hóa | Điều kiện |
| --- | --- | --- | --- |
| `Ldap` (**mặc định**) | 389 | **Không**: mật khẩu tài khoản và mọi recovery key đi dạng rõ | Không cần gì trên AD; chỉ dùng trên mạng tin cậy (dưới) |
| `Ldaps` | 636 | Có | DC có chứng chỉ TLS, máy Linux tin CA của nó |
| `StartTls` | 389 | Có | Như trên |

Mặc định chạy được ngay không phải đổi gì trên AD, nhưng ghi cảnh báo "không mã hóa" vào log mỗi lần kết nối. Muốn mã hóa thì cấp chứng chỉ cho DC (AD CS template *Domain Controller Authentication*, tên DC trong SAN) rồi đổi `Protocol` sang `Ldaps`. Kiểm tra DC đã có chứng chỉ chưa: `openssl s_client -connect dc01.corp.local:636 </dev/null` (in chứng chỉ là được; bị ngắt ngay là chưa có). Với `Ldaps`/`StartTls` dùng **tên** DC, không dùng IP.

**LDAP không mã hóa (mặc định) chỉ trên mạng tin cậy:**

```jsonc
"Ldap": {
  "Servers": [ "dc01.corp.local", "dc02.corp.local" ],
  "Protocol": "Ldap",
  "Username": "svc-blk@corp.local",
  "Password": "cred:ldap-password",
  "BaseDn": "DC=corp,DC=local"
}
```

Mật khẩu và recovery key đi dạng rõ trên đoạn mạng worker - DC, nên cần đủ:

- Worker cùng VLAN/segment máy chủ với DC (hoặc VLAN quản trị), không qua mạng người dùng, Wi-Fi hay WAN.
- Firewall chỉ mở 389 tới các DC trong `Ldap.Servers`.
- Không bật port mirroring/IDS lưu payload trên đoạn này (nếu có, coi chúng là hệ thống chứa key).
- Tài khoản đọc AD quyền tối thiểu, không đăng nhập tương tác, đổi mật khẩu định kỳ; cảnh báo khi nó đăng nhập từ máy khác (event 4624 trên DC).

Kết nối tới server (ingest) vẫn qua **HTTPS** với API key. Nếu sau này DC bắt buộc LDAP signing, DC từ chối simple bind trên 389: worker báo `ldap_bind_failed` (LDAP 8) và cảnh báo hiện ở Quản trị > Sync AD; khi đó cấp chứng chỉ cho DC và đổi `Protocol` sang `Ldaps` (chỉ sửa cấu hình).

### 4B.3. Tạo tài khoản đọc AD

Tạo tài khoản domain thường, ví dụ `CORP\svc-blk`, mật khẩu dài. Cấp quyền đọc key **chỉ trong các OU máy
tính** (chạy trên máy có RSAT AD, làm cho từng OU):

```powershell
dsacls "OU=Computers,DC=corp,DC=local" /I:S /G "CORP\svc-blk:RP;;msFVE-RecoveryInformation"
dsacls "OU=Computers,DC=corp,DC=local" /I:S /G "CORP\svc-blk:CA;msFVE-RecoveryPassword;msFVE-RecoveryInformation"
```

Không dùng tài khoản cá nhân hay tài khoản admin. Nên chặn đăng nhập tương tác cho tài khoản này.

### 4B.4. Build gói cài

Binary là **bản tĩnh** (`CGO_ENABLED=0`): không phụ thuộc thư viện hệ thống hay phiên bản glibc, nên build một lần rồi chép sang máy chủ worker chạy ngay, kể cả máy cũ như CentOS 7 (đã thử chạy trên CentOS 7.9, glibc 2.17). Máy chủ worker không cần cài Go, không cần internet. Chỉ **máy build** cần Go 1.26+.

Trên máy build (Linux, kể cả CentOS 7.6 đã cài Go; hoặc Windows):

```bash
cd worker-go
go test ./...
make package VERSION=1.2.0
```

Kết quả: `worker-go/dist/blk-sync-1.2.0-linux-amd64.tar.gz`. Gói gồm:
- binary `blk-sync` (build tĩnh);
- `install.sh`, `blk-sync.service` (systemd mới) và `blk-sync-legacy.service` (systemd cũ như CentOS 7);
- `config.example.json`, `README.md`.

Máy chủ đích là ARM thì dùng `make linux-arm64`. Không có `make` (Windows): chạy trực tiếp `CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-s -w -X main.version=1.1.1" -o dist/blk-sync ./cmd/blk-sync` rồi chép binary cùng thư mục `deploy/` và `config.example.json` (xem mục 4 của [worker-go/README.md](worker-go/README.md)).

### 4B.5. Cài lên máy chủ

```bash
scp worker-go/dist/blk-sync-1.2.0-linux-amd64.tar.gz admin@sync01:/tmp/
ssh admin@sync01
mkdir /tmp/blk-sync && tar -C /tmp/blk-sync -xzf /tmp/blk-sync-1.2.0-linux-amd64.tar.gz
cd /tmp/blk-sync && sudo ./install.sh
```

Script tạo user hệ thống `blk-sync` và cài các file. Nó tự nhận biết systemd: từ v250 dùng `blk-sync.service` (bí mật dạng credential mã hóa, mục 4B.7); cũ hơn (CentOS/RHEL 7 là v219) dùng `blk-sync-legacy.service`, tạo sẵn `/var/lib/blk-sync` và để bí mật trong file.

| File | Nội dung |
| --- | --- |
| `/opt/blk-sync/blk-sync` | Binary |
| `/etc/blk-sync/config.json` | Cấu hình (chép từ `config.example.json` nếu chưa có) |
| `/etc/systemd/system/blk-sync.service` | Unit systemd, có hardening (bản mới hoặc bản cho systemd cũ, tùy máy) |
| `/var/lib/blk-sync/state.json` | Trạng thái, systemd tự tạo thư mục khi chạy |

Service chưa được bật.

### 4B.6. Sửa cấu hình

```bash
sudo nano /etc/blk-sync/config.json
```

Các khóa cần sửa:

```jsonc
"Ldap": {
  "Servers": [ "dc01.corp.local", "dc02.corp.local" ],
  "Protocol": "Ldap",                     // mặc định (389, không mã hóa); Ldaps/StartTls khi DC có chứng chỉ
  "Username": "svc-blk@corp.local",
  "Password": "cred:ldap-password",       // systemd credential, tạo ở 4B.7
  "BaseDn": "DC=corp,DC=local",
  "SearchBases": [],                      // hoặc danh sách OU tài khoản được đọc
  "ExcludeOperatingSystems": [],          // tùy chọn: bỏ qua máy theo hệ điều hành, ví dụ ["Windows Server*"]
  "CaFile": ""                            // file PEM của CA, nếu máy chưa tin CA của DC
},
"Ingest": {
  "BaseUrl": "https://blk.corp.local:8443/api/ingest",
  "ApiKey": "cred:ingest-api-key"         // mặc định chỉ cần API key
}
```

**Xác thực với server: HTTPS + API key** (`INGEST_API_KEY` trong `server/.env`), và server chỉ nhận từ IP
máy worker: thêm IP đó vào `INGEST_ALLOWED_IPS`. Máy worker chưa tin CA của chứng chỉ server thì đặt
`Ingest.CaFile` (mục 3.5).

**Worker cài cùng máy với Docker (server app).** Kết nối từ máy chủ vào cổng 8443 đi qua cầu nối Docker nên server thấy IP nguồn là **gateway của mạng Docker** (thường `172.18.0.1`), không phải IP của máy. Log server ghi `ingest: address not allowed` và worker nhận 403. Lấy gateway bằng `docker network inspect <tên-thư-mục>_default --format '{{(index .IPAM.Config 0).Gateway}}'` rồi thêm vào `INGEST_ALLOWED_IPS`: `bash install.sh --db ... --worker-ips <gateway> --up`. Worker ở máy khác thì dùng IP thật của máy đó.

### 4B.7. Lưu bí mật

Mật khẩu AD và API key lưu thành **systemd credential mã hóa**. Unit đã khai báo sẵn hai credential này.
Giá trị được gõ ở dấu nhắc, không nằm trong lịch sử shell:

```bash
sudo sh -c 'systemd-ask-password -n "AD password:" | systemd-creds encrypt --name=ldap-password - /etc/blk-sync/ldap-password.cred'
```

```bash
sudo sh -c 'systemd-ask-password -n "Ingest API key:" | systemd-creds encrypt --name=ingest-api-key - /etc/blk-sync/ingest-api-key.cred'
```

**systemd cũ** (CentOS/RHEL 7, không có `systemd-creds`, trước v250): `install.sh` đã cài `blk-sync-legacy.service` (không có `LoadCredentialEncrypted`). Ghi bí mật vào file chỉ user `blk-sync` đọc được và trỏ cấu hình tới file đó:

```bash
read -rsp "AD password: " p; echo; (umask 077; printf '%s' "$p" > /etc/blk-sync/ldap-password); chown blk-sync:blk-sync /etc/blk-sync/ldap-password; unset p
read -rsp "Ingest API key: " p; echo; (umask 077; printf '%s' "$p" > /etc/blk-sync/ingest-api-key); chown blk-sync:blk-sync /etc/blk-sync/ingest-api-key; unset p
```

Trong `/etc/blk-sync/config.json`: `"Password": "file:/etc/blk-sync/ldap-password"` (mục `Ldap`) và `"ApiKey": "file:/etc/blk-sync/ingest-api-key"` (mục `Ingest`). Thử bằng `sudo -u blk-sync /opt/blk-sync/blk-sync --config /etc/blk-sync/config.json check`.

### 4B.8. Kiểm tra rồi bật service

Chạy `check` bằng đúng user và credential của service:

```bash
sudo systemd-run --pty --wait -p User=blk-sync -p LoadCredentialEncrypted=ldap-password:/etc/blk-sync/ldap-password.cred -p LoadCredentialEncrypted=ingest-api-key:/etc/blk-sync/ingest-api-key.cred /opt/blk-sync/blk-sync --config /etc/blk-sync/config.json check
```

Kết quả tốt in `LDAP OK: ...` và một dòng `OK` cho mỗi OU. Mã thoát:
- `3`: không kết nối hoặc không bind được (sai mật khẩu, DC chưa có chứng chỉ...);
- `4`: có OU không đọc được.

Có key "without a readable password" là thiếu quyền ở 4B.3.

```bash
sudo systemctl enable --now blk-sync
```

```bash
journalctl -u blk-sync -f
```

Lần chạy đầu là một lượt full. Worker hiện ở Quản trị > Sync AD với version đuôi `-go`.

**Đang dùng worker .NET và muốn chuyển sang bản Go:** dừng và tắt service Windows trước
(`Stop-Service BitlockerSync; Set-Service BitlockerSync -StartupType Disabled`). Hai worker chạy cùng lúc
sẽ tranh nhau mở lượt sync (409 `run_in_progress`; lượt của worker đã crash tự được giải phóng sau 30 phút im lặng).

### 4B.9. Cập nhật và gỡ cài đặt

Cập nhật: build gói mới (`make package VERSION=1.2.0`), chép lên máy chủ, giải nén, rồi:

```bash
sudo ./install.sh --update
```

Script làm lần lượt:
1. chạy `check` bằng bản mới; lỗi thì dừng, không thay gì;
2. dừng service (worker đóng lượt đang chạy với `cancelled`);
3. thay binary, giữ bản cũ là `blk-sync.previous`;
4. khởi động lại; service không lên thì tự quay lại bản cũ.

Gỡ cài đặt:

```bash
sudo systemctl disable --now blk-sync
sudo rm -rf /opt/blk-sync /etc/blk-sync /var/lib/blk-sync /etc/systemd/system/blk-sync.service
sudo systemctl daemon-reload && sudo userdel blk-sync
```

---

## 5. Cấu hình lần đầu trong ứng dụng

1. **Đăng nhập** bằng `admin` / `admin` rồi đổi mật khẩu.
2. **Tạo chi nhánh** (Quản trị > Chi nhánh & OU): nhập mã, tên và các OU máy tính, ví dụ `OU=Computers,OU=HN,DC=corp,DC=local`. Một OU chỉ thuộc một chi nhánh; OU con thuộc cùng chi nhánh. Có màn hình xem trước; khi lưu, app **gán máy vào chi nhánh theo OU ngay**, không chờ sync.
   - **Xóa chi nhánh**: Sửa > **Xóa chi nhánh…**; trang xác nhận cho biết số máy chuyển về N/A, OU và quyền bị gỡ; phải **gõ lại mã chi nhánh**. Máy chuyển về **N/A** (hoặc sang chi nhánh khác nếu nằm trong OU của chi nhánh đó); key và nhật ký giữ nguyên; không hoàn tác được.
   - Chỉ **Admin HQ** thêm, sửa, xóa chi nhánh và OU.
3. **Tạo người dùng** (Quản trị > Người dùng):
   - **AD** (mặc định): nhập sAMAccountName (`nguyenvana`, `CORP\nguyenvana` hoặc `nguyenvana@corp.local`); đăng nhập bằng mật khẩu Windows. Chưa tạo trong app thì không đăng nhập được. Lần đăng nhập đầu, app gắn với objectGUID của AD; tài khoản AD bị xóa rồi tạo lại cùng tên thì bị từ chối cho tới khi admin bấm "Gỡ liên kết AD".
   - **Local**: app cấp mật khẩu một lần, phải đổi ở lần đăng nhập đầu. Chỉ nên dùng cho admin dự phòng.
   - **Họ tên và email:** tài khoản AD có thể để trống, app tự lấy từ AD (`displayName`, `mail`) ở lần đăng nhập đầu; đã có giá trị thì AD không bao giờ ghi đè. Tài khoản local bắt buộc nhập cả hai. Email lưu chữ thường; chưa có email thì không nhận được thư (danh sách gắn nhãn "Chưa có email"). Tài khoản `admin` mặc định chưa có email: nhập khi sửa lần đầu.
   - **Xóa người dùng** (nút ở trang sửa): chỉ xóa được khi nhật ký chưa có dòng nào của người đó (đăng nhập, kể cả đăng nhập sai, xem key...). Đã có thì app báo "chỉ có thể vô hiệu hóa" (bỏ chọn **Đang hoạt động**), vì nhật ký phải khớp với một tài khoản còn tồn tại. Không xóa được chính mình và admin gốc; xóa admin khác chỉ admin gốc làm được. API: `DELETE /api/admin/users/{id}`.
   - **Vai trò:**

     | Vai trò | Quyền |
     | --- | --- |
     | `it` | Tìm máy, hiện key của chi nhánh được gán |
     | `lead` | Như `it`, thêm xem nhật ký và báo cáo của chi nhánh |
     | `admin` | Admin HQ: mọi chi nhánh (kể cả máy N/A) và toàn bộ menu Quản trị |
     | `auditor` | Xem nhật ký và báo cáo của chi nhánh được gán, không hiện được key |

     **Chỉ Admin HQ xem mọi chi nhánh.** Vai trò khác luôn gán **theo từng chi nhánh** và mọi trang chỉ hiện dữ liệu chi nhánh đó (lọc 2 lớp: điều kiện truy vấn và Row-Level Security). Không tạo được quyền "tất cả chi nhánh" cho vai trò khác Admin HQ.

     **Quy tắc gán quyền:** Admin HQ đứng một mình (không chọn kèm vai trò khác, vì đã bao hết mọi chi nhánh); mỗi chi nhánh chỉ một vai trò cho một người dùng; chi nhánh khác nhau có thể có vai trò khác nhau (ví dụ `it` ở HN, `lead` ở HCM). Form tự bỏ chọn khi tick trái quy tắc, và API/CLI trả 400 `admin_exclusive` / `one_role_per_branch`.
4. **Kiểm tra sync** (Quản trị > Sync AD): lượt full đầu tiên, số máy, số key, cảnh báo đang mở.
5. **Máy N/A**: máy ngoài mọi OU đã khai báo chỉ Admin HQ thấy. Bấm "Xem danh sách" (hoặc lọc Chi nhánh = N/A ở Tìm máy) rồi bổ sung OU cho chi nhánh.
6. **Mail** (Quản trị > Mail server): nhập SMTP, bấm **Gửi thử**; rồi chọn thông báo ở Quản trị > Thông báo.
7. **Tính năng và lưu trữ** (Quản trị > Tính năng, Lưu trữ): chọn ai được xuất kèm recovery key (mặc định tắt), thời gian giữ nhật ký, lịch sử sync, email.

---

## 6. Vận hành hằng ngày

### 6.0. Delta và full sync

**Phạm vi giám sát** là các OU trong `Ldap.SearchBases` của worker. Máy **"Không còn trong phạm vi giám sát"** là máy mà lượt full không còn thấy: **bị xóa khỏi AD** hoặc **bị chuyển ra ngoài `SearchBases`** (hệ thống không phân biệt được hai trường hợp). Dữ liệu và key của máy luôn được giữ; máy xuất hiện lại thì tự trở lại bình thường.

Worker chạy **delta** mỗi 15 phút (chỉ đọc object có `uSNChanged` mới) và **full** mỗi đêm (`FullAt`, mặc định 01:00; thêm một lần khi worker khởi động lần đầu).

Trang chi tiết của một lượt (Quản trị > Sync AD, bấm mã lượt): lượt **delta** chỉ hiện những gì lượt đó thấy (máy thấy, key thấy, key mới thêm, key không đọc được); chỉ lượt **full** mới so với dữ liệu đang có (máy/key đang có, chênh lệch).

| Thay đổi trên AD | Delta | Full |
| --- | --- | --- |
| Máy mới, đổi tên, sửa thuộc tính, key mới | Thấy | Thấy |
| Máy chuyển OU nhưng **vẫn trong `SearchBases`** | Thấy (đổi chi nhánh, ghi `computer_moved`) | Thấy |
| Máy bị **xóa** khỏi AD, hoặc chuyển **ra ngoài** `SearchBases` | **Không thấy** | Thấy: gắn nhãn "Không còn trong phạm vi giám sát" |

Nên máy bị xóa hoặc chuyển ra khỏi phạm vi chỉ cập nhật **sau lượt full ban đêm** (tối đa khoảng một ngày; full chỉ chạy ban đêm để không tải AD giờ làm việc). Cần ngay thì Admin HQ bấm **Full** ở Quản trị > Đồng bộ AD > Tình trạng sync (worker làm ở heartbeat kế tiếp, tối đa 5 phút).

### 6.1. Lượt sync bị giữ lại (cách ly)

Có lượt sync báo thành công nhưng số liệu bất thường. Server giữ lại thay đổi của lượt đó, cảnh báo và chờ Admin HQ quyết định. Ngưỡng chỉnh ở **Quản trị > Đồng bộ AD > Cảnh báo sync** (mặc định):

| Trường hợp | Ngưỡng |
| --- | --- |
| Lượt full thấy ít máy / ít key hơn hẳn so với DB | dưới 95% |
| Một chi nhánh giảm mạnh so với mức thường | giảm hơn 20% **và** hơn 10 máy |
| Lượt full không thấy nhiều máy (sẽ bị gắn nhãn ngoài phạm vi) | quá 5% |
| Đọc được key nhưng mật khẩu rỗng (tài khoản sync mất quyền) | từ 1 key |

Chỉ cần một ngưỡng vượt là bị giữ; riêng các cặp đánh dấu **VÀ** phải vượt cả hai.

Xử lý ở Quản trị > Đồng bộ AD > Tình trạng sync: bấm **Xem chi tiết và quyết định** để xem lý do, số liệu so với hệ thống theo chi nhánh, danh sách máy **sẽ bị gắn nhãn** nếu chấp nhận, và máy/key mới lượt đó đã lưu. Rồi chọn:

- **Chấp nhận** khi thay đổi là thật (vừa xóa hàng loạt máy cũ): gắn nhãn và lưu mốc USN.
- **Bác bỏ** khi dữ liệu sai (DC lỗi, mất quyền): không áp dụng gì, lượt full sau đọc lại từ đầu.

Key mới trong lượt bị giữ vẫn được lưu ngay (key không bao giờ bị ghi đè hay xóa).

### 6.2. Cảnh báo

Watchdog chạy mỗi 5 phút và tách **hai loại sự cố**, mỗi loại một trạng thái và **một** email:

| | Worker (agent) Offline | Đồng bộ AD có sự cố |
| --- | --- | --- |
| Nghĩa là | Không có heartbeat quá ngưỡng (worker chết, máy tắt, mất mạng, sai API key / IP / chứng chỉ) | Worker **vẫn chạy** nhưng AD hoặc đồng bộ có vấn đề |
| Điều kiện | Không có heartbeat | Không đọc được AD (DC offline, sai quyền, lỗi TLS), lâu không sync, lượt sync treo, canary cũ, USN đứng yên, chứng chỉ LDAPS sắp hết hạn, máy mới không lưu key, tỉ lệ máy chưa có key tăng |

- Khi worker Offline, trạng thái AD là **chưa xác định** và các điều kiện cần worker chạy không báo thêm (tránh đọc nhầm "AD hỏng" thành "worker chết" và ngược lại).
- Mỗi loại: gửi khi bắt đầu, nhắc lại tối đa 1 lần mỗi ngày, hết sự cố thì không gửi gì nữa.
- Xem ở **Quản trị > Đồng bộ AD > Tình trạng sync** (hai ô Worker và Đồng bộ AD, bên dưới là cảnh báo đang mở), Tổng quan của Admin HQ và báo cáo email hằng ngày.

**Ô "Đồng bộ AD" gồm 2 phần:** **Sự cố hệ thống** (đo trực tiếp: không đọc được AD, sync quá hạn, lượt sync treo, canary, USN; tự hết khi sửa xong) và **Cảnh báo dữ liệu** (tính từ nội dung đã đồng bộ: máy mới không có key, tỉ lệ không key tăng, full sync quá hạn, chứng chỉ DC sắp hết hạn; hiện "Có cảnh báo nhẹ" và không làm dừng sync). Vì cảnh báo dữ liệu còn đúng nhiều ngày sau khi bạn đã sửa nguyên nhân, mỗi cảnh báo loại này có nút **Đã xử lý** (kèm ghi chú: ngừng gửi mail và không tính vào trạng thái trong **30 ngày** theo mặc định, chỉnh ở Ngưỡng cảnh báo; hết hạn mà điều kiện còn thì báo lại, điều kiện hết thì cảnh báo tự đóng) và **Bỏ qua 1/7/30 ngày** (cùng cách). Muốn **tắt hẳn** một loại cảnh báo dữ liệu: công tắc **Bật/Tắt** ngay cạnh ngưỡng của nó ở **Quản trị > Đồng bộ AD > Cảnh báo sync**; loại đã tắt không bao giờ mở, đang mở thì đóng, và ô trạng thái ghi "Đã tắt N loại". Sự cố hệ thống không tắt được. Sự cố hệ thống tự hết khi sửa xong nên không có nút nào. Chỉ Admin HQ bấm được; mọi thao tác ghi vào nhật ký truy cập (`alert_ack`, `alert_snooze`).

**Email cảnh báo chia 4 nhóm**, mỗi nhóm bật/tắt và chọn người nhận riêng ở **Quản trị > Thông báo** (Admin HQ và/hoặc địa chỉ thêm; `NOTIFY_TO` luôn nhận nhóm đang bật). Tắt nhóm thì không gửi mail nhóm đó (cảnh báo vẫn hiện trong app):

| Nhóm | Gồm |
| --- | --- |
| **Agent (worker) ngừng hoạt động** | Worker Offline |
| **Kết nối AD và đồng bộ có vấn đề** | Đồng bộ AD có sự cố, sync lỗi, sync bất thường bị giữ lại, Key ID trùng |
| **Xem key ngoài giờ và bảo mật dữ liệu** | Hiện key ngoài giờ, xuất key hàng loạt |
| **Sao lưu** | Một lượt sao lưu bị lỗi |

Ngưỡng của watchdog (**Quản trị > Đồng bộ AD > Cảnh báo sync**):

| Ngưỡng | Mặc định |
| --- | --- |
| Không có heartbeat của worker quá | 15 phút |
| Không có lượt sync thành công quá (cũng là mốc "dữ liệu cũ" ở Tổng quan) | 60 phút |
| Không có lượt full thành công quá | 26 giờ |
| Lượt "đang chạy" quá lâu thì hủy | 2 giờ |
| Lượt đang chạy mà worker im lặng (crash) được giải phóng khi mở lượt mới | 30 phút không gọi API |
| USN của DC không đổi quá | 6 giờ |
| Giá trị canary cũ quá | 90 phút |
| Máy mới (2–7 ngày) chưa có key quá | 50%, chỉ xét khi có từ 5 máy mới |
| Tỉ lệ máy chưa có key của chi nhánh tăng quá (so với tuần trước) | 5 điểm % |
| Cảnh báo dữ liệu đã xử lý tự báo lại sau nếu điều kiện còn | 30 ngày |
| Máy được coi là "Hoạt động gần đây" nếu có đăng nhập AD trong (chỉ là nhãn, không tạo cảnh báo) | 3 tháng |

**Trang Tổng quan:** dòng "Dữ liệu cập nhật lần cuối" (chuyển thành cảnh báo khi quá ngưỡng sync), biểu đồ số máy và số key 30 ngày, lượt hiện key mỗi ngày 14 ngày (Trưởng IT, Admin HQ, Auditor), và khung **Theo chi nhánh**: mỗi chi nhánh một thanh, **xanh** là % máy đã có key, **đỏ** là % chưa có (bấm phần đỏ để mở danh sách máy chưa có key). Mặc định 10 chi nhánh nhiều máy nhất, bấm **Xem tất cả** để hiện đủ. Báo cáo theo kỳ ở mục 6.11.

### 6.3. Trang Quản trị

Mọi cấu hình của Admin HQ nằm trong menu **Quản trị**, gom thành 4 nhóm; bấm một nhóm thì hàng dưới hiện các tab:

| Nhóm | Tab | Nội dung |
| --- | --- | --- |
| Người dùng & chi nhánh | Chi nhánh & OU | Thêm/sửa/xóa chi nhánh và OU gốc (lưu là quét lại máy theo OU ngay; xóa thì máy về N/A, gõ mã để xác nhận). Máy ngoài mọi OU là N/A |
| | Người dùng | Tài khoản, email, cách đăng nhập, quyền |
| Đồng bộ AD | Tình trạng sync | Hai ô **Worker** Online / Offline (Online = có heartbeat trong ngưỡng, mặc định 15 phút) và **Đồng bộ AD** Bình thường / Có sự cố (mục 6.2); yêu cầu sync, chấp nhận / bác bỏ lượt bị giữ lại |
| | Cảnh báo sync (Đồng bộ AD) | Ngưỡng giữ lại lượt sync (6.1), watchdog (6.2) và công tắc bật/tắt từng loại cảnh báo dữ liệu. Mỗi ô có khoảng cho phép và mặc định; ngoài khoảng bị từ chối. Ngưỡng trong khung viền xanh phải vượt cùng lúc (VÀ), còn lại độc lập (HOẶC). Có hiệu lực trong 30 giây, ghi nhật ký `settings_thresholds` |
| Email | Thông báo | Email cảnh báo theo **4 nhóm** (Agent ngừng, AD/đồng bộ có vấn đề, xem key ngoài giờ và bảo mật dữ liệu, sao lưu; mục 6.2); email khi có **máy mới** / **key mới** (gửi người dùng chi nhánh và/hoặc Admin HQ); **báo cáo hằng ngày** (mục 6.11) |
| | Mail server | SMTP: địa chỉ, cổng, STARTTLS/SSL/không mã hóa, tài khoản, địa chỉ gửi, địa chỉ web của app; nút **Gửi thử** |
| | Log email | Mọi email hệ thống tạo ra (chờ gửi / đã gửi / thất bại / không gửi), ghi **đã gửi cho ai** và **ai lẽ ra nhận nhưng chưa có email**; lọc, tìm, xem nội dung, gửi lại mail thất bại |
| Hệ thống | Bảo mật | Khóa tài khoản khi đăng nhập sai, chính sách mật khẩu, thời gian phiên (mục 6.14) |
| | Sao lưu | Mục 6.8 |
| | Tính năng | **Số dòng mỗi trang** (Tìm máy 25, Nhật ký 50, Log email 50, Báo cáo chi nhánh 20; 5–200); bật/tắt yêu cầu sync từ web, xuất CSV nhật ký / danh sách máy, cảnh báo xem key ngoài giờ, bắt buộc số ticket; ai được **xuất kèm recovery key**: tắt (mặc định) / chỉ Admin HQ / IT, Trưởng IT và Admin HQ |
| | Lưu trữ | Số ngày giữ nhật ký, lịch sử sync, email (mục 6.7) |

**Cách gửi mail**

- Mọi email ghi vào bảng `mail_outbox` trước; job `mail-outbox` chạy mỗi phút để gửi. Lỗi tạm thời thử lại sau 1, 5, 15, 60, 240 phút, sau đó đánh dấu thất bại để Admin HQ gửi lại.
- Mật khẩu SMTP mã hóa AES-256-GCM bằng khóa suy ra từ `SECRET_KEY`, không hiện lại (đổi `SECRET_KEY` thì nhập lại). Tắt mail server trong Quản trị thì app dùng `SMTP_URL` trong `.env` (nếu có); `NOTIFY_TO` luôn nhận email cảnh báo.
- Mail server tắt hoặc chưa cấu hình: email nằm ở **Chờ gửi** và tự gửi khi bật.
- **Máy mới / key mới**: sau mỗi lượt sync, mỗi người nhận **một** email gom các máy/key mới trong phạm vi của họ (IT, Trưởng IT: máy thuộc OU chi nhánh mình; Admin HQ: tất cả, kể cả N/A). Mặc định không gửi cho lượt full đầu tiên. Email ghi tên máy và Key ID đầy đủ; recovery password **không bao giờ gửi qua email**.
- Chỉ người dùng đang hoạt động và có email mới nhận. Người lẽ ra nhận nhưng chưa có email được ghi trên đúng email đó ("Không có email: <tên>"). Không ai có email thì email lưu với trạng thái **Không gửi (thiếu email)** kèm nội dung (không tự gửi lại; thêm email ở Quản trị > Người dùng cho các lượt sau).

### 6.4. Bộ lọc và xuất dữ liệu ở trang Tìm máy

Mỗi máy và mỗi key có hai mốc: **Tạo trên AD** (`whenCreated`) và **Ghi nhận** (lần đầu hệ thống thấy qua sync). Cả hai hiện trong danh sách, trang chi tiết và file CSV.

Bộ lọc danh sách: chi nhánh (kể cả N/A), tình trạng, có tính máy ngoài phạm vi giám sát hay không, và **khoảng ngày** theo *Ghi nhận* (mặc định) hoặc *Tạo trên AD* (tính cả hai đầu, theo `APP_TZ`). Ví dụ: máy mới tuần này = Ghi nhận, từ thứ Hai đến hôm nay.

**Đăng nhập AD gần nhất:** worker đọc thêm thuộc tính `lastLogonTimestamp` của máy (AD đồng bộ giữa các DC nên chỉ cần hỏi một DC; AD chỉ cập nhật khi giá trị cũ hơn khoảng 14 ngày nên lệch tối đa ~14 ngày). Giá trị hiện ở danh sách, trang chi tiết và CSV (`last_logon_utc`), kèm nhãn **Hoạt động gần đây** (trong 3 tháng theo mặc định, đổi ở **Quản trị > Đồng bộ AD > Cảnh báo sync > Hoạt động của máy**), **Không hoạt động gần đây** hoặc **Chưa có dữ liệu** (máy chưa từng đăng nhập, hoặc worker chưa báo, ví dụ worker bản cũ). Đó chỉ là "chưa thấy máy đăng nhập domain", không có nghĩa máy đã hỏng hay bị bỏ. Bộ lọc gồm hai ô kết hợp được: **Đăng nhập AD** (Tất cả / trong N tháng gần nhất / quá N tháng chưa thấy, N = 1/3/6/9/12/24) và **Máy chưa có dữ liệu** (Không gồm / Gồm cả / Chỉ máy này; "Gồm cả" là HOẶC với mốc thời gian, ví dụ "quá 6 tháng chưa thấy" kèm "Gồm cả" ra danh sách máy ứng viên để dọn). Mặc định không lọc gì; chọn một mốc N tháng thì ô thứ hai tự là "Không gồm" (chỉ tính máy có bằng chứng).  Cần cập nhật worker (Go và .NET từ 1.2.0 có thuộc tính này) rồi chờ lượt sync full kế tiếp để dữ liệu có đủ.

Hai nút xuất, đều xuất **toàn bộ** danh sách theo bộ lọc (không chỉ trang đang xem) và trong phạm vi chi nhánh của người xuất:

| Nút | File CSV | Ai dùng | Nhật ký |
| --- | --- | --- | --- |
| **Xuất CSV** | Thông tin máy, số key, các mốc ngày, còn trong phạm vi hay không. **Không có key** | IT, Trưởng IT, Admin HQ (tắt được ở tab Tính năng) | `export_computers` |
| **Xuất kèm key** | Mỗi dòng một key, kèm **recovery password** | Theo tab Tính năng: tắt (mặc định) / chỉ Admin HQ / IT, Trưởng IT và Admin HQ | Mỗi key một dòng `reveal` + một dòng `export_keys`; Admin HQ nhận cảnh báo |

Xuất kèm key qua trang xác nhận (số key, số máy) và bắt chọn lý do như khi hiện key. CSV có BOM UTF-8 và vô hiệu ô bắt đầu bằng `= + - @`. **Lưu file có key ở nơi an toàn và xóa ngay khi dùng xong.**

### 6.5. Thông tin bổ sung của máy và cách tìm

Mỗi máy có hai trường do người dùng nhập: **Serial máy** và **Email người dùng** (sync không bao giờ ghi đè). Bấm **Sửa thông tin** ở trang chi tiết máy; ai xem được key của máy thì sửa được; để trống để xóa; mỗi lần lưu ghi `computer_edit` (giá trị trước và sau). Hai trường có trong cả hai file CSV. API: `PUT /api/computers/:id/info` `{ deviceSerial, ownerEmail }`.

Ô **Tìm máy** (trong phạm vi chi nhánh của bạn, không phân biệt hoa thường):

- **Key ID**: từ **4 ký tự đầu** (màn hình BitLocker hiện 8 ký tự), hoặc cả Key ID; có hay không dấu `-` đều được.
- **Tên máy, serial, email**: một phần bất kỳ từ 3 ký tự, bỏ qua `-`, `_`, `.` và khoảng trắng (`lt0231` ra `HN-LT-0231`); 2 ký tự thì chỉ khớp phần đầu. Khớp đúng xếp trước.
- Chuỗi vừa giống Key ID vừa là một phần tên máy (`0231`): hiện cả hai kết quả.
- **GUID máy** (objectGUID): dán cả GUID.

### 6.6. Mẫu email

Nội dung mọi email và tin Teams nằm trong **một file**: `server/templates/mail-templates.yaml`, có sẵn đủ mẫu tiếng Việt; chỉ sửa khi muốn đổi câu chữ. Đầu file có bảng giải thích từng mẫu và biến. Mỗi mẫu có `subject` và `body` (phần bạn sửa), cùng `used_by`, `sent_when`, `recipients`, `variables` để tra cứu.

Các mẫu chính: `sync_failed`, `sync_anomaly`, `worker_offline`, `sync_problem`, `backup_failed`, `key_duplicate`, `reveal_out_of_hours`, `key_export`, `new_objects`, `daily_report`, `smtp_test` (và bản `_recovered` của một số mẫu). Các điều kiện của watchdog (`sync_stale`, `ldap_error`...) không gửi mail riêng, chỉ hiện trong app và trong mail `sync_problem`. Mẫu cảnh báo (`kind: alert`) được thêm tiền tố `alert_subject_prefix` (`[BitLocker][HIGH] `...) ở dòng đầu file.

**Cách sửa:** sửa `subject` / `body`, giữ tên mẫu và thụt lề YAML (`body: |` cho nhiều dòng); chỉ dùng biến có trong `variables` của mẫu (sai tên thì hiện nguyên `{{tên_sai}}`); không biến nào chứa recovery password. Lưu file là xong, **không cần khởi động lại**. File hỏng thì app giữ bản tốt trước đó và ghi lỗi `mail templates: bad edit ignored`; lúc khởi động, file hỏng làm app từ chối chạy. Thử bằng **Gửi thử** ở Quản trị > Mail server.

**File cần sửa ở đâu:**

| Môi trường | File |
| --- | --- |
| Dev | `server/templates/mail-templates.yaml` (watch tự chép) |
| Production Docker | Chép ra máy chủ (ví dụ `/etc/blk/mail-templates.yaml`), mount `-v /etc/blk/mail-templates.yaml:/app/config/mail-templates.yaml:ro` và đặt `MAIL_TEMPLATES_FILE=/app/config/mail-templates.yaml`, để cập nhật app không ghi đè bản sửa |
| Production không Docker | `server/templates/mail-templates.yaml` hoặc `MAIL_TEMPLATES_FILE` |

Khi nâng cấp app, so file mẫu mới với bản của bạn: nếu thiếu mẫu mới, app báo lỗi.

### 6.7. Thời gian lưu trữ

Tab Quản trị > Lưu trữ. Job `data-retention` chạy hằng ngày (mặc định 03:00) hoặc khi bấm **Dọn dẹp ngay**:

| Dữ liệu | Mặc định | Giới hạn | Ghi chú |
| --- | --- | --- | --- |
| Nhật ký truy cập (`access_log`) | Giữ mãi | Tùy chọn, từ 1 ngày | Xem dưới |
| Lịch sử sync (lượt sync, số liệu, cảnh báo đã đóng) | 180 ngày | Tối thiểu 30 | Luôn giữ lượt sync thành công và lượt full thành công gần nhất |
| Email đã gửi / thất bại | 90 ngày | 1–3650 | Mail chờ gửi không bị xóa |

Máy, recovery key và người dùng không bao giờ bị xóa.

Nhật ký truy cập là append-only: app không có quyền DELETE, trigger chặn UPDATE / DELETE / TRUNCATE. Khi bật hạn lưu trữ, việc xóa chỉ đi qua hàm `purge_access_log()`: chỉ xóa **phần cũ nhất liên tục từ đầu chuỗi**, không xóa dòng mới nhất, và lưu mốc (số dòng, người chạy) vào `access_log_purge`. Việc xóa được ghi nhật ký (`log_purge`). Nên lưu bản sao nhật ký ở nơi khác (hệ thống thu log, mục 6.15) trước khi bật.

### 6.8. Sao lưu và khôi phục

Quản trị > **Sao lưu** (Admin HQ) tạo file **.zip** theo lịch hằng ngày hoặc khi bấm **Sao lưu ngay**. Chọn một hoặc cả hai loại:

| Loại | File | Nội dung |
| --- | --- | --- |
| Máy và key | `bitlocker-keys-YYYYMMDD-HHMMSS.zip` | `computers.csv` (id, objectGUID, tên, DNS, DN, chi nhánh, OS, serial, email, ngày tạo / sửa trên AD, trạng thái giám sát, số key), `recovery_keys.csv` (Key ID, **mật khẩu khôi phục**, DN key, volume GUID, trạng thái, ngày giờ, máy chứa key), `key_moves.csv`, `manifest.json` (SHA-256), `README.txt`. Tra key khi hệ thống hoặc DB không chạy |
| Database | `bitlocker-db-YYYYMMDD-HHMMSS.zip` | `bitlocker.dump` (`pg_dump` toàn bộ DB), `manifest.json`. Khôi phục toàn hệ thống |

- **Mã hóa AES-256** (mặc định bật, nên giữ): mở bằng **7-Zip** hoặc WinRAR, File Explorer không mở được. Tắt thì là zip thường, ai có file đọc được mọi key:
  chỉ tắt khi nơi chứa đã mã hóa và giới hạn quyền (trang hiện cảnh báo đỏ; bảng file có cột Mã hóa).
- **Mật khẩu** (≥ 16 ký tự; ô chỉ nhập được khi tích "Mã hóa", không thì bị mờ): lưu mã hóa, **không hiện lại**, không ghi vào file. **Giữ ở kho mật khẩu**: mất là không mở được file.
  Đổi mật khẩu thì file cũ vẫn dùng mật khẩu cũ.
- **Sao lưu ngay** chạy nền (trang báo "Đang sao lưu", tải lại sau ít phút xem kết quả); mỗi lúc chỉ một lượt. Dump database ghi thẳng ra file rồi mã hóa theo luồng, nên RAM không tăng theo cỡ DB (giới hạn 4 GB mỗi file zip).
- **Giờ chạy** theo `APP_TZ` (mặc định 01:30), chạy bù nếu app tắt lúc đến giờ. **Giữ N bản mới nhất** mỗi loại (mặc định 14).
- Ghi nhật ký `backup_run`, `backup_download` (không chứa key). Lượt lỗi gửi cảnh báo "Sao lưu lỗi".
- File nằm ở `BACKUP_DIR` (Docker: `./backups`), **cùng máy chủ**: cần job chép sang nơi khác hằng ngày.

**Cài sao lưu database (một lần).** Dùng `pg_dump` (có sẵn trong image) với tài khoản **chỉ đọc** `blk_backup` (cần `BYPASSRLS` để dump đủ mọi chi nhánh):

```sql
CREATE ROLE blk_backup LOGIN NOSUPERUSER NOCREATEROLE BYPASSRLS PASSWORD '<mật-khẩu-backup>';
\c blk
GRANT USAGE ON SCHEMA public TO blk_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO blk_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO blk_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE blk_owner IN SCHEMA public GRANT SELECT ON TABLES TO blk_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE blk_owner IN SCHEMA public GRANT SELECT ON SEQUENCES TO blk_backup;
```

Cài bằng `tools/install.sh` thì `BACKUP_DATABASE_URL` đã được điền sẵn (DB trong Docker: tài khoản `blk_backup` có sẵn). Nếu tự cài, thêm vào `server/.env`: `BACKUP_DATABASE_URL=postgres://blk_backup:<mk>@<db-host>:5432/blk?sslmode=require` và `BACKUP_DIR=/app/backups`
(ngoài Docker cần `pg_dump` 17, hoặc `PG_DUMP_PATH`). Trên Linux cho uid 1000 quyền ghi `./backups`
(`sudo chown 1000:1000 backups && sudo chmod 700 backups`). Rồi vào trang Sao lưu: đặt mật khẩu, chọn loại, giờ, bật, bấm **Sao lưu ngay** để thử. **Thử khôi phục định kỳ.**

**Tra key khi hệ thống không chạy.** Giải nén `bitlocker-keys-*.zip` bằng 7-Zip vào thư mục chỉ mình bạn đọc được, mở `recovery_keys.csv` bằng Excel
(Data > From Text/CSV, UTF-8), lọc cột `key_id_first8` theo 8 ký tự trên màn hình BitLocker, đọc `recovery_password`. Xong thì **xóa** file giải nén.

**Khôi phục database (một lệnh).** Cần DB `blk` (trong Docker hay ngoài đều được) và hai tài khoản `blk_owner`, `app_node` (mục 3.2 hoặc 3.3). Chép file `bitlocker-db-....zip` vào `./backups`, rồi:

```bash
docker compose run --rm --no-deps server node src/cli/restore.js backups/bitlocker-db-20261018-013000.zip
```

Lệnh hỏi mật khẩu của file, kiểm tra SHA-256, nạp dữ liệu, chạy migration và báo kết quả (kèm các mật khẩu cần nhập lại). DB đã có dữ liệu thì từ chối trừ khi thêm `--force`. Tùy chọn:

| Tùy chọn | Dùng khi |
| --- | --- |
| `--force` | Thay toàn bộ dữ liệu đang có (hỏi gõ lại tên DB; thêm `--yes` để bỏ hỏi) |
| `--reset-2fa` | Tắt xác thực 2 bước cho mọi user (khi 2 bước không đọc được hoặc mất điện thoại) |
| `--reset-admin` | Cấp mật khẩu một lần mới cho admin gốc (in một lần, phải đổi khi đăng nhập) |

Xong thì khởi động app, đăng nhập và chạy một lượt full. Mật khẩu file lấy từ ô nhập, hoặc biến `RESTORE_ZIP_PASSWORD`. Cần `pg_restore` 17 (đã có trong image). File zip lớn hơn 1,5 GB: giải nén bằng 7-Zip rồi `pg_restore --no-owner -d blk bitlocker.dump`.

**Sau khi khôi phục.** Các mật khẩu lưu mã hóa trong DB (SMTP, mật khẩu sao lưu, khóa 2 bước) chỉ đọc được trên máy cùng `SECRET_KEY` với bản sao lưu. Máy mới thì lệnh tự xóa những giá trị không đọc được và báo, bạn chỉ cần vào Quản trị nhập lại: mật khẩu mail server, mật khẩu sao lưu; user có 2 bước sẽ quét mã QR mới ở lần đăng nhập kế (hoặc `--reset-2fa` để tắt hẳn 2 bước). Dữ liệu máy, key, người dùng, nhật ký còn nguyên.

**Sao lưu tay** trước khi nâng cấp: `pg_dump -U blk_backup -h <db-host> -d blk --format=custom -f bitlocker.dump`, rồi `7z a -tzip -mem=AES256 -p x.zip bitlocker.dump` và `shred -u bitlocker.dump`.

Cất **tách khỏi** file sao lưu: `SECRET_KEY`, `server/.env`, mật khẩu sao lưu, `cert/` và cấu hình worker.

### 6.9. Quản lý người dùng bằng dòng lệnh

Chạy trên máy chủ app, **không cần web**: dùng khi web hỏng, quên mật khẩu, mất điện thoại 2 bước hoặc tài khoản bị khóa. Áp dụng cho mọi tài khoản, kể cả admin gốc (mục 6.14). Mỗi lệnh ghi nhật ký `admin_change` với người thực hiện là `cli`.

```bash
docker compose exec server node src/cli/users.js list
docker compose exec server node src/cli/users.js create nguyenvana "Nguyen Van A" email=nguyenvana@corp.local it:HN
docker compose exec server node src/cli/users.js create-local backup.admin "Backup admin" email=it-hq@corp.local admin
docker compose exec server node src/cli/users.js email admin it-hq@corp.local
docker compose exec server node src/cli/users.js reset-password <user>   # mật khẩu một lần mới (chỉ tài khoản local), phải đổi ở lần đăng nhập đầu
docker compose exec server node src/cli/users.js unlock <user>           # mở khóa (bị khóa do nhập sai mật khẩu)
docker compose exec server node src/cli/users.js disable-2fa <user>      # tắt hẳn đăng nhập 2 bước của user
docker compose exec server node src/cli/users.js reset-2fa <user>        # quên authenticator: lần đăng nhập tới quét QR mới
docker compose exec server node src/cli/users.js enable <user>           # bật lại tài khoản bị vô hiệu hóa (disable: tắt)
```

| Việc | Lệnh |
| --- | --- |
| Quên mật khẩu (tài khoản local) | `reset-password` |
| Bị khóa vì nhập sai | `unlock` |
| Mất điện thoại, muốn quét lại | `reset-2fa` |
| App xác thực hỏng, cần vào ngay | `disable-2fa` (bật lại ở Quản trị > Người dùng) |
| Tài khoản AD | mật khẩu do AD quản lý; `reset-password` không áp dụng |


### 6.10. Truy vết sync trong log

**Số của lượt sync.** Mỗi lượt có **STT** `runId` (số nguyên tăng dần, khóa nội bộ, worker dùng số này) và **mã hiển thị** `runRef` dạng `YYYYMMDD-NNNN` (ngày chạy theo `APP_TZ` + STT 4 chữ số, ví dụ `20261018-0042`). Giao diện, email và log hiện mã hiển thị; STT có trong tooltip và JSON. Không dùng thời gian làm số chính vì đồng hồ có thể lùi (NTP, khôi phục máy ảo) làm sai thứ tự; STT luôn tăng. Khôi phục DB từ bản sao lưu thì STT quay về giá trị lúc sao lưu, ngày trong mã giúp phân biệt.

Mọi thay đổi do sync tạo ra được ghi vào log ứng dụng (JSON, mỗi dòng một sự kiện, tiếng Anh) với `"component":"sync"` và `runId`, sau khi dữ liệu đã commit. Máy / key không đổi chỉ được đếm trong dòng tổng kết nên lượt full 22k máy không làm ngập log. Log không bao giờ chứa recovery password.

| `msg` | Khi nào |
| --- | --- |
| `sync run opened` / `sync run completed` / `sync run failed` | Mở / kết thúc lượt (mode, dc, số máy / key thấy, `highestUsn`, `markedNotInAd` hoặc `errorCode`) |
| `computer added` | Máy mới |
| `computer moved to another branch` | DN đổi sang OU chi nhánh khác (cũng ghi `computer_moved` vào Nhật ký) |
| `computer renamed or moved in AD` | Đổi tên, hoặc đổi OU trong cùng chi nhánh |
| `computer back in AD` | Máy từng "Không còn trong phạm vi giám sát" xuất hiện lại |
| `computer not seen by the full run: flagged not in AD` | Máy bị gắn nhãn "Không còn trong phạm vi giám sát" |
| `key added`, `key volume recorded`, `key superseded ...` | Key mới, bổ sung ổ đĩa, đổi trạng thái |
| `key without a readable password`, `key with a malformed password` (warn) | Key không lưu được: mật khẩu rỗng (thiếu quyền) hoặc sai định dạng |
| `key for an unknown computer (sent back as orphan)` | Key của máy chưa có trong DB |
| `computer batch stored`, `key batch stored` | Tổng kết một lô (received, added, unchanged...) |
| `sync anomaly` (warn), `sync run quarantined`, `quarantined sync run decided` | Bất thường, lượt bị giữ lại, Admin HQ chấp nhận / bác bỏ (mục 6.1) |

Truy vết: lọc theo `"runId":812`, `"name":"HN-LT-0231"`, `"objectGuid":"..."` hoặc `"keyId":"..."`, ví dụ:

```bash
docker compose logs server | grep '"component":"sync"' | grep '"runId":812'
```

#### Log nằm ở đâu, rotate thế nào

App không tự ghi file: mọi log (kể cả sync) in ra **stdout** dạng JSON, môi trường chạy app giữ và xoay vòng.

| Cách chạy | Log nằm ở | Rotate |
| --- | --- | --- |
| `docker compose` | `docker compose logs server` | Đã cấu hình sẵn trong file compose (driver `local`, có nén) |
| Node bằng systemd | `journalctl -u blk` | journald tự xoay vòng; giới hạn bằng `SystemMaxUse=2G` |
| Node ghi ra file | File bạn chọn | logrotate với `copytruncate` |

Trên Linux, Docker mặc định dùng `json-file` **không rotate**, log lớn mãi tới khi đầy đĩa: luôn đặt một cấu hình ở trên. Muốn giữ lâu và tìm kiếm, đẩy log JSON về hệ thống tập trung (Loki, ELK / OpenSearch, Graylog, SIEM; mục 6.15). Nhật ký truy cập (ai xem key) nằm trong database, không phải log này.

---

### 6.11. Trang Báo cáo

Dành cho Trưởng IT, Admin HQ và Auditor, trong phạm vi chi nhánh của người xem. Chọn **kỳ báo cáo**
(mặc định 30 ngày gần nhất, tối đa 366 ngày, có nút nhanh 7 / 30 / 90 ngày), hoặc tích **Toàn bộ thời gian**
(nút nhanh **Toàn bộ**: từ ngày đầu tiên có dữ liệu đến hôm nay, không giới hạn 366 ngày, bỏ qua ô ngày); có thể
chọn một chi nhánh. Nút **Xuất Excel** xuất đúng kỳ đang xem, kể cả Toàn bộ thời gian. Đổi ngày, chi nhánh hoặc tick "Toàn bộ thời gian" thì trang **tự áp dụng** (không cần bấm "Lọc"); nút nhanh đang dùng được tô nổi. Bộ lọc ở Máy, Báo cáo, Nhật ký truy cập, Log email cùng một kiểu: tự áp dụng khi đổi, có nút **Lọc** và **Xóa lọc**.
Hai ô **Đăng nhập AD** và **Chưa có dữ liệu đăng nhập AD** (giống Tìm máy, mục 6.4) lọc các máy được tính trong báo cáo, cả trên trang lẫn trong file Excel (Excel ghi dòng "Lọc đăng nhập AD" ở sheet Tổng quan): số máy, số key, máy mới và máy rời phạm vi chỉ tính máy khớp; lượt hiện key không bị lọc. Số máy, số key là số **hiện tại**; máy mới, key mới, máy rời phạm vi giám sát và lượt hiện key tính **trong kỳ**.

| Phần | Nội dung |
| --- | --- |
| Tổng quan | Số chi nhánh, máy trong phạm vi giám sát, % máy có key, số key, máy/key mới và máy rời phạm vi giám sát trong kỳ, lượt hiện key (số người, số máy, số lượt ngoài giờ) |
| Chi tiết theo chi nhánh | **Liệt kê mọi chi nhánh**, kể cả chi nhánh chưa có máy hoặc chưa có key (ghi 0), chia trang theo "Số dòng mỗi trang" (mục 6.3); mỗi chi nhánh: máy, có key, chưa có key, % có key (dưới 90% được tô màu), số key, máy mới, key mới, rời phạm vi giám sát; dòng tổng |
| Hoạt động của máy | Theo lần đăng nhập AD gần nhất: mỗi chi nhánh có số máy **hoạt động gần đây**, **không hoạt động gần đây**, **chưa có dữ liệu** và % hoạt động (tính trên máy đã có dữ liệu); bấm số để mở danh sách ở trang Tìm máy với bộ lọc tương ứng. Ngưỡng "gần đây" ở Ngưỡng cảnh báo (mặc định 3 tháng) |
| Xem key theo chi nhánh | Mỗi chi nhánh: lượt hiện key, số người xem, số máy được xem, ngoài giờ, xuất kèm file, lý do nhiều nhất; bên dưới là bảng người xem key theo chi nhánh |
| Máy chưa có key | Máy còn trong phạm vi giám sát chưa lưu key (trạng thái hiện tại, không theo kỳ). **Tất cả chi nhánh**: chỉ bảng tổng quan theo chi nhánh (chưa có key, lâu hơn 7 ngày, mới ≤ 7 ngày, link **Xem danh sách** sang trang Tìm máy), xếp chi nhánh nhiều máy lâu chưa có key lên đầu. **Một chi nhánh** (hoặc người xem chỉ có một chi nhánh): danh sách từng máy, máy lâu nhất lên đầu, cột số ngày chưa có key, nhãn "mới". Máy mới ghi nhận ≤ 7 ngày có thể vẫn đang chờ GPO. File Excel theo cùng quy tắc: tất cả chi nhánh thì sheet "Máy chưa có key" chỉ là bảng tổng hợp theo chi nhánh; một chi nhánh thì có danh sách từng máy |
| Máy đã có key (chỉ trong file Excel của **một chi nhánh**) | Sheet **"Máy đã có key"**, đặt ngay trước sheet "Máy chưa có key": mỗi máy còn được giám sát có ít nhất một key, kèm **số key** của máy (cột "Số key"), ngày tạo key mới nhất, tên, hệ điều hành, serial, email người dùng, DN; dòng cuối là tổng số máy và tổng số key. Không có Key ID hay mật khẩu. File Excel của tất cả chi nhánh không có sheet này |

"Ngoài giờ" chỉ được tính khi đã cấu hình giờ làm việc (cảnh báo xem key ngoài giờ).

Nút **Xuất Excel** tải file `.xlsx` theo đúng kỳ và chi nhánh đang chọn, gồm 6 sheet: *Tổng quan*,
*Theo chi nhánh*, *Xem key theo CN* (thêm một cột cho mỗi lý do), *Người xem key*, *Máy chưa có key*, *Máy rời phạm vi* (máy rời phạm vi giám sát trong kỳ, kèm số key vẫn lưu).
Sheet *Tổng quan* và *Theo chi nhánh* có thêm số máy hoạt động / không hoạt động / chưa có dữ liệu, các sheet danh sách máy có cột "Đăng nhập AD gần nhất". Mỗi sheet có dòng tiêu đề cố định và bộ lọc; ngày giờ theo `APP_TZ`. File **không bao giờ chứa
recovery key**. Mỗi lần xuất ghi một dòng `export_report` vào nhật ký.

**Báo cáo hằng ngày bằng email** (Quản trị > Thông báo, mặc định tắt):

- Mỗi ngày **một** email (HTML + bản chữ thường) gửi Admin HQ có email (nếu chọn) và các địa chỉ thêm. **Giờ gửi** theo `APP_TZ` (mặc định 07:30); quá giờ mà hôm nay chưa gửi thì gửi (app tắt lúc đến giờ thì gửi bù). Bật sau giờ gửi thì báo cáo đầu tiên vào ngày mai.
- **Số liệu của**: *Hôm qua (cả ngày)* hợp gửi buổi sáng; *Hôm nay, tính đến giờ gửi* hợp gửi cuối ngày.
- Nội dung: trạng thái **Worker** và **Đồng bộ AD** (từng worker: heartbeat, LDAP, DC), lượt sync thành công / lỗi / bị giữ lại, cảnh báo đang mở, Key ID trùng chưa xem xét; tổng **máy** và **key** kèm tăng / giảm; máy / key mới, máy rời phạm vi giám sát, key chuyển máy; tối đa 15 chi nhánh có thay đổi; biểu đồ cột 10 ngày gần nhất (bảng HTML nên hiện được trên Outlook, Gmail, điện thoại). Không có recovery key, không liệt kê máy.
- Tiêu đề và câu mở đầu sửa ở mẫu `daily_report` (mục 6.6). **Gửi thử báo cáo ngay** gửi tức thì (không tính là báo cáo theo lịch); Log email có nút **Xem bản HTML**.

### 6.12. Định danh máy và key, các tình huống thường gặp

Hệ thống **không định danh theo tên**: máy theo `objectGUID` do AD cấp (không đổi khi đổi tên hay chuyển OU, không cấp lại); key theo Key ID (`msFVE-RecoveryGuid`, 8 ký tự đầu hiện trên màn hình recovery) và thuộc máy có `objectGUID` mà worker gửi kèm key.

**Không bao giờ xóa** máy hay key (tài khoản ứng dụng không có quyền DELETE trên hai bảng này). Máy rời phạm vi chỉ đổi trạng thái; xóa chi nhánh chỉ chuyển máy về N/A. Key của máy ngoài phạm vi hiện nhãn xám **"Máy ngoài phạm vi"** (key vẫn lưu và tra được).

| Tình huống | Hệ thống làm gì |
| --- | --- |
| **Máy đổi tên / chuyển OU** | Cùng GUID nên vẫn **một máy**: cập nhật tên, DN, chi nhánh (ghi `computer_moved` nếu đổi chi nhánh); giữ key, lịch sử, serial / email đã nhập; không email "máy mới". Tìm tên cũ không ra, tìm GUID hoặc Key ID vẫn ra |
| **Máy bị xóa khỏi AD rồi join lại cùng tên** | AD tạo **object mới, GUID mới** nên thành **máy mới**. Máy cũ ở lượt full kế tiếp thành "ngoài phạm vi", **giữ key cũ**. Serial / email của máy cũ không tự chép sang |
| Máy cài lại nhưng admin **"Reset account"** | Vẫn object cũ, cùng GUID: vẫn máy cũ, key mới thêm vào cùng máy |
| **Key mới cho cùng một ổ đĩa** (cùng `msFVE-VolumeGuid`) | Thêm key mới, không ghi đè: key mới **Đang dùng**, key cũ của ổ đó **Có key mới hơn** (vẫn giữ). Ổ khác không ảnh hưởng |
| Đẩy lại đúng key cũ | Cùng Key ID: không có gì mới, không email |
| **Unjoin rồi join lại, đẩy lại key cũ** (Key ID không đổi, nằm dưới object mới) | Key **chuyển sang máy mới** (không xóa, không nhân đôi) và ghi lịch sử chuyển. **Cùng tên, cùng domain**: chuyển ngay, máy cũ thành "ngoài phạm vi". **Khác tên**: tạm ghi là Key ID trùng, lượt full sau thấy máy cũ rời phạm vi thì chuyển và tự đóng, không mail |
| **Cùng Key ID dưới 2 máy đều còn trong phạm vi** (clone image đã bật BitLocker) | Key **giữ ở máy đang giữ**, ghi Key ID trùng; sau khi lượt full xác nhận, gửi **1 mail** (mỗi cặp 1 lần). Xem ở Quản trị > Sync AD, hai nút: **Gán cho máy mới hơn** (so ngày tạo trên AD của 2 máy, key chuyển sang máy tạo sau; không thực hiện nếu mật khẩu khác nhau, thiếu ngày tạo hoặc máy đang giữ key đã là máy mới hơn) và **Dùng chung 2 máy** (key giữ nguyên, trang của cả 2 máy hiện ghi chú dùng chung, không đổi quyền xem). Cả hai đóng cảnh báo và ghi `key_duplicate_review` kèm kết quả. Tự đóng khi một máy rời phạm vi |
| Cùng Key ID nhưng **mật khẩu khác** | Không chuyển, không ghi đè; xử lý như Key ID trùng |
| Key bị xóa trong AD | Hệ thống vẫn giữ |

Khi xóa máy khỏi AD, AD xóa luôn key của máy. Xóa **nhiều** máy cùng lúc làm lượt full thấy giảm mạnh nên bị **giữ lại** chờ Admin HQ duyệt (mục 6.1): đó là cơ chế an toàn, không phải lỗi.

### 6.13. Hiện key và sao chép

Trang hiện key cho thấy 8 nhóm số và tự ẩn sau 60 giây. **Sao chép key** chép cả key kèm dấu gạch ngang (dán thẳng vào màn hình BitLocker); khi key ẩn, trang cố xóa clipboard (trình duyệt có thể không cho, nên tự copy nội dung khác sau khi dùng). Sao chép cần HTTPS hoặc localhost, không được thì trang chọn sẵn key để bấm Ctrl+C. Mọi lần hiện key đều được ghi nhật ký kèm lý do.

### 6.14. Bảo mật tài khoản: 2 bước, khóa, mật khẩu, phiên, admin gốc

**Xác thực 2 bước** (TOTP, Microsoft/Google Authenticator), bật **từng người** ở Quản trị > Người dùng > ô **Bắt buộc xác thực 2 bước** (tài khoản AD và nội bộ đều dùng được).

- Lần đăng nhập đầu sau khi bật: nhập mật khẩu, quét **mã QR** (hoặc nhập khóa), nhập mã 6 số. Từ lần sau: mật khẩu rồi mã 6 số. Chưa đúng mã thì chưa đăng nhập; trang nhập mã hết hạn sau 5 phút.
- Mã đổi mỗi 30 giây, **mỗi mã dùng một lần**. Sai mã tính như sai mật khẩu (xem khóa tài khoản).
- Khóa bí mật được mã hóa (khóa suy ra từ `SECRET_KEY`) và không hiện lại; đổi `SECRET_KEY` thì mọi người phải thiết lập lại.
- **Mất / đổi điện thoại**: Admin HQ bấm **Đặt lại xác thực 2 bước** ở trang sửa người dùng (hoặc CLI `reset-2fa`, mục 6.9). Bỏ chọn ô Bắt buộc rồi lưu thì tắt hẳn.
- API: `POST /api/auth/login` trả `{ secondFactor: 'setup' | 'code', csrfToken }`; lần đầu `GET /api/auth/2fa/setup`, rồi `POST /api/auth/2fa` `{ code }`. Tài khoản dùng cho script nên tắt 2 bước.

**Khóa tài khoản khi đăng nhập sai** (Quản trị > Bảo mật, áp dụng ngay): số lần sai liên tiếp (3–20, mặc định 5), thời gian khóa (mặc định 15 phút; **0 = khóa tới khi Admin HQ mở**), có áp dụng cho Admin HQ hay không (mặc định có), hoặc tắt hẳn. **Mở khóa**: Admin HQ vào Người dùng > Sửa > **Mở khóa**; nếu chính Admin bị khóa, dùng CLI `unlock <tên>` (mục 6.9). Nên có một Admin dự phòng.

**Mật khẩu tài khoản nội bộ** (Quản trị > Bảo mật): độ dài tối thiểu (8–64, mặc định 12) và bắt buộc chữ hoa / thường / số / ký tự đặc biệt (tùy chọn); luôn không chứa tên đăng nhập và khác mật khẩu hiện tại. Mật khẩu một lần do hệ thống tạo luôn đạt chính sách; tài khoản AD theo chính sách của AD. **Bắt đổi mật khẩu ở lần đăng nhập sau**: ô ở trang sửa người dùng (chỉ tài khoản nội bộ; tài khoản mới và mật khẩu vừa đặt lại luôn phải đổi).

**Thời gian phiên** (Quản trị > Bảo mật, áp dụng trong 30 giây): **tự đăng xuất sau X phút không hoạt động** (mặc định `SESSION_IDLE_MINUTES`, 15; trang đang mở cũng chuyển về đăng nhập) và **thời gian tối đa của phiên** (mặc định `SESSION_MAX_HOURS`, 8).

**Admin gốc (siêu quản trị).** Tài khoản `admin` tạo lúc khởi tạo, có nhãn **Superadmin** ở Quản trị > Người dùng:

- **Không admin nào khác** đổi được nó (sửa, đặt lại mật khẩu / 2 bước, gỡ liên kết AD, mở khóa: web và API trả 403); chỉ chính nó tự đổi.
- Chỉ nó được **bỏ quyền admin hoặc khóa** admin khác. Admin thường vẫn sửa email, chi nhánh, 2 bước... của admin khác.
- Nó không tự bỏ quyền hay tự khóa mình, nên luôn còn ít nhất một admin.
- Khi web hỏng hoặc mất mật khẩu / điện thoại: dùng CLI trên máy chủ (mục 6.9), áp dụng cho mọi tài khoản kể cả admin gốc.

### 6.15. Log ra stdout cho hệ thống thu log (SIEM...)

Ngoài log ứng dụng, app ghi ra **stdout** của container server, mỗi sự kiện **một dòng JSON** (`log_type` để lọc). Hệ thống thu log của bạn (SIEM, Promtail, Filebeat, driver Docker...) đọc stdout; app không có cấu hình riêng cho việc này.

| `log_type` | Tương ứng | Khi nào |
| --- | --- | --- |
| `audit` | Nhật ký truy cập | Ngay khi dòng nhật ký được lưu (kèm `id`) |
| `mail` | Log email | Mỗi lần đổi trạng thái của email |
| `sync_run` | Danh sách lượt sync | Mở, kết thúc, bị giữ lại, đã quyết định |
| `alert` | Cảnh báo | Mở, đã gửi, đã đóng |

Không dòng nào chứa recovery password; không phụ thuộc `LOG_LEVEL`. Ghi **bất đồng bộ và chấp nhận mất**: hàng đợi đầy thì bỏ dòng mới và ghi một dòng `event_gap` cho biết số dòng bị bỏ; không lưu trạng thái, không gửi bù khi khởi động lại. Dùng `id` của dòng nhật ký để bỏ trùng.

### 6.16. Lịch chạy các job

Mỗi job có giờ / chu kỳ mặc định, chỉnh ngay trên trang của job, áp dụng trong một phút, không cần khởi động lại. Giờ theo `APP_TZ`.

| Job | Mặc định | Chỉnh ở |
| --- | --- | --- |
| Gửi mail đang chờ | mỗi **1 phút** (1–60) | Quản trị > Mail server |
| Watchdog | mỗi **5 phút** (1–60) | Quản trị > Đồng bộ AD > Cảnh báo sync |
| Dọn dữ liệu quá hạn | **03:00** | Quản trị > Lưu trữ |
| Báo cáo email hằng ngày | **07:30** (tắt) | Quản trị > Thông báo |
| Sao lưu | **01:30** (tắt) | Quản trị > Sao lưu |

Giờ đọc AD của **worker** (delta 15 phút, full 01:00, heartbeat 5 phút) nằm trong file cấu hình của worker (`Schedule.*`, mục 4).

## 7. Xử lý sự cố

| Hiện tượng | Nguyên nhân thường gặp | Cách xử lý |
| --- | --- | --- |
| App không khởi động, log ghi `Invalid configuration` | Thiếu hoặc sai biến trong `.env` | Đọc tên biến trong log, sửa `.env` (mục 3 có đủ các biến cần sửa) |
| `/healthz` trả 503 | Không kết nối được DB | Kiểm tra `DATABASE_URL`, tường lửa, `DB_SSL` |
| Đăng nhập báo tài khoản bị khóa (kể cả Admin) | Nhập sai mật khẩu quá số lần cho phép (Quản trị > Bảo mật) | Chờ hết thời gian khóa, hoặc Admin khác mở khóa; không còn Admin nào thì `docker compose exec server node src/cli/users.js unlock <tên>` (mục 6.14) |
| Đăng nhập AD báo không kết nối được máy chủ AD | Sai `LDAP_SERVERS` / `LDAP_PROTOCOL`, chặn cổng 389 hoặc 636, hoặc app không tin CA của DC | Thử `openssl s_client -connect dc01.corp.local:636`, đặt `LDAP_CA_FILE` |
| Tài khoản AD "không khớp" | Tài khoản AD bị xóa rồi tạo lại | Admin bấm "Gỡ liên kết AD" cho user đó |
| Worker nhận 401 | Sai API key | So khớp `INGEST_API_KEY` với `Ingest:ApiKey` (mã hóa lại bằng `protect`) |
| Worker nhận 403 | IP worker không có trong `INGEST_ALLOWED_IPS` | Log server ghi `ingest: address not allowed` kèm IP nhìn thấy; bổ sung IP rồi khởi động lại server |
| Worker không kết nối được HTTPS (lỗi chứng chỉ) | Máy worker không tin CA, hoặc `BaseUrl` dùng IP / tên không có trong chứng chỉ | Mục 3.6: đặt `Ingest.CaFile`, dùng đúng tên |
| Key không có mật khẩu (`keysEmptyPassword` > 0) | Tài khoản worker thiếu quyền đọc `msFVE-RecoveryPassword` | Cấp quyền theo mục 4.1, chạy `check` |
| Worker Go: `ldap_tls_failed`, connection reset ở 636 | DC chưa có chứng chỉ TLS | Cấp chứng chỉ cho DC, hoặc dùng `Protocol: Ldap` (mặc định, mục 4B.2) |
| Worker Go: `x509: certificate signed by unknown authority` | Máy Linux không tin CA của DC | Đặt `Ldap.CaFile` hoặc cài CA vào kho hệ thống |
| Lượt sync bị giữ lại liên tục | Ngưỡng không hợp với thực tế, hoặc DB còn dữ liệu thử | Xem lý do trên tab Quản trị > Sync AD, chấp nhận hoặc bác bỏ |
| Máy hiện "Không còn trong phạm vi giám sát" | Máy bị xóa khỏi AD, hoặc nằm ngoài `SearchBases` của worker | Kiểm tra AD và `SearchBases`. Máy xuất hiện lại trong AD thì nhãn tự mất |
| Lượt sync lỗi `ldap_search_base_failed` | Một OU trong `SearchBases` không tồn tại, bị đổi tên/di chuyển, hoặc tài khoản worker không có quyền đọc | Log worker ghi tên OU. Chạy `check` để xem OU nào `FAIL`, sửa `SearchBases` hoặc cấp quyền (mục 4.1) |
| Trang Tổng quan báo dữ liệu có thể đã cũ | Worker dừng, lỗi, hoặc lượt sync bị giữ lại | Xem Quản trị > Sync AD và log worker; ngưỡng ở Quản trị > Đồng bộ AD > Cảnh báo sync |
| Quên mật khẩu, mất điện thoại 2 bước, web hỏng | | CLI trên máy chủ: `reset-password`, `reset-2fa`, `disable-2fa`, `unlock` (mục 6.9) |
| Sao lưu lỗi hoặc "Đang sao lưu" mãi | `pg_dump` lỗi, hết đĩa, sai `BACKUP_DATABASE_URL` | Xem "Lần chạy gần nhất" ở Quản trị > Sao lưu và log server (mục 6.8) |
| Không nhận được email | Chưa bật mail server, sai SMTP, hoặc người nhận chưa có email | Quản trị > Mail server > **Gửi thử** để xem lỗi; Quản trị > Log email xem trạng thái và lỗi từng mail; kiểm tra email của user ở Quản trị > Người dùng |
| App không khởi động, log nhắc `mail-templates.yaml` | File mẫu email hỏng hoặc thiếu mẫu | Sửa theo thông báo (tên mẫu thiếu), hoặc lấy lại file mẫu gốc trong repo (mục 6.6) |
| `/api/docs` trả 401 | Chưa đăng nhập web | Đăng nhập web trước, rồi mở lại `/api/docs` |

---

## 8. Tham chiếu

### 8.1. Biến môi trường của server

| Biến | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` bật các kiểm tra bảo mật khi khởi động |
| `USER_HOST`, `USER_PORT` | `127.0.0.1`, `3000` | Cổng web + `/api` |
| `TRUST_PROXY` | `loopback` | Proxy được tin cho IP người dùng: `1` = một lớp (nginx, khuyến nghị), hoặc IP/dải IP |
| `INGEST_HOST`, `INGEST_PORT` | `0.0.0.0`, `8443` | Cổng ingest API |
| `INGEST_TRUST_PROXY` | | HTTPS ở proxy trước ingest API: `1` = tin nginx, IP worker lấy từ `X-Forwarded-For` |
| `INGEST_TLS_CERT`, `INGEST_TLS_KEY` | | Chỉ khi không dùng nginx: app tự giữ chứng chỉ HTTPS của ingest API |
| `COOKIE_SECURE` | bật khi production | Cookie chỉ gửi qua HTTPS |
| `INGEST_API_KEY` | | API key của worker (32 ký tự trở lên), gửi qua header `Authorization: Bearer` |
| `INGEST_ALLOWED_IPS` | | Danh sách IP được gọi ingest API, cách nhau bởi dấu phẩy |
| `DATABASE_URL` | | Kết nối bằng `app_node` |
| `MIGRATION_DATABASE_URL` | | Kết nối bằng `blk_owner` (chỉ dùng cho migration) |
| `DB_SSL`, `DB_POOL_MAX` | `false`, `10` | Hết kết nối trong pool sau 15 giây thì báo lỗi; câu lệnh chạy quá 120 giây bị hủy |
| `LDAP_SERVERS` | trống (tắt đăng nhập AD) | Danh sách DC dạng `host` hoặc `host:port`, thử lần lượt |
| `LDAP_PROTOCOL` | `ldap` | `ldap` (389, không mã hóa: mật khẩu AD của người dùng đi dạng rõ, app ghi cảnh báo khi khởi động; DC bật "LDAP signing: Require" sẽ từ chối), `starttls` (389 + TLS), `ldaps` (636 + TLS) |
| `LDAP_DOMAIN`, `LDAP_BASE_DN` | | Bắt buộc khi có `LDAP_SERVERS` |
| `LDAP_CA_FILE`, `LDAP_TIMEOUT_MS` | , `8000` | |
| `LOCAL_LOGIN_ENABLED` | `true` | Cho phép đăng nhập bằng tài khoản local |
| `SESSION_SECRET` | | 32 ký tự trở lên |
| `SESSION_IDLE_MINUTES`, `SESSION_MAX_HOURS` | `15`, `8` | Thời gian chờ và thời gian tối đa của phiên (mặc định; Admin HQ đổi được ở Quản trị > Bảo mật) |
| `SECRET_KEY` | | 64 ký tự hex (tên cũ `LOG_HMAC_KEY` vẫn nhận) |
| `BACKUP_DIR` | `backups` | Thư mục ghi file sao lưu (mục 6.8) |
| `BACKUP_DATABASE_URL` | | Tài khoản chỉ đọc `blk_backup` cho `pg_dump`; bỏ trống thì không sao lưu database |
| `PG_DUMP_PATH` | `pg_dump` | Đường dẫn `pg_dump` bản 17 (khi chạy ngoài Docker) |
| `SMTP_URL`, `NOTIFY_FROM`, `NOTIFY_TO`, `TEAMS_WEBHOOK_URL` | | SMTP dự phòng khi chưa cấu hình mail server trong Quản trị; địa chỉ luôn nhận cảnh báo; Teams webhook |
| `MAIL_TEMPLATES_FILE` | `server/templates/mail-templates.yaml` | File mẫu email (mục 6.6) |
| `JOBS_ENABLED`, `APP_TZ` | `true`, `Asia/Ho_Chi_Minh` | Job nền và múi giờ |
| `LOG_LEVEL` | `info` | |

### 8.2. API cho người dùng

Danh sách đầy đủ endpoint, tham số và quyền nằm ở **Swagger**: `https://<server>/api/docs` (dev: https://localhost/api/docs), mở sau khi đăng nhập web (dùng luôn phiên đó). Spec gốc: `/api/docs/openapi.yaml` hoặc `.json` (file `server/openapi/app.openapi.yaml`, mỗi thao tác có `operationId` để sinh client). Một test đối chiếu mọi route trong code với spec, nên thêm API mà quên cập nhật spec thì test báo lỗi. Muốn bấm "Try it out" cho POST/PUT/DELETE: gọi `GET /api/me`, chép `csrfToken`, bấm **Authorize** và dán vào `csrfHeader`.

Lỗi trả về dạng `{ "error": "<mã>", "message": "<tiếng Anh>" }`.

#### Gọi API từ script

API dùng **cùng cách đăng nhập với web**, không có API key riêng: script đăng nhập, giữ cookie phiên rồi gửi kèm mỗi request.

1. **Tài khoản**: API chỉ nhận tài khoản **local** (tài khoản AD đăng nhập trên web; gọi API bằng tài khoản AD nhận 403 `api_requires_local`, để mật khẩu Windows không nằm trong script). Tạo riêng cho script (Quản trị > Người dùng, cách đăng nhập "Nội bộ"), chỉ cấp vai trò và chi nhánh cần thiết (ví dụ `auditor` để đọc nhật ký / báo cáo). Tài khoản local mới tạo phải đổi mật khẩu trước (`mustChangePassword: true` → `POST /api/auth/change-password`). Không lưu mật khẩu trong script.
2. **Đăng nhập**: `POST /api/auth/login` `{ "username", "password" }` → cookie `blk.sid` và `csrfToken`. Có 2 bước thì thêm `POST /api/auth/2fa` (mục 6.14).
3. **Gọi API** kèm cookie; POST/PUT/DELETE thêm `X-CSRF-Token: <csrfToken>` và `Content-Type: application/json` (thiếu thì 403 `csrf_failed` / 415 `json_required`).
4. **Đăng xuất**: `POST /api/auth/logout`.

Phiên hết hạn theo Quản trị > Bảo mật (nhận 401 thì đăng nhập lại); cookie có cờ `Secure` nên phải gọi qua HTTPS; đăng nhập sai nhiều lần thì khóa như trên web. Mọi thao tác (hiện key, xuất CSV / Excel, thay đổi quản trị) đều ghi nhật ký; hiện key vẫn bắt chọn lý do.

```bash
BASE=https://blk.corp.local
# Đăng nhập (mật khẩu lấy từ biến môi trường), giữ cookie trong cookies.txt
CSRF=$(curl -s -c cookies.txt -H 'Content-Type: application/json' \
  -d "{\"username\":\"svc-report\",\"password\":\"$BLK_PASSWORD\"}" "$BASE/api/auth/login" | jq -r .csrfToken)

# Đọc (GET không cần CSRF)
curl -s -b cookies.txt "$BASE/api/computers?q=HN-LT" | jq '.rows[] | {name, branch_code}'
curl -s -b cookies.txt -o bao-cao.xlsx "$BASE/api/reports/summary?from=2026-10-01&to=2026-10-31&format=xlsx"

# Ghi (cần X-CSRF-Token): cập nhật serial / email của máy 42
curl -s -b cookies.txt -X PUT -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
  -d '{"deviceSerial":"5CG1234XYZ","ownerEmail":"nguyenvana@corp.local"}' "$BASE/api/computers/42/info"

curl -s -b cookies.txt -X POST -H "X-CSRF-Token: $CSRF" "$BASE/api/auth/logout"
```

PowerShell (`WebSession` tự giữ cookie):

```powershell
$base = 'https://blk.corp.local'
$cred = Get-Credential
$body = @{ username = $cred.UserName; password = $cred.GetNetworkCredential().Password } | ConvertTo-Json
$login = Invoke-RestMethod "$base/api/auth/login" -Method Post -Body $body -ContentType 'application/json' -SessionVariable s
$h = @{ 'X-CSRF-Token' = $login.csrfToken }

(Invoke-RestMethod "$base/api/dashboard" -WebSession $s).totals                                   # đọc
$info = @{ deviceSerial = '5CG1234XYZ'; ownerEmail = 'nguyenvana@corp.local' } | ConvertTo-Json
Invoke-RestMethod "$base/api/computers/42/info" -Method Put -WebSession $s -Headers $h -ContentType 'application/json' -Body $info   # ghi
Invoke-RestMethod "$base/api/auth/logout" -Method Post -WebSession $s -Headers $h
```

Dev: `BASE=https://localhost`; chứng chỉ tự ký thì curl thêm `--cacert cert/ca.crt` (hoặc `-k`), PowerShell 7 thêm `-SkipCertificateCheck`.

### 8.3. Ingest API (cho worker)

API **riêng cho sync worker**, cổng riêng (`INGEST_PORT`, mặc định 8443), không có phiên đăng nhập và không endpoint nào trả key ra. Đặc tả: `server/openapi/ingest.openapi.yaml`, Swagger UI `https://<server>:8443/docs`. Bình thường worker tự gọi; chỉ gọi tay để kiểm tra kết nối hoặc khi viết nguồn dữ liệu khác thay worker.

Endpoint (chi tiết trong đặc tả): `GET /sync-runs/last`, `POST /sync-runs`, `POST /computers`, `POST /keys`, `POST /sync-runs/:id/complete`, `POST /heartbeat`, đều dưới `/api/ingest`. Body JSON tối đa 2 MB, mỗi lô tối đa 500 máy hoặc 500 key.

**Xác thực: ba lớp, đều bắt buộc trên production**

| Lớp | Cấu hình | Lỗi khi sai |
| --- | --- | --- |
| HTTPS | nginx cổng 8443 (mục 3.5) | Lỗi TLS; `http://` vào 8443 nhận 400 |
| IP được phép | `INGEST_ALLOWED_IPS` (IP nginx ghi vào `X-Forwarded-For`, client không giả được) | 403 `forbidden` |
| API key | `INGEST_API_KEY`, header `Authorization: Bearer <key>` | 401 `bad_api_key` |

**Gọi thử** (chỉ đọc hoặc vô hại), chạy trên máy worker (đúng IP được phép):

```bash
INGEST=https://blk.corp.local:8443/api/ingest
curl -s -H "Authorization: Bearer $INGEST_API_KEY" "$INGEST/sync-runs/last"      # thêm --cacert nếu máy chưa tin CA
# Heartbeat: worker hiện ở Quản trị > Đồng bộ AD; trả về syncRequested (delta | full | null)
curl -s -H "Authorization: Bearer $INGEST_API_KEY" -H 'Content-Type: application/json' \
  -d '{"workerId":"TEST-CURL","version":"manual","ldapOk":true}' "$INGEST/heartbeat"
```

```powershell
Invoke-RestMethod 'https://blk.corp.local:8443/api/ingest/sync-runs/last' -Headers @{ Authorization = "Bearer $env:INGEST_API_KEY" }
```

**Gửi dữ liệu thật** (nguồn thay worker), theo trình tự: (1) `POST /sync-runs` `{ "mode": "delta"|"full", "dcName" }`, dùng `runId`, `mode`, `sinceUsn` server trả về (server có thể đổi delta thành full); (2) `POST /computers` từng lô, **máy trước**; (3) `POST /keys` từng lô (key trong `orphans` thì gửi máy cha rồi gửi lại); (4) `POST /sync-runs/{runId}/complete` với số đếm và `highestUsn` (lỗi thì `status: failed` + `errorCode`).

Cẩn thận:

- Lượt **full** coi mọi máy không được gửi là "Không còn trong phạm vi giám sát": đừng chạy full thử với dữ liệu thiếu trên hệ thống thật (lượt bất thường bị giữ lại chờ duyệt, mục 6.1).
- Chỉ một lượt mở tại một thời điểm (409 `run_in_progress`; lượt im lặng quá 30 phút được giải phóng): dừng worker thật trước khi gọi tay.
- Mỗi lô gửi lại được (idempotent): 5xx / lỗi mạng thì thử lại với backoff, 4xx thì sửa dữ liệu. Không ghi log hay lưu recovery password ở phía gọi.
- Dev: `https://localhost:8443/api/ingest` (CA `cert/ca.crt`), API key trong `server/.env`.

### 8.4. Cấu trúc code (`server/src`)

```
app.js                  app cho người dùng: file tĩnh, /healthz, /api, trang web
services.js             tạo mọi service một lần; web, API, ingest, job và CLI dùng chung
api/index.js            router /api: phiên đăng nhập, chỉ nhận JSON, CSRF header, lỗi dạng JSON
web/                    router trang web, biến dùng chung cho template, flash, dịch lỗi sang tiếng Việt (messages.js)
ingest/ingest.app.js    API cho worker trên cổng riêng (API key + lọc IP; HTTPS ở nginx)
jobs/                   lịch chạy job (mỗi job một instance nhờ advisory lock), watchdog sync
http/                   AppError, kiểm tra dữ liệu (zod), CSRF, header bảo mật
db/                     pool, chạy migration, withScope (phạm vi RLS theo transaction), dữ liệu mẫu
domain/                 vai trò -> quyền -> tập chi nhánh; giờ làm việc
modules/<tính năng>/
  *.repo.js             chỉ SQL
  *.service.js          nghiệp vụ (phân quyền, ghi nhật ký); không biết HTTP
  *.api.js              route JSON -> service
  *.web.js              route HTML -> cùng service -> view EJS
views/                  template EJS
```

Ngoài `src/`: `db/migrations/` (SQL, chạy theo thứ tự), `openapi/` (spec Swagger của API người dùng và
ingest), `templates/mail-templates.yaml` (mẫu email), `public/` (CSS, JS), `test/` (vitest).

Quy tắc:

- Route chỉ mỏng. Mọi kiểm tra quyền và ghi nhật ký nằm trong service, nên trang web và API không
  bao giờ lệch nhau.
- Giá trị key chỉ được đọc trong `keys.repo.js`: `readRecoveryPassword` (hiện một key) và
  `keysForExport` (xuất kèm key), đều bên trong transaction có ghi nhật ký.
- Không log body request/response. Logger tự che mọi chuỗi có dạng recovery key.

Hướng dẫn chi tiết về worker (cấu trúc code, phát triển với AD giả): xem `worker/README.md`.
