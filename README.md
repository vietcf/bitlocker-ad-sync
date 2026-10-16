# Hệ thống quản lý BitLocker Recovery Key

Hệ thống đồng bộ BitLocker recovery key từ Active Directory (AD) về một database riêng. IT chi nhánh
chỉ thấy key của máy thuộc chi nhánh mình. Mỗi lần hiện key phải chọn lý do và được ghi vào nhật ký
có chuỗi hash, không sửa hay xóa được.

| Thư mục | Nội dung |
| --- | --- |
| `server/` | Ứng dụng Node.js (Express, JavaScript thuần): trang web (EJS), JSON API, ingest API cho worker, job nền |
| `worker/` | Sync worker .NET (Windows Service): đọc AD qua LDAP(S) rồi đẩy dữ liệu lên ingest API |
| `worker-go/` | Sync worker Go (Linux, systemd): cùng chức năng và giao thức với bản .NET. Chọn **một** trong hai |

Mục lục:

1. [Kiến trúc tóm tắt](#1-kiến-trúc-tóm-tắt)
2. [Chạy thử trên máy dev (Docker)](#2-chạy-thử-trên-máy-dev-docker)
3. [Cài đặt production](#3-cài-đặt-production)
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
  key nào còn hiệu lực, máy nào không còn trong AD, lượt sync nào bất thường.
- **Máy** được nhận diện bằng `objectGUID` của AD, nên đổi tên hay chuyển OU vẫn là cùng một máy.
  **Key** được nhận diện bằng Key ID (`msFVE-RecoveryGuid`). Một máy có thể có nhiều ổ được mã hóa,
  mỗi ổ một hoặc nhiều key (`msFVE-VolumeGuid` cho biết key thuộc ổ nào).
- **Không có gì bị xóa.** Máy không còn trong AD chỉ được gắn nhãn "Không còn trong AD" và key vẫn
  được giữ để mở ổ cứng cũ.
- **Phân quyền** nằm trong app, không lấy từ group AD. Người dùng đăng nhập bằng tài khoản AD (kiểm
  tra mật khẩu qua LDAPS) hoặc tài khoản local.
- **Ngôn ngữ:** giao diện web bằng tiếng Việt. Thông báo trong API và log bằng tiếng Anh; client dựa
  vào mã lỗi `error`, không dựa vào câu chữ. Nội dung email và cảnh báo lấy từ file mẫu email (mục
  6.6), hiện viết bằng tiếng Việt.

---

## 2. Chạy thử trên máy dev (Docker)

### 2.1. Yêu cầu

- Docker Desktop (Windows/macOS) hoặc Docker Engine + Compose v2.24 trở lên (Linux).
- Node.js 24, chỉ khi muốn chạy test ngoài Docker.
- .NET SDK 10, chỉ khi muốn chạy worker.

### 2.2. Khởi động

```bash
cd bitlocker-management
bash cert/generate-self-signed.sh      # lần đầu: chứng chỉ tự ký cho HTTPS (mục 3.6)
docker compose up --build --watch
```

Compose dựng bốn service:

| Service | Việc |
| --- | --- |
| `db` | PostgreSQL 17, có database `blk` (dev) và `blk_test` (test). Lần đầu tạo volume, script `server/db/init/01-roles.sh` tạo hai tài khoản DB: `blk_owner` sở hữu schema, `app_node` dùng khi chạy app |
| `migrate` | Chạy các file trong `server/db/migrations` theo thứ tự rồi thoát |
| `nginx` | Reverse proxy HTTPS, một chứng chỉ (`cert/server.crt`) cho cả web (443) và ingest API (8443); cổng 80 chuyển sang HTTPS |
| `server` | App Node.js, chỉ nhận kết nối từ nginx (không mở cổng ra ngoài). Với `--watch`, mỗi khi sửa `server/src`, `server/public` hoặc `server/openapi`, container tự cập nhật và khởi động lại; sửa `server/templates` (mẫu email) thì chỉ chép vào, không cần khởi động lại |

Địa chỉ:

- https://localhost: giao diện web và `/api` (http://localhost tự chuyển sang HTTPS).
- https://localhost:8443/api/ingest: ingest API cho worker (HTTPS + API key).
- https://localhost/api/docs: Swagger của toàn bộ API người dùng (phải đăng nhập web trước).
- https://localhost:8443/docs: Swagger của ingest API (cần API key).

Chứng chỉ dev là tự ký, nên trình duyệt báo "không an toàn" cho tới khi bạn tin CA dev
(`cert/ca.crt`, mục 3.6). Cổng 443/80 đã bị chương trình khác dùng thì đổi: `HTTPS_PORT=8444 HTTP_PORT=8080
docker compose up -d`. Mặc định chỉ máy này truy cập được; cho máy khác vào: `BIND_ADDR=0.0.0.0`.
- `localhost:5432`: PostgreSQL. Tài khoản dev: `postgres` / `dev_postgres_pw`.

### 2.3. Đăng nhập lần đầu

Lần đầu chạy, khi DB chưa có user nào, app tạo tài khoản local **`admin` / `admin`** có quyền Admin
HQ. App bắt đổi mật khẩu ngay lần đăng nhập đầu tiên (mặc định tối thiểu 12 ký tự; đổi được ở Quản trị > Bảo mật).

Quên mật khẩu admin thì đặt lại:

```bash
docker compose exec server node src/cli/users.js reset-password admin
```

### 2.4. Cấu hình cho dev (tùy chọn)

Các thiết lập như LDAP, API key của worker hay cảnh báo nằm trong `server/.env`:

```bash
cp server/.env.example server/.env
```

Các biến về DB, cổng, `SESSION_SECRET` và `LOG_HMAC_KEY` đã có sẵn giá trị dev trong
`docker-compose.yml`, không cần sửa. Sau khi sửa `server/.env`, tạo lại container (watch không
theo dõi file `.env`):

```bash
docker compose up -d --force-recreate server
```

### 2.5. Dữ liệu mẫu và các lệnh hay dùng

```bash
# Dữ liệu giả: 3 chi nhánh, khoảng 20 máy, key giả
docker compose exec server node src/db/seed-dev.js

# Áp dụng migration mới
docker compose run --rm migrate

# Xem log của server
docker compose logs -f server

# Xóa sạch, kể cả database
docker compose down -v
```

### 2.6. Chạy test

```bash
docker compose up -d db
cd server
npm install
npm test            # toàn bộ test
npm run test:unit   # không cần DB
npm run test:int    # dùng database blk_test
```

Worker:

```bash
cd worker
dotnet test
```

---

## 3. Cài đặt production

### 3.1. Chuẩn bị

| Thành phần | Yêu cầu |
| --- | --- |
| Máy chủ app | Linux có Docker (hoặc Node.js 24), mở cổng 443 cho người dùng và 8443 cho worker |
| PostgreSQL | Bản 17, nên đặt trên máy riêng, bật TLS, sao lưu hằng ngày |
| Reverse proxy | Container nginx đi kèm (`nginx/nginx.conf`), giữ chứng chỉ HTTPS cho cả web (443) và ingest (8443) |
| Chứng chỉ | Một chứng chỉ server có tên máy chủ app trong SAN, dùng chung cho hai cổng (mục 3.6) |
| AD | Ít nhất một DC có LDAPS (cổng 636) với chứng chỉ hợp lệ. Một gMSA cho worker |
| Máy chủ worker | Windows Server, member server trong domain, có .NET 10 runtime (hoặc dùng bản publish self-contained) |
| SMTP / Teams | Không bắt buộc. Mail server cấu hình trong app (Quản trị > Mail server); Teams qua webhook trong `.env` |

### 3.2. Tạo database

Đăng nhập PostgreSQL bằng tài khoản superuser rồi chạy (thay hai mật khẩu):

```sql
CREATE ROLE blk_owner LOGIN NOSUPERUSER NOCREATEROLE NOBYPASSRLS PASSWORD '<mật-khẩu-owner>';
CREATE ROLE app_node  LOGIN NOSUPERUSER NOCREATEROLE NOBYPASSRLS PASSWORD '<mật-khẩu-app>';
CREATE DATABASE blk OWNER blk_owner;
\c blk
ALTER SCHEMA public OWNER TO blk_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO app_node;
```

- `blk_owner` sở hữu bảng và chỉ dùng khi chạy migration.
- `app_node` là tài khoản duy nhất app dùng khi chạy. Tài khoản này không sở hữu bảng nên luôn bị
  Row-Level Security giới hạn theo chi nhánh. **Không** cấp SUPERUSER hay BYPASSRLS cho tài khoản nào.

### 3.3. Tạo secret

Chạy trên máy có Node.js:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Chạy ba lần để có:

- `SESSION_SECRET`: ký cookie phiên đăng nhập.
- `LOG_HMAC_KEY`: khóa HMAC cho chuỗi hash của nhật ký (đúng 64 ký tự hex). **Phải sao lưu
  khóa này an toàn.** Mất khóa thì không kiểm chứng được nhật ký cũ. Không lưu khóa trong DB.
- `INGEST_API_KEY`: API key của worker, cách xác thực duy nhất của worker.

### 3.4. File cấu hình `server/.env` cho production

```ini
NODE_ENV=production
LOG_LEVEL=info

# Cả hai cổng là HTTP nội bộ; container nginx đứng trước lo HTTPS (mục 3.5, 3.6)
USER_HOST=0.0.0.0
USER_PORT=3000
INGEST_HOST=0.0.0.0
INGEST_PORT=8443
# Tin đúng 1 lớp proxy (nginx): IP người dùng / worker lấy từ X-Forwarded-For do nginx ghi đè
TRUST_PROXY=1
INGEST_TRUST_PROXY=1
COOKIE_SECURE=true

# Xác thực worker: HTTPS + API key (cùng giá trị đặt trong cấu hình worker) + IP được phép
INGEST_API_KEY=<chuỗi hex 64 ký tự>
INGEST_ALLOWED_IPS=10.0.5.21

# Database
DATABASE_URL=postgres://app_node:<mật-khẩu-app>@db.corp.local:5432/blk
MIGRATION_DATABASE_URL=postgres://blk_owner:<mật-khẩu-owner>@db.corp.local:5432/blk
DB_SSL=true

# Đăng nhập bằng AD (production chỉ cho phép ldaps://)
LDAP_URL=ldaps://dc01.corp.local:636,ldaps://dc02.corp.local:636
LDAP_DOMAIN=corp.local
LDAP_BASE_DN=DC=corp,DC=local
# Chỉ cần nếu máy chủ app chưa tin CA đã cấp chứng chỉ LDAPS của DC
LDAP_CA_FILE=/app/certs/corp-root-ca.pem
# Giữ bật để còn tài khoản admin local khi AD gặp sự cố
LOCAL_LOGIN_ENABLED=true

SESSION_SECRET=<chuỗi hex 64 ký tự>
SESSION_IDLE_MINUTES=15
SESSION_MAX_HOURS=8
LOG_HMAC_KEY=<chuỗi hex 64 ký tự>

# Cảnh báo. Mail server thường cấu hình trong app (Quản trị > Mail server); SMTP_URL chỉ dùng
# khi ở đó đang tắt. NOTIFY_TO luôn nhận email cảnh báo. Không cấu hình gì thì cảnh báo chỉ vào log.
# SMTP_URL=smtp://relay.corp.local:25
NOTIFY_FROM=bitlocker-keys@corp.local
NOTIFY_TO=it-hq@corp.local,security@corp.local
# TEAMS_WEBHOOK_URL=https://...
# File mẫu email đặt ngoài image (mục 6.6), ví dụ khi mount từ /etc/blk:
# MAIL_TEMPLATES_FILE=/app/config/mail-templates.yaml

JOBS_ENABLED=true
APP_TZ=Asia/Ho_Chi_Minh
```

Khi `NODE_ENV=production`, app **từ chối khởi động** và in tên biến bị lỗi (không in giá trị) nếu:

- không có HTTPS cho ingest API: thiếu `INGEST_TRUST_PROXY` (HTTPS ở nginx) mà cũng không có `INGEST_TLS_CERT` / `INGEST_TLS_KEY` (HTTPS ngay tại app);
- thiếu `INGEST_API_KEY`;
- `INGEST_ALLOWED_IPS` để trống;
- `LDAP_URL` có địa chỉ không phải `ldaps://`;
- `SESSION_SECRET` còn giá trị dev.

Phân quyền file: `chmod 600 server/.env`, chỉ tài khoản chạy app được đọc.

### 3.5. Build và chạy server bằng Docker

```bash
cd bitlocker-management/server
docker build -t blk-server:1.0 .

# Chạy migration (dùng MIGRATION_DATABASE_URL)
docker run --rm --env-file .env blk-server:1.0 node src/db/migrate.js

# Mạng riêng cho app và nginx
docker network create blk

# Chạy app: không mở cổng ra ngoài, chỉ nginx gọi tới (tên "server" trong mạng blk)
docker run -d --name blk-server --network blk --network-alias server --restart unless-stopped \
  --log-driver local --log-opt max-size=50m --log-opt max-file=20 \
  --env-file .env \
  blk-server:1.0

# Chạy nginx: HTTPS 443 (web) và 8443 (ingest), cùng một chứng chỉ trong /opt/blk/cert
docker run -d --name blk-nginx --network blk --restart unless-stopped \
  --log-driver local --log-opt max-size=50m --log-opt max-file=20 \
  -p 443:443 -p 8443:8443 -p 80:80 \
  -v /opt/blk/nginx/nginx.conf:/etc/nginx/nginx.conf:ro \
  -v /opt/blk/cert:/etc/nginx/cert:ro \
  nginx:1.28.0-alpine
```

- `/opt/blk/nginx/nginx.conf`: chép từ `nginx/nginx.conf` của repo. `/opt/blk/cert`: `server.crt` và `server.key` (mục 3.6).
- Tường lửa: cổng 443 cho người dùng; cổng 8443 chỉ cho IP của máy worker (thêm một lớp ngoài `INGEST_ALLOWED_IPS`).
- Trên máy chủ Linux, Docker giữ nguyên IP thật của client nên whitelist IP worker hoạt động đúng. (Docker Desktop
  trên Windows / macOS thấy mọi client là IP gateway, ví dụ `172.18.0.1`, chỉ dùng cho dev.)
- Kiểm tra: `curl -k https://localhost/healthz` trả về HTTP 200 với `"dbOk": true` khi app kết nối được DB. `degraded: true` nghĩa là chưa có lượt sync thành công trong 60 phút qua.

Không dùng Docker thì cài Node.js 24 rồi chạy:

```bash
cd server
npm ci --omit=dev
npm run migrate
npm start            # nên chạy bằng systemd hoặc pm2 để tự khởi động lại
```

### 3.6. HTTPS và chứng chỉ

Container nginx giữ **một chứng chỉ** cho cả hai cổng: web (443) và ingest API (8443). Chứng chỉ nằm trong
thư mục `cert/` (dev) hoặc `/opt/blk/cert` (production), mount vào nginx ở `/etc/nginx/cert`:

| File | Nội dung |
| --- | --- |
| `server.crt` | Chứng chỉ server dạng PEM, **kèm chuỗi CA trung gian** nếu có (fullchain) |
| `server.key` | Khóa riêng dạng PEM, không có mật khẩu, chỉ root đọc được |
| `ca.crt`, `ca.key` | Chỉ ở dev: CA tự ký do script tạo ra |

**Dev: chứng chỉ tự ký**

```bash
bash cert/generate-self-signed.sh                          # localhost, 127.0.0.1, blk.local, tên máy
bash cert/generate-self-signed.sh blk.example.local 10.0.5.10   # thêm tên / IP khác
docker compose restart nginx
```

Script tạo một CA dev (`ca.crt`) rồi dùng nó ký `server.crt` (hạn 825 ngày). Chạy lại thì giữ CA cũ, chỉ
tạo chứng chỉ server mới. Trình duyệt sẽ cảnh báo cho tới khi bạn tin CA dev:
- Windows: mở `cert/ca.crt` > Install Certificate > Current User > Trusted Root Certification Authorities.
- Hoặc chấp nhận cảnh báo một lần trong trình duyệt.

Worker tin CA dev qua cấu hình, không cần cài vào máy: worker Go `"CaFile": "../cert/ca.crt"` (đã đặt trong
`worker-go/config.json`), worker .NET `"CaFile"` trong `appsettings.Development.json`.

Hoặc **tắt kiểm tra chứng chỉ** ở worker (cả .NET và Go): `"Ingest": { "SkipCertificateValidation": true }`.
Kết nối vẫn mã hóa nhưng worker chấp nhận mọi chứng chỉ, kể cả của một server giả. Chỉ dùng cho lab hoặc khi
chưa có file CA; worker ghi cảnh báo vào log mỗi lần chạy. Production luôn để `false` và dùng `CaFile` nếu cần.

**Thay bằng chứng chỉ thật**

1. Chọn tên truy cập, ví dụ `blk.corp.local`, tạo bản ghi DNS trỏ về máy chủ app.
2. Tạo khóa và CSR trên máy chủ app (khóa không rời khỏi máy):

   ```bash
   openssl req -new -newkey rsa:3072 -nodes -keyout server.key -out server.csr \
     -subj "/CN=blk.corp.local" -addext "subjectAltName=DNS:blk.corp.local"
   ```

3. Gửi `server.csr` cho CA: CA nội bộ của công ty (AD CS, template *Web Server*) hoặc CA công cộng. Yêu cầu
   có **SAN** chứa đúng tên ở bước 1 và EKU *Server Authentication*.
4. Nhận về chứng chỉ (PEM). Nếu CA trả về chứng chỉ trung gian riêng, ghép thành fullchain:

   ```bash
   cat blk.corp.local.crt intermediate.crt > server.crt
   ```

   Có file `.pfx`: `openssl pkcs12 -in blk.pfx -nokeys -out server.crt` và `openssl pkcs12 -in blk.pfx -nocerts -nodes -out server.key`.
5. Chép `server.crt` và `server.key` vào thư mục cert (dev: `cert/`; production: `/opt/blk/cert/`), đặt quyền:

   ```bash
   chmod 644 /opt/blk/cert/server.crt && chmod 600 /opt/blk/cert/server.key
   ```

6. Kiểm tra cấu hình rồi nạp lại nginx (không làm gián đoạn kết nối):

   ```bash
   docker exec blk-nginx nginx -t && docker exec blk-nginx nginx -s reload
   ```

   Dev: `docker compose exec nginx nginx -t` rồi `docker compose exec nginx nginx -s reload`.
7. Kiểm tra từ máy khác (phải in `Verify return code: 0 (ok)` cho cả hai cổng):

   ```bash
   openssl s_client -connect blk.corp.local:443 -servername blk.corp.local </dev/null | grep -E "subject=|Verify return"
   openssl s_client -connect blk.corp.local:8443 -servername blk.corp.local </dev/null | grep "Verify return"
   ```

8. Cập nhật worker:
   - `Ingest.BaseUrl` = `https://blk.corp.local:8443/api/ingest` (đúng tên trong chứng chỉ, không dùng IP).
   - CA nội bộ mà máy worker đã tin (máy Windows trong domain thường tin CA của AD CS): để trống `CaFile`.
     Chưa tin: đặt `CaFile` là file PEM của CA gốc (worker .NET và Go đều hỗ trợ).
   - Bỏ `CaFile` trỏ tới CA dev nếu còn.
9. Gia hạn: lặp lại từ bước 2 trước ngày hết hạn (`openssl x509 -in server.crt -noout -enddate`). Không cần
   khởi động lại app hay worker, chỉ reload nginx.

Lỗi thường gặp:

| Hiện tượng | Nguyên nhân | Cách xử lý |
| --- | --- | --- |
| `nginx -t` báo `key values mismatch` | `server.key` không khớp chứng chỉ | Dùng đúng khóa đã tạo CSR |
| Trình duyệt báo sai tên | Tên truy cập không có trong SAN | Cấp lại chứng chỉ với SAN đúng tên |
| Worker `x509: certificate signed by unknown authority` / .NET `RemoteCertificateChainErrors` | Máy worker không tin CA | Đặt `Ingest.CaFile` là CA gốc, hoặc cài CA vào máy |
| `openssl s_client` báo `unable to get local issuer certificate` | Thiếu chứng chỉ trung gian trong `server.crt` | Ghép fullchain (bước 4) |

### 3.7. Cập nhật phiên bản

```bash
docker build -t blk-server:1.1 .
docker run --rm --env-file .env blk-server:1.1 node src/db/migrate.js
docker rm -f blk-server
docker run -d --name blk-server ... blk-server:1.1     # cùng tham số như mục 3.5
```

Migration chỉ thêm, không sửa file cũ. Nên sao lưu DB trước khi cập nhật.

---

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

**Đọc nhiều OU (`SearchBases`).** Khi tài khoản worker chỉ được cấp quyền đọc một vài OU, liệt kê
các OU đó, ví dụ:

```jsonc
"SearchBases": [
  "OU=Computers,OU=HN,DC=corp,DC=local",
  "OU=Computers,OU=HCM,DC=corp,DC=local"
]
```

- Mỗi lượt sync đọc **lần lượt** từng OU (máy rồi key), gộp lại và gửi server như một lượt duy nhất.
- OU phải nằm trong `BaseDn`, nếu không worker từ chối khởi động. OU trùng nhau hoặc OU con của một
  OU đã có trong danh sách được bỏ qua (không đọc hai lần).
- Nếu một OU không đọc được (không tồn tại, thiếu quyền, referral), **cả lượt dừng lại** với mã lỗi
  `ldap_search_base_failed` và tên OU trong log. Worker không bỏ qua OU đó, vì nếu bỏ qua thì lượt full
  sẽ coi mọi máy trong OU là "Không còn trong AD".
- Máy nằm ngoài mọi OU trong danh sách thì worker không thấy; sau lượt full chúng bị gắn nhãn "Không
  còn trong AD". Thêm OU mới vào `SearchBases` thì các máy đó tự trở lại.

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

Lệnh này kết nối DC, đọc RootDSE, rồi với **từng OU** trong `SearchBases` đọc thử vài máy và vài key
và in `OK` hoặc `FAIL` kèm lý do (OU không tồn tại, thiếu quyền...). Lệnh cũng báo hạn chứng chỉ LDAPS
và cảnh báo khi có key không đọc được mật khẩu (thiếu quyền ở bước 4.1). Có OU `FAIL` thì lệnh trả mã
thoát 4. Lệnh không gọi server; kết nối tới server
được kiểm tra bằng `run-once` bên dưới. Lệnh `check` chạy bằng tài khoản đang
đăng nhập; service chạy bằng gMSA, nên quyền có thể khác nhau.

Chạy thử một lượt full (không cần cài service):

```powershell
.\BitlockerSync.Worker.exe run-once full
```

### 4.6. Cài Windows Service

Worker đọc AD bằng một trong ba cách. Chọn một cách, sửa `appsettings.json` cho khớp, rồi chạy
script cài đặt trong PowerShell với quyền Administrator.

| Cách | Service chạy bằng | `Ldap:Auth` | `Ldap:Username` / `Ldap:Password` | Mật khẩu nằm ở đâu |
| --- | --- | --- | --- | --- |
| **A. gMSA** (khuyến nghị) | `CORP\gmsa-blk$` | `Negotiate` | để trống | AD tự quản lý và tự đổi, không ai biết |
| **B. Tài khoản domain chạy service** | `CORP\svc-blk` | `Negotiate` | để trống | Windows lưu khi cài service |
| **C. User + mật khẩu trong file cấu hình** | `NT SERVICE\BitlockerSync` (tài khoản ảo) | `Negotiate` hoặc `Basic` | `CORP\svc-blk` / `dpapi:...` | `appsettings.json`, đã mã hóa DPAPI |

**Cách A: gMSA**

```powershell
C:\BitlockerSync\scripts\install-service.ps1 -Account 'CORP\gmsa-blk$' -InstallDir C:\BitlockerSync
Start-Service BitlockerSync
```

**Cách B: service chạy bằng tài khoản domain thường**

Service đăng nhập Windows bằng chính tài khoản `svc-blk`, và worker dùng tài khoản đó để đọc AD.

```powershell
C:\BitlockerSync\scripts\install-service.ps1 -Account 'CORP\svc-blk' -InstallDir C:\BitlockerSync
# Script hỏi mật khẩu của CORP\svc-blk (cửa sổ nhập mật khẩu của Windows)
Start-Service BitlockerSync
```

Lưu ý:

- Tài khoản cần quyền **Log on as a service** trên máy worker. Nếu `Start-Service` báo lỗi 1069
  ("logon failure"), cấp quyền này tại `secpol.msc` > Local Policies > User Rights Assignment >
  Log on as a service. Nếu GPO của domain quản lý quyền này, phải thêm tài khoản vào GPO, vì thêm ở
  máy sẽ bị GPO ghi đè.
- Khi đổi mật khẩu `svc-blk` trên AD, phải chạy lại script (hoặc vào `services.msc` > BitlockerSync >
  Log On) để cập nhật mật khẩu, rồi khởi động lại service. Nếu quên, service không chạy được và
  watchdog sẽ cảnh báo "Sync worker không gửi heartbeat".
- Nên đặt cho `svc-blk` một mật khẩu dài, ngẫu nhiên. Có thể bật "Password never expires" nếu chính
  sách cho phép; nếu không, ghi lịch đổi mật khẩu cùng với bước cập nhật service.
- Bỏ quyền đăng nhập tương tác của `svc-blk` (Deny log on locally / through Remote Desktop).

**Cách C: user + mật khẩu ghi trong `appsettings.json`**

Service chạy bằng tài khoản ảo của chính nó, không cần mật khẩu. Worker bind LDAP bằng user và mật
khẩu trong file cấu hình. Đây cũng là cách duy nhất khi máy worker **không join domain**.

1. Mã hóa mật khẩu của `svc-blk` trên chính máy worker:

   ```powershell
   cd C:\BitlockerSync
   .\BitlockerSync.Worker.exe protect
   # nhập mật khẩu -> nhận chuỗi dpapi:...
   ```

2. Sửa `appsettings.json`:

   ```jsonc
   "Ldap": {
     "Protocol": "Ldaps",
     "Auth": "Negotiate",            // hoặc "Basic" (simple bind); Basic bắt buộc dùng Ldaps hoặc StartTls
     "Username": "CORP\\svc-blk",    // hoặc "svc-blk@corp.local"; trong JSON phải viết \\
     "Password": "dpapi:AQAAANCMnd8B...",
     ...
   }
   ```

3. Cài service:

   ```powershell
   C:\BitlockerSync\scripts\install-service.ps1 -Account 'NT SERVICE\BitlockerSync' -InstallDir C:\BitlockerSync
   Start-Service BitlockerSync
   ```

Lưu ý:

- Chuỗi `dpapi:` chỉ giải mã được trên đúng máy đã mã hóa, nhưng mọi tiến trình trên máy đó đều giải
  mã được. Vì vậy script khóa quyền `appsettings.json`: chỉ Administrators, SYSTEM và tài khoản
  service được đọc. Chép file cấu hình sang máy khác thì phải chạy lại `protect` trên máy mới.
- Khi đổi mật khẩu `svc-blk` trên AD: chạy lại `protect`, dán chuỗi mới vào `Ldap:Password`, rồi
  `Restart-Service BitlockerSync`.
- Nếu máy worker không join domain: dùng `Ldaps` và đặt `Ldap:Servers` là tên DC mà máy phân giải
  được. Máy worker phải tin CA đã cấp chứng chỉ LDAPS của DC (import vào
  `LocalMachine\Trusted Root Certification Authorities`).

**Sau khi cài (cả ba cách)**

- Script cấp quyền ghi thư mục trạng thái `C:\ProgramData\BitlockerSync` cho tài khoản service, rồi
  chạy `check` **bằng tài khoản Administrator đang dùng**. Với cách A và B, quyền đọc AD của service
  có thể khác kết quả `check`. Hãy xem log sau lượt full đầu tiên: nếu có key không đọc được mật
  khẩu, kiểm tra lại quyền ở mục 4.1.
- Muốn đổi cách chạy (ví dụ từ B sang A), chạy lại script với `-Account` mới; script cập nhật service
  đang có.
- Log ghi vào Event Viewer > Windows Logs > Application, source `BitlockerSync`. Log không bao giờ
  chứa key.
- Lịch chạy: heartbeat mỗi 5 phút, delta mỗi 15 phút, full lúc 01:00 và ngay lần đầu khởi động.
  Admin HQ cũng có thể bấm yêu cầu sync ở Quản trị > Sync AD; worker chạy ở lần heartbeat kế tiếp.

### 4.7. Cập nhật worker lên phiên bản mới

**Thứ tự:** cập nhật **server trước, worker sau**. Server mới luôn nhận được dữ liệu từ worker cũ
(trường mới là tùy chọn). Ngược lại, worker mới có thể gửi trường mà server cũ chưa hiểu.

**Bước 1: build bản mới** trên máy có .NET SDK 10, rồi chép thư mục `publish-1.1` lên máy worker,
ví dụ vào `D:\drop\BitlockerSync-1.1`:

```powershell
cd worker
dotnet publish src/BitlockerSync.Worker -c Release -o .\publish-1.1
Copy-Item .\scripts .\publish-1.1\scripts -Recurse
```

**Bước 2: chạy script cập nhật** trên máy worker, bằng PowerShell quyền Administrator. Nên dùng
script của bản mới:

```powershell
D:\drop\BitlockerSync-1.1\scripts\update-worker.ps1 -Source D:\drop\BitlockerSync-1.1 -InstallDir C:\BitlockerSync
```

Script làm lần lượt:

1. Sao lưu toàn bộ `C:\BitlockerSync` sang `C:\BitlockerSync.bak-<ngày-giờ>`.
2. Dừng service. Nếu đang có lượt sync dở, worker báo server đóng lượt đó với mã `cancelled`. Lượt
   này không gây cảnh báo và không làm USN tiến lên, nên lượt sau đọc lại phần còn thiếu.
3. Chép file của bản mới đè lên, **trừ `appsettings.json`**. File này chứa cấu hình và secret
   `dpapi:` của máy, nên được giữ nguyên, kể cả phân quyền đã khóa. `appsettings.json` mẫu của bản
   mới được lưu thành `appsettings.new.json`.
4. Chạy `check` bằng bản mới. Nếu lỗi, service **được để ở trạng thái dừng** để bạn sửa hoặc quay
   lại bản cũ.
5. Khởi động lại service.

Trạng thái sync (`C:\ProgramData\BitlockerSync\state.json`) không bị đụng tới, nên worker tiếp tục
delta từ mốc cũ. Không cần chạy lại `install-service.ps1` hay `protect`, vì tài khoản service và
máy không đổi.

**Bước 3: kiểm tra**

- So `appsettings.new.json` với `appsettings.json` (ví dụ
  `Compare-Object (Get-Content appsettings.json) (Get-Content appsettings.new.json)`). Nếu bản mới
  có thiết lập mới cần dùng, chép tay sang `appsettings.json` rồi `Restart-Service BitlockerSync`.
  Thiết lập nào không có trong file sẽ dùng giá trị mặc định.
- Event Viewer > Application, source `BitlockerSync`: lượt sync kế tiếp (tối đa 15 phút) báo
  `success`.
- Trên web, Quản trị > Sync AD: heartbeat mới, lượt gần nhất thành công. Muốn kiểm tra
  ngay, bấm yêu cầu sync; worker chạy ở lần heartbeat kế tiếp (tối đa 5 phút).
- Nếu bản mới đọc thêm thuộc tính từ AD (ví dụ `msFVE-VolumeGuid`), dữ liệu cũ chỉ được bổ sung ở
  lượt **full** tới (01:00). Muốn có ngay thì bấm yêu cầu sync full trên web.

**Quay lại bản cũ** nếu bản mới có lỗi:

```powershell
Stop-Service BitlockerSync
Rename-Item C:\BitlockerSync C:\BitlockerSync.failed
Rename-Item C:\BitlockerSync.bak-20261013-0930 C:\BitlockerSync    # đúng tên thư mục backup
Start-Service BitlockerSync
```

Sau vài lần cập nhật ổn định, xóa bớt các thư mục `.bak-*` cũ. Các thư mục này cũng chứa
`appsettings.json` có secret.

---

## 4B. Cài sync worker trên Linux (bản Go)

Hướng dẫn này độc lập với mục 4 (worker .NET). Chi tiết thêm ở [worker-go/README.md](worker-go/README.md),
tham chiếu mọi khóa cấu hình ở [worker-go/docs/configuration.md](worker-go/docs/configuration.md).

### 4B.1. Yêu cầu

| Thành phần | Yêu cầu |
| --- | --- |
| Máy chủ worker | Linux 64-bit có systemd (Ubuntu 22.04+, Debian 12+, RHEL/Rocky 9+), amd64 hoặc arm64 |
| Mạng | Tới DC: 636 (LDAPS) hoặc 389 (StartTls / Ldap). Tới server: cổng ingest (mặc định 8443) |
| Máy build | Go 1.26+ (có thể build trên Windows hoặc máy khác rồi chép binary sang) |
| AD | Một tài khoản dịch vụ thường (bản Go không dùng được gMSA) |

### 4B.2. Chọn cách kết nối AD

| `Ldap.Protocol` | Cổng | Mã hóa | Điều kiện |
| --- | --- | --- | --- |
| `Ldap` (**mặc định**) | 389 | **Không**: mật khẩu tài khoản và mọi recovery key đi dạng rõ | Không cần gì trên AD. Chỉ dùng trên mạng tin cậy (xem dưới) |
| `Ldaps` | 636 | Có | DC có chứng chỉ TLS, máy Linux tin CA của chứng chỉ |
| `StartTls` | 389 | Có | Như trên |

Mặc định worker dùng LDAP thường, chạy được ngay mà không phải thay đổi gì trên AD, và ghi cảnh báo
"không mã hóa" vào log mỗi lần kết nối. Muốn mã hóa thì cấp chứng chỉ cho DC rồi đổi `Protocol` sang
`Ldaps`. Kiểm tra DC đã có chứng chỉ chưa, chạy từ máy worker:

```bash
openssl s_client -connect dc01.corp.local:636 </dev/null
```

In ra chứng chỉ là dùng được `Ldaps`. Bị ngắt ngay (`connection reset`) là DC chưa có chứng chỉ: cấp
chứng chỉ cho DC (AD CS template *Domain Controller Authentication*/*Kerberos Authentication*, hoặc CA nội
bộ khác; tên DC trong SAN), hoặc giữ `Ldap` (mặc định) trên mạng tin cậy. Với `Ldaps`/`StartTls` dùng
**tên** DC trong cấu hình, không dùng IP.

#### Dùng LDAP không mã hóa trên mạng tin cậy

Đây là cấu hình mặc định, dùng khi DC chưa có chứng chỉ TLS và không muốn thay đổi gì trên AD:

```jsonc
"Ldap": {
  "Servers": [ "dc01.corp.local", "dc02.corp.local" ],
  "Protocol": "Ldap",            // mặc định: cổng 389, không TLS
  "Username": "svc-blk@corp.local",
  "Password": "cred:ldap-password",
  "BaseDn": "DC=corp,DC=local"
}
```

Trên đường mạng giữa worker và DC, **mật khẩu tài khoản đọc AD và mọi recovery key đi dạng rõ**. Ai bắt được
gói tin trên đoạn mạng đó đều đọc được. Vì vậy cần đủ các điều kiện sau:

| Điều kiện | Cách làm |
| --- | --- |
| Đường mạng worker - DC ngắn và được kiểm soát | Worker đặt trong cùng VLAN/segment máy chủ với DC (hoặc VLAN quản trị), không đi qua mạng người dùng, Wi-Fi hay WAN |
| Chỉ worker được nói chuyện với DC cổng 389 từ phía đó | Firewall trên máy worker và giữa các VLAN chỉ mở 389 tới các DC trong `Ldap.Servers` |
| Không có thiết bị trung gian ghi gói tin | Không bật port mirroring/SPAN hay IDS lưu payload trên đoạn này; nếu có, coi chúng là hệ thống chứa key |
| Tài khoản đọc AD quyền tối thiểu | Chỉ quyền đọc key trên các OU máy tính; không đăng nhập tương tác được; đổi mật khẩu định kỳ |
| Theo dõi | Cảnh báo khi tài khoản này đăng nhập từ máy khác máy worker (event 4624 trên DC) |

Kết nối tới server (ingest) vẫn đi qua **HTTPS** với API key, không bị ảnh hưởng.

Lưu ý: nếu sau này DC bật bắt buộc LDAP signing (chính sách *Domain controller: LDAP server signing
requirements = Require signing*, mặc định chặt hơn ở các bản Windows Server mới), DC sẽ từ chối simple bind
trên 389. Worker báo `ldap_bind_failed` (LDAP 8, "requires signing/TLS") và cảnh báo hiện ở Quản trị > Sync AD.
Khi đó cần cấp chứng chỉ cho DC và đổi `Protocol` sang `Ldaps`; chỉ cần sửa cấu hình, không phải cài lại worker.

### 4B.3. Tạo tài khoản đọc AD

Tạo tài khoản domain thường, ví dụ `CORP\svc-blk`, mật khẩu dài. Cấp quyền đọc key **chỉ trong các OU máy
tính** (chạy trên máy có RSAT AD, làm cho từng OU):

```powershell
dsacls "OU=Computers,DC=corp,DC=local" /I:S /G "CORP\svc-blk:RP;;msFVE-RecoveryInformation"
dsacls "OU=Computers,DC=corp,DC=local" /I:S /G "CORP\svc-blk:CA;msFVE-RecoveryPassword;msFVE-RecoveryInformation"
```

Không dùng tài khoản cá nhân hay tài khoản admin. Nên chặn đăng nhập tương tác cho tài khoản này.

### 4B.4. Build gói cài

Trên máy có Go:

```bash
cd worker-go
go test ./...
make package VERSION=1.0.0
```

Kết quả: `worker-go/dist/blk-sync-1.0.0-linux-amd64.tar.gz`. Gói gồm:
- binary `blk-sync` (build tĩnh);
- `install.sh`, `blk-sync.service`;
- `config.example.json`, `README.md`.

Không có `make` (Windows): xem mục 4 của [worker-go/README.md](worker-go/README.md).

### 4B.5. Cài lên máy chủ

```bash
scp worker-go/dist/blk-sync-1.0.0-linux-amd64.tar.gz admin@sync01:/tmp/
ssh admin@sync01
mkdir /tmp/blk-sync && tar -C /tmp/blk-sync -xzf /tmp/blk-sync-1.0.0-linux-amd64.tar.gz
cd /tmp/blk-sync && sudo ./install.sh
```

Script tạo user hệ thống `blk-sync` và cài các file:

| File | Nội dung |
| --- | --- |
| `/opt/blk-sync/blk-sync` | Binary |
| `/etc/blk-sync/config.json` | Cấu hình (chép từ `config.example.json` nếu chưa có) |
| `/etc/systemd/system/blk-sync.service` | Unit systemd, có hardening |
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
  "CaFile": ""                            // file PEM của CA, nếu máy chưa tin CA của DC
},
"Ingest": {
  "BaseUrl": "https://blk.corp.local:8443/api/ingest",
  "ApiKey": "cred:ingest-api-key"         // mặc định chỉ cần API key
}
```

**Xác thực với server: HTTPS + API key** (`INGEST_API_KEY` trong `server/.env`), và server chỉ nhận từ IP
máy worker: thêm IP đó vào `INGEST_ALLOWED_IPS`. Máy worker chưa tin CA của chứng chỉ server thì đặt
`Ingest.CaFile` (mục 3.6).

### 4B.7. Lưu bí mật

Mật khẩu AD và API key lưu thành **systemd credential mã hóa**. Unit đã khai báo sẵn hai credential này.
Giá trị được gõ ở dấu nhắc, không nằm trong lịch sử shell:

```bash
sudo sh -c 'systemd-ask-password -n "AD password:" | systemd-creds encrypt --name=ldap-password - /etc/blk-sync/ldap-password.cred'
```

```bash
sudo sh -c 'systemd-ask-password -n "Ingest API key:" | systemd-creds encrypt --name=ingest-api-key - /etc/blk-sync/ingest-api-key.cred'
```

systemd quá cũ (không có `systemd-creds`, trước v250): ghi bí mật vào file chỉ user `blk-sync` đọc được
(`chown blk-sync /etc/blk-sync/ldap-password; chmod 0400 ...`), dùng `"Password": "file:/etc/blk-sync/ldap-password"`,
và bỏ hai dòng `LoadCredentialEncrypted=` trong unit.

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
sẽ tranh nhau mở lượt sync (409 `run_in_progress`).

### 4B.9. Cập nhật và gỡ cài đặt

Cập nhật: build gói mới (`make package VERSION=1.1.0`), chép lên máy chủ, giải nén, rồi:

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
2. **Tạo chi nhánh** (Quản trị > Chi nhánh & OU): nhập mã, tên và các OU máy tính của chi nhánh, ví dụ
   `OU=Computers,OU=HN,DC=corp,DC=local`. Một OU chỉ thuộc một chi nhánh. Máy trong OU con cũng
   thuộc chi nhánh đó. Màn hình xem trước cho biết bao nhiêu máy sẽ được map lại. Khi bấm Lưu, app
   **quét toàn bộ máy và gán vào chi nhánh theo OU ngay**, không cần chờ lượt sync; thông báo sau khi
   lưu cho biết chi nhánh vừa nhận bao nhiêu máy.
   - **Xóa chi nhánh**: Sửa > **Xóa chi nhánh…** (hoặc link Xóa ở danh sách). Trang xác nhận cho biết số
     máy sẽ chuyển về N/A, các OU bị gỡ, số quyền người dùng bị gỡ và những người sẽ không còn quyền
     nào; phải **gõ lại mã chi nhánh** rồi xác nhận lần nữa mới xóa. Máy của chi nhánh chuyển về
     **N/A**; máy nằm trong OU của chi nhánh khác (ví dụ OU cha) chuyển sang chi nhánh đó. Key và nhật
     ký giữ nguyên. Không hoàn tác được.
   - **Chỉ Admin HQ** được thêm, sửa, xóa chi nhánh và OU (Trưởng IT, IT, Auditor nhận lỗi 403).
3. **Tạo người dùng** (Quản trị > Người dùng):
   - **AD** (mặc định): nhập sAMAccountName, ví dụ `nguyenvana`. Người dùng đăng nhập bằng mật khẩu
     Windows. Có thể gõ `nguyenvana`, `CORP\nguyenvana` hoặc `nguyenvana@corp.local`.
   - **Local**: app cấp mật khẩu một lần, người dùng phải đổi ở lần đăng nhập đầu. Chỉ nên dùng cho
     tài khoản admin dự phòng.
   - **Email** là bắt buộc. App lưu email dạng chữ thường. Với tài khoản AD chưa có email (ví dụ tạo
     bằng dòng lệnh không kèm email), app tự lấy thuộc tính `mail` trong AD ở lần đăng nhập tới. Email
     đã nhập trong app không bao giờ bị AD ghi đè. Tài khoản `admin` mặc định chưa có email: hãy nhập
     khi sửa user này lần đầu. Danh sách người dùng gắn nhãn "Chưa có email" cho những ai còn thiếu.
   - Gán vai trò:

     | Vai trò | Quyền |
     | --- | --- |
     | `it` | Tìm máy, hiện key của chi nhánh được gán |
     | `lead` | Như `it`, thêm xem nhật ký và báo cáo của chi nhánh |
     | `admin` | Admin HQ: mọi chi nhánh (kể cả máy N/A), toàn bộ menu Quản trị: chi nhánh, người dùng, sync, mail, thông báo, tính năng, lưu trữ |
     | `auditor` | Xem nhật ký và báo cáo của chi nhánh được gán, không hiện được key |

     **Chỉ Admin HQ xem được toàn bộ chi nhánh** (và máy N/A). IT, Trưởng IT, Auditor luôn được gán **theo từng
     chi nhánh** và mọi trang (Tổng quan, Tìm máy, Nhật ký, Báo cáo, xuất CSV / Excel) chỉ hiện dữ liệu của chi
     nhánh đó. Quyền "tất cả chi nhánh" cho vai trò khác Admin HQ không tạo được (form, API, dòng lệnh, ràng buộc
     trong DB); migration 026 xóa các quyền như vậy còn sót. Lọc chi nhánh có 2 lớp: điều kiện trong mọi truy vấn
     và Row-Level Security của PostgreSQL.

   - Tài khoản AD chưa được tạo trong app thì không đăng nhập được. Lần đăng nhập AD đầu tiên, app
     gắn tài khoản với objectGUID của AD. Nếu tài khoản AD bị xóa rồi tạo lại cùng tên, app từ chối
     cho đến khi admin bấm "Gỡ liên kết AD".
4. **Kiểm tra sync** (Quản trị > Sync AD): xem lượt full đầu tiên, số máy, số key và các
   cảnh báo đang mở.
5. **Máy N/A** (Quản trị > Chi nhánh & OU): máy nằm ngoài mọi OU đã khai báo hiển thị là N/A và chỉ
   Admin HQ thấy. Bấm "Xem danh sách" (hoặc lọc Chi nhánh = N/A ở trang Tìm máy), rồi bổ sung OU cho
   chi nhánh tương ứng.
6. **Cấu hình mail** (Quản trị > Mail server): nhập SMTP, bấm **Gửi thử**. Sau đó chọn loại thông báo
   ở Quản trị > Thông báo (cảnh báo hệ thống; máy mới / key mới gửi cho người dùng chi nhánh và/hoặc
   Admin HQ).
7. **Rà soát tính năng và lưu trữ** (Quản trị > Tính năng, Quản trị > Lưu trữ): chọn ai được xuất kèm
   recovery key (mặc định tắt), thời gian giữ nhật ký, lịch sử sync và email.

---

## 6. Vận hành hằng ngày

### 6.1. Lượt sync bị giữ lại (cách ly)

Các ngưỡng dưới đây (và ngưỡng của watchdog ở mục 6.2) chỉnh được tại **Quản trị > Ngưỡng cảnh báo**.
Các ngưỡng **độc lập** với nhau: chỉ cần một ngưỡng vượt là lượt sync bị giữ lại (hoặc mở cảnh báo). Riêng hai
cặp phải vượt **cả hai**: "chi nhánh giảm quá X%" **và** "quá N máy"; "máy mới chưa có key quá X%" **và** "số máy
mới ít nhất N". Trang Ngưỡng cảnh báo đánh dấu dòng thứ hai của mỗi cặp bằng nhãn **VÀ**. "Quá" là lớn hơn hẳn.

Có những lượt sync báo thành công nhưng số liệu bất thường. Server giữ lại thay đổi của các lượt
này, gửi cảnh báo và chờ Admin HQ quyết định:

| Trường hợp | Ngưỡng mặc định |
| --- | --- |
| Lượt full thấy ít máy hơn hẳn so với DB | dưới 95% |
| Lượt full thấy ít key hơn hẳn so với DB | dưới 95% |
| Một chi nhánh giảm mạnh so với mức thường | giảm hơn 20% và hơn 10 máy |
| Lượt full không thấy nhiều máy (các máy này sẽ bị gắn nhãn "Không còn trong AD") | quá 5% |
| Đọc được key nhưng mật khẩu rỗng (tài khoản sync mất quyền) | từ 1 key |

Xử lý tại Quản trị > Sync AD:

- **Chấp nhận** khi thay đổi là thật, ví dụ vừa xóa hàng loạt máy cũ trong AD. Khi đó app gắn nhãn
  "Không còn trong AD" và lưu mốc USN.
- **Bác bỏ** khi dữ liệu sai, ví dụ DC lỗi hoặc tài khoản mất quyền. Khi đó không áp dụng gì và lượt
  full sau đọc lại từ đầu.

Key mới đọc được trong lượt bị giữ vẫn được lưu ngay, vì key không bao giờ bị ghi đè hay xóa.

### 6.2. Cảnh báo

Watchdog chạy mỗi 5 phút và kiểm tra các điều kiện: worker không gửi heartbeat, quá lâu không có lượt
sync thành công, worker không đọc được AD, chứng chỉ LDAPS sắp hết hạn, DC ngừng replicate, máy mới
không lưu key lên AD...

- Gặp **ít nhất một** điều kiện: đồng bộ AD được đánh dấu **Offline** và gửi **một** email/Teams
  "Đồng bộ AD đang Offline (N sự cố)" liệt kê các điều kiện đang gặp (không gửi mail riêng cho từng điều kiện).
- Còn Offline: gửi nhắc lại **tối đa 1 lần mỗi ngày** (theo ngày lịch, APP_TZ), dù watchdog vẫn chạy mỗi 5 phút.
- Hết mọi điều kiện: tự về **Online**, **không gửi gì nữa** (không có mail "đã khôi phục").
- Trạng thái Online / Offline và từng cảnh báo đang mở xem ở **Quản trị > Sync AD**; trang Tổng quan
  của Admin HQ hiện "Đồng bộ AD đang Offline từ …".

Chuỗi hash của nhật ký bị gãy (kiểm tra mỗi ngày) và lượt sync báo lỗi vẫn gửi cảnh báo riêng như cũ.

Ngưỡng của watchdog (mặc định) chỉnh ở **Quản trị > Ngưỡng cảnh báo**:

| Ngưỡng | Mặc định |
| --- | --- |
| Không có heartbeat của worker quá | 15 phút |
| Không có lượt sync thành công quá | 60 phút (cũng là mốc báo "dữ liệu cũ" ở trang Tổng quan) |
| Không có lượt full thành công quá | 26 giờ |
| Lượt sync "đang chạy" quá lâu thì hủy | 2 giờ |
| USN của DC không đổi quá | 6 giờ |
| Giá trị canary cũ quá | 90 phút |
| Máy mới (2–7 ngày) chưa có key quá | 50%, chỉ xét khi có từ 5 máy mới |
| Tỉ lệ máy chưa có key của chi nhánh tăng quá (so với tuần trước) | 5 điểm % |

Trang **Tổng quan** có dòng "Dữ liệu cập nhật lần cuối lúc …" (lượt sync thành công gần nhất) cho mọi
người dùng. Khi quá ngưỡng "Không có lượt sync thành công" ở trên, hoặc chưa sync lần nào, dòng này
chuyển thành cảnh báo để người dùng biết dữ liệu có thể đã cũ.

Trang Tổng quan còn có ba biểu đồ đường (rê chuột lên để xem số từng ngày), đều trong phạm vi chi
nhánh của người xem:

| Biểu đồ | Ai thấy | Cách tính |
| --- | --- | --- |
| Số máy trên hệ thống, 30 ngày | Mọi người dùng | Máy được tính từ ngày hệ thống ghi nhận đến khi bị gắn nhãn "Không còn trong AD" (theo chi nhánh hiện tại của máy) |
| Số key trên hệ thống, 30 ngày | Mọi người dùng | Key được tính từ ngày ghi nhận (key không bao giờ bị xóa) |
| Lượt hiện key mỗi ngày, 14 ngày | Trưởng IT, Admin HQ, Auditor | Số dòng `reveal` trong nhật ký truy cập |

Trục dọc của hai biểu đồ máy/key không bắt đầu từ 0, để thay đổi nhỏ trên tổng lớn vẫn nhìn thấy được.

Khung **Theo chi nhánh** ở Tổng quan là biểu đồ thanh ngang: mỗi chi nhánh một thanh đại diện cho toàn bộ
máy của chi nhánh, phần **xanh** là % máy đã có key, phần **đỏ** là % máy chưa có key; bên phải ghi tổng số
máy, thanh cuối là tổng. Rê chuột lên thanh để xem số máy; bấm phần đỏ để mở danh sách máy chưa có key ở
trang Tìm máy. Số liệu đầy đủ (số máy, có key, chưa có key, số key, lượt hiện key 30 ngày) nằm trong
**Xem bảng số liệu** ngay dưới biểu đồ. Mặc định hiện 10 chi nhánh nhiều máy nhất; bấm **Xem tất cả** để hiện đủ. Báo cáo đầy đủ theo kỳ ở
trang Báo cáo (mục 6.11).

### 6.3. Trang Quản trị: mail, thông báo, tính năng, ngưỡng, lưu trữ

Mọi cấu hình của Admin HQ nằm trong menu **Quản trị**, gom thành 4 nhóm (hàng nút trên cùng); bấm một nhóm thì
hàng dưới hiện các tab của nhóm đó:

| Nhóm | Tab |
| --- | --- |
| Người dùng & chi nhánh | Chi nhánh & OU, Người dùng |
| Đồng bộ AD | Tình trạng sync (Sync AD: mỗi worker có nhãn **Online** xanh khi có heartbeat trong ngưỡng watchdog, mặc định 15 phút, **Offline** đỏ khi quá), Ngưỡng cảnh báo |
| Email | Thông báo, Mail server, Log email |
| Hệ thống | Bảo mật, Sao lưu, Tính năng, Lưu trữ |

Nội dung từng tab:

| Tab | Nội dung |
| --- | --- |
| Chi nhánh & OU | Thêm/sửa/xóa chi nhánh và OU gốc (lưu là quét lại máy theo OU ngay; xóa thì máy về N/A, có bước gõ mã để xác nhận); máy ngoài mọi OU hiển thị là N/A |
| Người dùng | Tài khoản, email, cách đăng nhập, quyền |
| Sync AD | Tình trạng sync, yêu cầu sync, chấp nhận/bác bỏ lượt bị giữ lại |
| Ngưỡng cảnh báo | Ngưỡng giữ lại lượt sync (mục 6.1) và ngưỡng watchdog (mục 6.2). Mỗi ô có khoảng cho phép và giá trị mặc định bên cạnh; giá trị ngoài khoảng bị từ chối. Các ngưỡng phải vượt cùng lúc (VÀ) được gom trong một khung viền xanh; các ngưỡng còn lại độc lập (HOẶC). Thay đổi có hiệu lực trong vòng 30 giây và được ghi nhật ký (`admin_change`, `settings_thresholds`) |
| Mail server | SMTP: địa chỉ, cổng, STARTTLS/SSL/không mã hóa, tài khoản xác thực, địa chỉ gửi, địa chỉ web của app; nút **Gửi thử** |
| Thông báo | Bật/tắt email cảnh báo (gửi Admin HQ và các địa chỉ thêm); email khi có **máy mới** / **key mới**, gửi cho người dùng của chi nhánh và/hoặc Admin HQ; **báo cáo hằng ngày** (bật/tắt, giờ gửi, kỳ số liệu, người nhận, nút **Gửi thử báo cáo ngay**) |
| Log email | Mọi email hệ thống tạo ra: chờ gửi / đã gửi / thất bại / không gửi (thiếu email). Mỗi email ghi **đã gửi cho ai** và **ai lẽ ra nhận nhưng chưa có email**; lọc, tìm theo tiêu đề / email / tên người dùng, xem nội dung, gửi lại mail thất bại |
| Bảo mật | **Chính sách mật khẩu** tài khoản nội bộ (độ dài tối thiểu, độ phức tạp); thời gian **tự đăng xuất khi không hoạt động** (5–480 phút) và **thời gian tối đa của phiên** (1–24 giờ); mặc định lấy từ `SESSION_IDLE_MINUTES` / `SESSION_MAX_HOURS` (mục 6.14) |
| Tính năng | Bật/tắt: yêu cầu sync từ web, xuất CSV nhật ký, xuất CSV danh sách máy, cảnh báo khi xem key ngoài giờ làm việc, bắt buộc số ticket. Chọn ai được **xuất kèm recovery key**: tắt (mặc định) / chỉ Admin HQ / IT, Trưởng IT và Admin HQ |
| Sao lưu | Sao lưu máy + recovery key (CSV) và database (pg_dump) ra file .zip mã hóa AES-256: lịch hằng ngày, mật khẩu mã hóa, số bản giữ lại, **Sao lưu ngay**, tải file (mục 6.8) |
| Lưu trữ | Số ngày giữ **nhật ký truy cập** (mặc định giữ mãi, tối thiểu 365), **lịch sử sync** (mặc định 180, tối thiểu 30) và **email** (mặc định 90); nút **Dọn dẹp ngay** |

Cách gửi mail:

- Mọi email được ghi vào bảng `mail_outbox` trước. Job `mail-outbox` chạy mỗi phút để gửi. Lỗi tạm
  thời được thử lại sau 1, 5, 15, 60 và 240 phút; sau đó mail bị đánh dấu thất bại và Admin HQ có
  thể bấm gửi lại.
- Job `data-retention` chạy lúc 03:00 và xóa dữ liệu quá hạn theo tab Lưu trữ (xem mục 6.7). Mail
  đang chờ gửi không bị xóa.
- Mật khẩu SMTP được mã hóa AES-256-GCM bằng khóa suy ra từ `LOG_HMAC_KEY`, và không bao giờ hiển
  thị lại. Đổi `LOG_HMAC_KEY` thì phải nhập lại mật khẩu SMTP.
- Nếu tắt mail server trong Quản trị, app dùng `SMTP_URL` trong `.env` (nếu có). Các địa chỉ trong
  `NOTIFY_TO` luôn nhận email cảnh báo.
- Email máy mới / key mới: sau mỗi lượt sync, mỗi người nhận **một** email gom các máy/key mới trong
  phạm vi của họ. Người dùng chi nhánh (vai trò IT, Trưởng IT) chỉ nhận máy thuộc OU chi nhánh mình;
  Admin HQ nhận tất cả, kể cả máy N/A. Mặc định không gửi cho lượt full sync đầu tiên (lượt này thấy
  mọi máy là mới). Email chỉ có Key ID, **không bao giờ có recovery key**.
- Chỉ người dùng đang hoạt động và có email mới nhận được. Người dùng lẽ ra nhận nhưng **chưa có email**
  vẫn được ghi lại: Log email hiện "Không có email: <tên người dùng>" trên đúng email đó.
- Email máy mới / key mới: những người nhận cùng một danh sách (ví dụ các Admin HQ, IT cùng chi nhánh) được gộp
  vào **một** email, nên mỗi dòng log cho thấy đầy đủ gửi cho ai và ai thiếu email.
- Không ai trong số người nhận có email: email vẫn được lưu với trạng thái **Không gửi (thiếu email)**, kèm lý
  do và nguyên nội dung, để Admin HQ biết đã bỏ lỡ thông báo nào. Thêm email ở Quản trị > Người dùng; các
  lượt sync sau sẽ gửi bình thường (email đã lỡ không tự gửi lại).
- Mail server đang tắt hoặc chưa cấu hình: email nằm ở **Chờ gửi** (ghi chú "SMTP server not configured")
  và tự gửi khi bật Mail server.

**Báo cáo hằng ngày** (Quản trị > Thông báo > Báo cáo hằng ngày, mặc định tắt):

- Mỗi ngày **một** email (HTML, kèm bản chữ thường) gửi mọi Admin HQ có email (nếu chọn) và các địa chỉ thêm.
- **Giờ gửi** theo `APP_TZ` (mặc định 07:30). Job `daily-report` kiểm tra mỗi phút; quá giờ mà hôm nay chưa gửi thì gửi
  (app tắt lúc đến giờ thì gửi bù khi chạy lại). Bật sau giờ gửi của hôm nay thì báo cáo đầu tiên vào ngày mai.
- **Số liệu của**: *Hôm qua (cả ngày)*, hợp với gửi buổi sáng; hoặc *Hôm nay, tính đến giờ gửi*, hợp với gửi cuối ngày.
- Nội dung:
  - **Đồng bộ AD**: Online / Offline (từ lúc nào), từng worker (heartbeat gần nhất, còn chạy hay không, LDAP OK hay lỗi, DC),
    lượt sync thành công / full gần nhất, số lượt thành công / lỗi / bị giữ lại trong kỳ, lượt chờ duyệt, cảnh báo đang mở,
    Key ID trùng chưa xem xét.
  - **Máy** và **key**: tổng hiện tại và tăng / giảm so với ngày trước; máy mới ghi nhận, máy không còn trong AD; key mới
    ghi nhận, key thuộc máy vừa rời AD (vẫn lưu), key chuyển máy (join lại AD).
  - **Chi nhánh có thay đổi** (tối đa 15): máy mới, rời AD, key mới.
  - **Biểu đồ cột số máy và số key 10 ngày gần nhất** (số cuối mỗi ngày, dòng dưới là tăng / giảm). Biểu đồ dựng bằng
    bảng HTML nên hiện được trên Outlook, Gmail và điện thoại, không cần ảnh đính kèm.
- Không có recovery key, không liệt kê máy. Tiêu đề và câu mở đầu sửa được ở mẫu `daily_report` (mục 6.6).
- **Gửi thử báo cáo ngay** tạo báo cáo với cấu hình đã lưu và gửi ngay (không tính là báo cáo theo lịch). Log email có
  nút **Xem bản HTML** để xem email đúng như trong hộp thư.

### 6.4. Bộ lọc và xuất dữ liệu ở trang Tìm máy

Mỗi máy và mỗi key có hai mốc thời gian:

| Mốc | Ý nghĩa |
| --- | --- |
| **Tạo trên AD** | `whenCreated` của object máy / key trong AD |
| **Ghi nhận** (trên hệ thống) | Lần đầu app thấy máy / key qua đồng bộ AD. Máy có từ trước khi nâng cấp lấy giờ bắt đầu của lượt sync đầu tiên thấy máy |

Cả hai hiện trong danh sách máy, kết quả tìm kiếm, trang chi tiết máy (bảng key cũng vậy) và trong file
CSV.

Bộ lọc của danh sách "Máy trong phạm vi của bạn": chi nhánh (kể cả N/A), tình trạng, có tính máy không
còn trong AD hay không, và **khoảng ngày xuất hiện**: chọn lọc theo ngày *Ghi nhận trên hệ thống*
(mặc định) hoặc *Tạo trên AD*, rồi nhập từ ngày / đến ngày (tính cả hai đầu, theo giờ `APP_TZ`). Ví dụ
xem máy mới xuất hiện tuần này: Ghi nhận trên hệ thống, từ thứ Hai đến hôm nay.

Danh sách có hai nút xuất. Cả hai xuất **toàn bộ** danh sách theo bộ lọc đang chọn, không chỉ trang
đang xem, và chỉ trong phạm vi chi nhánh của người xuất.

| Nút | Nội dung file CSV | Ai dùng | Ghi nhật ký |
| --- | --- | --- | --- |
| **Xuất CSV** | Tên máy, GUID máy (`object_guid`), DNS, chi nhánh, DN, OS, serial máy, email người dùng, số key, ngày key mới nhất, ngày tạo trên AD (`ad_created_utc`), ngày ghi nhận (`first_seen_utc`), còn trong AD hay không. **Không có key** | IT, Trưởng IT, Admin HQ (tắt được ở tab Tính năng) | Một dòng `export_computers` |
| **Xuất kèm key** | Mỗi dòng một key: máy, GUID máy (`computer_object_guid`), chi nhánh, DN, Key ID, ổ đĩa (volume GUID), serial máy, email người dùng, trạng thái, ngày tạo trên AD (`key_created_utc`), ngày ghi nhận (`key_recorded_utc`), **recovery password** | Theo tab Tính năng: tắt (mặc định) / chỉ Admin HQ / IT, Trưởng IT và Admin HQ | Mỗi key một dòng `reveal` (như hiện key) + một dòng `export_keys`; Admin HQ nhận cảnh báo |

Xuất kèm key đi qua một trang xác nhận: trang này cho biết số key và số máy sẽ xuất, và bắt chọn lý
do (cùng danh sách lý do, ghi chú và số ticket như khi hiện key). File CSV có BOM UTF-8 để Excel đọc
đúng tiếng Việt, và ô bắt đầu bằng `= + - @` được vô hiệu để tránh công thức độc hại. **Lưu file có key
ở nơi an toàn và xóa ngay khi dùng xong.**

### 6.5. Thông tin bổ sung của máy

Mỗi máy có thêm hai trường do người dùng nhập: **Serial máy** và **Email người dùng**. Khi máy được
sync từ AD về, hai trường này để trống; sync không bao giờ ghi đè chúng.

- Hai trường hiện trong phần thông tin máy (trang chi tiết máy). Bấm **Sửa thông tin** để nhập. Ai
  xem được key của máy (IT, Trưởng IT của chi nhánh, Admin HQ) thì sửa được. Để trống một ô để xóa giá
  trị. Email được kiểm tra định dạng.
- Mỗi lần lưu ghi một dòng `computer_edit` vào nhật ký, kèm giá trị trước và sau.
- Hai trường có trong cả hai file CSV: "Xuất CSV" và "Xuất kèm key".
- Ô **Tìm máy** (chỉ trong phạm vi chi nhánh của người tìm, không phân biệt hoa thường):
  - **Key ID**: từ **4 ký tự đầu** (màn hình BitLocker hiện 8 ký tự đầu), hoặc cả Key ID; có hay không có dấu `-` đều được.
  - **Tên máy, serial, email**: **một phần bất kỳ** từ 3 ký tự, bỏ qua dấu `-`, `_`, `.` và khoảng trắng
    (`0231` hay `lt0231` đều ra `HN-LT-0231`); gõ 2 ký tự thì chỉ khớp phần đầu. Khớp đúng hoàn toàn xếp đầu,
    rồi khớp phần đầu, rồi chứa ở giữa; máy khớp theo serial / email có nhãn ghi rõ.
  - Chuỗi vừa giống Key ID vừa là một phần tên máy (ví dụ `0231`): hiện cả key khớp và máy khớp.
  - **GUID máy** (objectGUID): dán cả GUID.
  - Tìm "chứa" dùng index trigram (`pg_trgm`, migration 022), vẫn nhanh khi có nhiều máy.
- API: `PUT /api/computers/:id/info` với `{ deviceSerial, ownerEmail }`; `GET /api/computers/:id` trả
  về `device_serial`, `owner_email`.

### 6.6. Mẫu email

Nội dung mọi email và tin Teams app gửi nằm trong **một file**: `server/templates/mail-templates.yaml`.
File có sẵn đầy đủ các mẫu (tiếng Việt), nên cài xong là dùng được ngay; chỉ sửa khi muốn đổi câu chữ.
Đầu file có bảng giải thích từng trường và từng biến (ý nghĩa, giá trị ví dụ, mẫu nào dùng).

Trong file, mỗi mẫu có:

| Trường | Ý nghĩa |
| --- | --- |
| `used_by` | Tính năng nào gửi mẫu này |
| `sent_when` | Gửi khi nào |
| `recipients` | Ai nhận, theo cài đặt nào |
| `variables` | Các biến dùng được, viết `{{tên}}` trong `subject` / `body` |
| `subject`, `body` | Tiêu đề và nội dung: phần bạn sửa |

Chỉ `subject`, `body` (và `parts` của `new_objects`) tạo nên email; các trường còn lại để tra cứu.

**Mẫu nào dùng cho tính năng nào:**

| Mẫu | Tính năng / khi nào gửi |
| --- | --- |
| `sync_failed`, `sync_failed_recovered` | Worker báo lượt sync lỗi; lượt sau thành công |
| `sync_anomaly`, `sync_anomaly_recovered` | Lượt sync bị giữ lại vì số liệu bất thường; Admin HQ chấp nhận / bác bỏ |
| `sync_offline` | Watchdog: mail duy nhất khi đồng bộ AD Offline, liệt kê các điều kiện; tối đa 1 lần mỗi ngày, hết lỗi thì không gửi |
| `worker_silent`, `sync_stale`, `full_stale`, `sync_run_aborted`, `ldap_error`, `dc_cert_expiring`, `canary_stale`, `dc_usn_stalled`, `escrow_broken`, `no_key_rising` | Điều kiện của watchdog: không gửi mail riêng; tiêu đề hiện ở Quản trị > Sync AD và trong mail `sync_offline` |
| `audit_chain_broken`, `audit_chain_broken_recovered` | Kiểm tra chuỗi hash nhật ký (02:00 hằng ngày) |
| `recovered` | Thông báo "đã khôi phục" chung cho cảnh báo không có mẫu `<tên>_recovered` riêng (watchdog không dùng) |
| `reveal_out_of_hours` | Có người hiện key ngoài giờ làm việc |
| `key_export` | Có người xuất kèm recovery key ra CSV |
| `new_objects` | Sau lượt sync có máy mới / key mới (Quản trị > Thông báo) |
| `daily_report` | Báo cáo hằng ngày: tiêu đề và câu mở đầu (số liệu, bảng, biểu đồ do code tạo) |
| `smtp_test` | Nút "Gửi thử" ở Quản trị > Mail server |

Các mẫu có `kind: alert` được thêm tiền tố `alert_subject_prefix` (mặc định
`[BitLocker][HIGH] ` / `MEDIUM` / `INFO`) vào đầu tiêu đề; sửa ở dòng đầu file.

**Cách sửa:**

- Sửa `subject` / `body`, giữ nguyên tên mẫu và thụt lề YAML. Dùng `body: |` cho nội dung nhiều dòng.
- Chỉ dùng biến có trong `variables` của mẫu đó. Gõ sai tên biến thì email hiện nguyên chữ
  `{{tên_sai}}`, dễ phát hiện.
- Không có biến nào chứa recovery password, nên email không bao giờ có key.
- Lưu file là xong: lần gửi kế tiếp dùng nội dung mới, **không cần khởi động lại**.
- Nếu bản sửa làm hỏng file (YAML sai, thiếu mẫu), app giữ bản tốt trước đó và ghi lỗi
  `mail templates: bad edit ignored` vào log. Khi khởi động, app từ chối chạy nếu file hỏng và ghi rõ
  thiếu mẫu nào.
- Thử: Quản trị > Mail server > **Gửi thử** dùng mẫu `smtp_test`; email khác xem ở Quản trị > Log email.

**Ở đâu:**

| Môi trường | File cần sửa |
| --- | --- |
| Dev (`docker compose up --watch`) | `server/templates/mail-templates.yaml` trong repo; watch tự chép vào container |
| Production bằng Docker | Chép file ra máy chủ (ví dụ `/etc/blk/mail-templates.yaml`), mount vào container và trỏ biến môi trường tới nó: `-v /etc/blk/mail-templates.yaml:/app/config/mail-templates.yaml:ro` và `MAIL_TEMPLATES_FILE=/app/config/mail-templates.yaml`. Nhờ vậy cập nhật phiên bản app không ghi đè bản bạn đã sửa |
| Production không dùng Docker | `server/templates/mail-templates.yaml`, hoặc đặt `MAIL_TEMPLATES_FILE` trỏ tới file ở chỗ khác |

Khi cập nhật app lên phiên bản mới, so file mẫu mới trong repo với bản của bạn: phiên bản mới có
thể thêm mẫu, và app sẽ báo thiếu mẫu nếu file của bạn chưa có.

### 6.7. Thời gian lưu trữ

Tab Quản trị > Lưu trữ. Job `data-retention` chạy lúc 03:00 hằng ngày (hoặc bấm **Dọn dẹp ngay**):

| Dữ liệu | Mặc định | Giới hạn | Ghi chú |
| --- | --- | --- | --- |
| Nhật ký truy cập (`access_log`) | Giữ mãi | Tối thiểu 365 ngày | Xem bên dưới |
| Lịch sử sync: lượt sync, số liệu, cảnh báo đã đóng | 180 ngày | Tối thiểu 30 ngày | Luôn giữ lượt sync thành công gần nhất và lượt full thành công gần nhất (delta sync và kiểm tra bất thường cần chúng) |
| Email đã gửi / thất bại | 90 ngày | 1–3650 ngày | Mail đang chờ gửi không bị xóa |

Máy, recovery key và người dùng không bao giờ bị xóa.

Nhật ký truy cập vẫn chỉ ghi thêm (append-only): app không có quyền DELETE, và trigger chặn mọi
UPDATE, DELETE, TRUNCATE. Khi bật hạn lưu trữ, việc xóa chỉ đi qua hàm `purge_access_log()` trong DB:

- Hàm chỉ xóa **phần cũ nhất, liên tục từ đầu chuỗi** (không bao giờ xóa ở giữa) và không bao giờ
  xóa dòng mới nhất.
- Mỗi lần xóa, hàm lưu một mốc vào bảng `access_log_purge`: hash của dòng cuối bị xóa, số dòng, người
  chạy.
- Job kiểm tra chuỗi hash (02:00) bắt đầu từ mốc đó, nên phần còn lại vẫn kiểm chứng được. Ai xóa
  thêm dòng ngoài app sẽ bị phát hiện.
- Bản thân việc xóa cũng được ghi vào nhật ký (`log_purge`).

Nên đẩy nhật ký sang SIEM trước khi bật hạn lưu trữ.

### 6.14. Xác thực 2 bước, bắt đổi mật khẩu, thời gian phiên

**Xác thực 2 bước** (TOTP, app Microsoft Authenticator / Google Authenticator), bật cho **từng người** ở Quản trị >
Người dùng > Thêm / Sửa, ô **Bắt buộc xác thực 2 bước**. Dùng được cho cả tài khoản AD và tài khoản nội bộ.

- Lần đăng nhập đầu sau khi bật: nhập mật khẩu xong, trang hiện **mã QR**; người dùng quét bằng app (hoặc nhập khóa
  hiện bên dưới) rồi nhập mã 6 số để hoàn tất. Từ lần sau: mật khẩu, rồi mã 6 số trong app.
- Chưa nhập đúng mã thì **chưa đăng nhập**: không mở được trang nào. Trang nhập mã hết hạn sau 5 phút.
- Mã đổi mỗi 30 giây, chấp nhận lệch đồng hồ 1 bước, **mỗi mã chỉ dùng một lần**. Sai mã tính như sai mật khẩu:
  5 lần thì khóa tài khoản 15 phút. Nhật ký ghi `login` (detail `twoFactor`) và `login_failed` (`wrong_totp`).
- Khóa bí mật được mã hóa AES-256-GCM (khóa suy ra từ `LOG_HMAC_KEY`, như mật khẩu SMTP), không bao giờ hiện lại.
  Đổi `LOG_HMAC_KEY` thì mọi người dùng 2 bước phải thiết lập lại (Admin HQ bấm Đặt lại).
- **Mất / đổi điện thoại**: Admin HQ bấm **Đặt lại xác thực 2 bước** ở trang sửa người dùng; lần đăng nhập tới người
  dùng quét mã QR mới. Bỏ chọn ô Bắt buộc rồi lưu thì tắt và xóa thiết lập cũ.
- Danh sách Người dùng có cột **2 bước**: Tắt / Chờ thiết lập / Bật.
- API: `POST /api/auth/login` trả `{ secondFactor: 'setup' | 'code', csrfToken }` thay vì đăng nhập ngay; lần đầu gọi
  `GET /api/auth/2fa/setup` (lấy `secret`, `otpauthUri`), rồi `POST /api/auth/2fa` `{ code }` (kèm `X-CSRF-Token`).
  Tài khoản dùng cho script thường để tắt xác thực 2 bước.

**Chính sách mật khẩu tài khoản nội bộ** (Quản trị > Bảo mật): **độ dài tối thiểu** (8–64, mặc định 12) và
**độ phức tạp**: chọn bắt buộc có chữ hoa, chữ thường, chữ số, ký tự đặc biệt (không phải chữ hoặc số). Luôn áp dụng
thêm: không chứa tên đăng nhập, khác mật khẩu hiện tại. Kiểm tra khi người dùng đổi mật khẩu (web và API, lỗi
`weak_password` kèm `reason`); mật khẩu đang dùng không bị kiểm tra lại, muốn áp dụng ngay thì bật "Bắt đổi mật khẩu".
Mật khẩu một lần hệ thống tạo (tạo user, đặt lại mật khẩu) luôn đạt chính sách. Tài khoản AD theo chính sách của AD.

**Bắt đổi mật khẩu ở lần đăng nhập sau** (chỉ tài khoản nội bộ; tài khoản AD đổi mật khẩu trên Windows): ô ở trang
Thêm / Sửa người dùng. Đang bật thì sau khi đăng nhập chỉ vào được trang Đổi mật khẩu. Tài khoản nội bộ mới tạo và mật
khẩu vừa đặt lại luôn phải đổi.

**Thời gian phiên** (Quản trị > Bảo mật, áp dụng cho web và API trong vòng 30 giây):

- **Tự đăng xuất sau X phút không hoạt động** (mặc định `SESSION_IDLE_MINUTES`, 15): server hủy phiên khi không có
  request nào trong X phút; trang đang mở (ví dụ trang hiện key bị bỏ quên) cũng tự chuyển về màn hình đăng nhập với
  thông báo "Phiên đăng nhập đã hết hạn".
- **Thời gian tối đa của phiên** (mặc định `SESSION_MAX_HOURS`, 8): quá thời gian này kể từ lúc đăng nhập thì phải đăng
  nhập lại, dù vẫn đang dùng.

### 6.8. Sao lưu và khôi phục

Quản trị > **Sao lưu** (chỉ Admin HQ) tạo file sao lưu **.zip**, mặc định **mã hóa AES-256**, theo lịch mỗi ngày hoặc
khi bấm **Sao lưu ngay**. Có hai loại, chọn một hoặc cả hai:

| Loại | Tên file | Nội dung | Dùng khi |
| --- | --- | --- | --- |
| Máy và key | `bitlocker-keys-YYYYMMDD-HHMMSS.zip` | `computers.csv` (id, objectGUID, tên, DNS, DN, chi nhánh, OS, serial, email, ngày tạo / sửa trên AD, ngày ghi nhận, còn trong AD, số key), `recovery_keys.csv` (Key ID, 8 ký tự đầu, **mật khẩu khôi phục**, DN của key trên AD, volume GUID, trạng thái, ngày tạo trên AD, ngày ghi nhận, lần hiện key gần nhất, máy chứa key: id, objectGUID, tên, DN, chi nhánh), `key_moves.csv` (key chuyển máy khi join lại AD), `manifest.json` (số máy, số key, SHA-256 từng file), `README.txt` | Cần tra key khi hệ thống hoặc DB không chạy: chỉ cần 7-Zip và Excel |
| Database | `bitlocker-db-YYYYMMDD-HHMMSS.zip` | `bitlocker.dump` (pg_dump định dạng custom của toàn bộ DB), `manifest.json`, `README.txt` | Khôi phục toàn bộ hệ thống |

- **Mã hóa** (ô "Mã hóa file sao lưu bằng mật khẩu", mặc định bật, khuyến nghị giữ bật). Tắt thì file là zip thường,
  mở được bằng mọi công cụ kể cả File Explorer mà **không cần mật khẩu**: ai có file là đọc được mọi recovery key.
  Chỉ tắt khi thư mục sao lưu và nơi chép file đến đã được mã hóa (BitLocker, kho backup mã hóa) và giới hạn quyền
  đọc. Trang Sao lưu hiện cảnh báo đỏ khi đang tắt; bảng file có cột **Mã hóa** (AES-256 / Không); nhật ký
  `backup_run` ghi `encrypted`.
- **Mật khẩu mã hóa** (cần khi bật mã hóa) do Admin HQ đặt ở trang Sao lưu (tối thiểu 16 ký tự, nên là một cụm từ dài). Hệ thống lưu
  mật khẩu đã mã hóa (khóa suy ra từ `LOG_HMAC_KEY`), **không bao giờ hiện lại** và không ghi vào file. **Phải lưu
  mật khẩu ở kho mật khẩu của công ty**: mất mật khẩu thì không mở được file. Đổi mật khẩu: file cũ vẫn mở bằng
  mật khẩu cũ. Bật mã hóa mà chưa đặt mật khẩu thì không sao lưu.
- Mở file bằng **7-Zip** hoặc WinRAR (chuẩn WinZip AES-256). File Explorer của Windows không mở được loại mã hóa này.
- **Giờ chạy** theo `APP_TZ`; job `backup` kiểm tra mỗi phút, mỗi ngày chạy một lần (app tắt lúc đến giờ thì chạy bù
  khi bật lại). **Giữ lại** N bản mới nhất mỗi loại (mặc định 14), bản cũ hơn tự xóa.
- Mỗi lượt sao lưu và mỗi lần **tải file** từ trang Sao lưu đều ghi nhật ký (`backup_run`, `backup_download`;
  không có mật khẩu hay key trong nhật ký). Lượt lỗi gửi cảnh báo **"Sao lưu lỗi"** (mẫu `backup_failed`) và hiện ở
  trang Sao lưu; lượt thành công sau đó gửi "Đã khôi phục".
- File ghi vào `BACKUP_DIR` (mặc định `backups` trong thư mục app; Docker: `./backups` trên máy chủ). Đây là bản
  trên **cùng máy chủ**: phải có job chép thư mục này sang nơi khác (máy chủ backup, NAS, băng từ) hằng ngày.

#### Cài đặt sao lưu database (một lần)

Sao lưu database dùng `pg_dump` (đã có trong image Docker của app) bằng tài khoản **chỉ đọc** `blk_backup`.
Tài khoản này cần `BYPASSRLS` để bản dump có đủ mọi chi nhánh; nó chỉ có quyền `SELECT`, không ghi được gì.

1. Tạo tài khoản bằng superuser PostgreSQL (thay mật khẩu):

   ```sql
   CREATE ROLE blk_backup LOGIN NOSUPERUSER NOCREATEROLE BYPASSRLS PASSWORD '<mật-khẩu-backup>';
   \c blk
   GRANT USAGE ON SCHEMA public TO blk_backup;
   GRANT SELECT ON ALL TABLES IN SCHEMA public TO blk_backup;
   GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO blk_backup;
   ALTER DEFAULT PRIVILEGES FOR ROLE blk_owner IN SCHEMA public GRANT SELECT ON TABLES TO blk_backup;
   ALTER DEFAULT PRIVILEGES FOR ROLE blk_owner IN SCHEMA public GRANT SELECT ON SEQUENCES TO blk_backup;
   ```

   (Tạo role trước khi chạy migration 027 thì migration tự cấp các quyền này.)
2. Thêm vào `server/.env`:

   ```
   BACKUP_DATABASE_URL=postgres://blk_backup:<mật-khẩu-backup>@<db-host>:5432/blk?sslmode=require
   BACKUP_DIR=/app/backups
   ```

   Chạy ngoài Docker thì cần `pg_dump` bản 17 trên máy (hoặc `PG_DUMP_PATH` trỏ tới nó).
3. Docker: thư mục `./backups` được mount vào `/app/backups`. Trên máy Linux, cho user của container (uid 1000)
   quyền ghi: `sudo mkdir -p backups && sudo chown 1000:1000 backups && sudo chmod 700 backups`.
4. Vào Quản trị > Sao lưu: đặt mật khẩu, chọn loại, giờ chạy, số bản giữ lại, bật sao lưu tự động, bấm
   **Sao lưu ngay** để thử.
5. Định kỳ (ví dụ mỗi quý) **thử khôi phục** vào một máy thử theo hướng dẫn dưới.

#### Tra key từ file sao lưu (hệ thống không chạy)

1. Mở file `bitlocker-keys-....zip` bằng 7-Zip, nhập mật khẩu sao lưu, giải nén vào **thư mục được mã hóa / chỉ
   mình bạn đọc được**.
2. Mở `recovery_keys.csv` bằng Excel (Data > From Text/CSV, UTF-8), lọc cột `key_id_first8` theo 8 ký tự trên màn
   hình BitLocker, đọc `recovery_password`.
3. Xong việc thì **xóa** các file đã giải nén (và dọn Thùng rác).

#### Khôi phục database

1. Chuẩn bị PostgreSQL 17 với các tài khoản như mục 3.2 (`blk_owner`, `app_node`, `blk_backup`), DB `blk` **rỗng**.
2. Giải nén lấy `bitlocker.dump`:

   ```bash
   7z x -p bitlocker-db-20261016-013000.zip
   ```

3. Khôi phục bằng superuser (hoặc `blk_owner`):

   ```bash
   pg_restore -U postgres -d blk --exit-on-error bitlocker.dump
   ```

4. Dùng **đúng `LOG_HMAC_KEY` cũ** trong `server/.env` (mật khẩu SMTP, khóa xác thực 2 bước, mật khẩu sao lưu được mã
   hóa bằng khóa suy ra từ nó; nhật ký được ký bằng nó). Khởi động app, kiểm tra: đăng nhập, tìm một máy, Quản
   trị > Sync AD chạy lượt full.
5. Xóa `bitlocker.dump` sau khi khôi phục.

#### Sao lưu database bằng tay (không qua app)

Khi cần một bản ngay trên máy chủ DB (ví dụ trước khi nâng cấp):

```bash
pg_dump -U blk_backup -h <db-host> -d blk --format=custom -f bitlocker.dump
7z a -tzip -mem=AES256 -p bitlocker-db-manual.zip bitlocker.dump
shred -u bitlocker.dump
```

(`7z a -p` hỏi mật khẩu khi gõ, không để lộ trong lịch sử lệnh. Với Docker dev: `docker compose exec db pg_dump -U postgres
-d blk --format=custom > bitlocker.dump`.)

#### Ngoài file sao lưu

- `LOG_HMAC_KEY`, `server/.env` và mật khẩu sao lưu: lưu ở kho secret, **tách khỏi** nơi để file sao lưu.
- Chứng chỉ HTTPS (`cert/`) và cấu hình worker.

### 6.9. Quản lý người dùng bằng dòng lệnh

```bash
docker compose exec server node src/cli/users.js list
docker compose exec server node src/cli/users.js create nguyenvana "Nguyen Van A" email=nguyenvana@corp.local it:HN
docker compose exec server node src/cli/users.js create-local backup.admin "Backup admin" email=it-hq@corp.local admin
docker compose exec server node src/cli/users.js email admin it-hq@corp.local
docker compose exec server node src/cli/users.js reset-password admin
```

Nếu chạy bằng `docker run`, thay `docker compose exec server` bằng `docker exec blk-server`.

### 6.10. Truy vết sync trong log

Mọi thay đổi do sync tạo ra được ghi vào log ứng dụng (JSON, mỗi dòng một sự kiện, tiếng Anh), có
`"component":"sync"` và `runId`. Log chỉ được ghi sau khi dữ liệu đã lưu (commit). Máy / key không
đổi gì chỉ được đếm trong dòng tổng kết, nên một lượt full 22k máy không làm ngập log. Log không bao
giờ chứa recovery password.

| `msg` | Khi nào | Thông tin kèm |
| --- | --- | --- |
| `sync run opened` | Worker mở lượt | mode yêu cầu / thực tế, dc, sinceUsn |
| `computer added` | Máy mới | computerId, objectGuid, name, dn, branchId |
| `computer moved to another branch` | DN đổi sang OU của chi nhánh khác (cũng ghi `computer_moved` vào Nhật ký) | fromBranchId, toBranchId, dn |
| `computer renamed or moved in AD` | Đổi tên, hoặc đổi OU trong cùng chi nhánh | fromName, fromDn, dn |
| `computer back in AD` | Máy từng "Không còn trong AD" xuất hiện lại | notInAdSince |
| `computer batch stored` | Tổng kết một lô máy | received, added, moved, changed, backInAd, unchanged, unmapped |
| `key added` | Key mới | keyId, computerId, computer, volumeGuid, createdInAd |
| `key volume recorded` | Key cũ được bổ sung ổ đĩa | keyId, volumeGuid |
| `key superseded by a newer key of the same volume` / `key is the active key of its volume` | Trạng thái key đổi | keyId, computer, volumeGuid, status |
| `key without a readable password (not stored)` (warn) | Đọc được key nhưng mật khẩu rỗng (thiếu quyền) | keyId, dn |
| `key with a malformed password (not stored)` (warn) | Mật khẩu sai định dạng | keyId, dn |
| `key for an unknown computer (sent back as orphan)` | Key của máy chưa có trong DB | keyId, computerDn |
| `key batch stored` | Tổng kết một lô key | received, added, volumeFilled, unchanged, emptyPassword, malformed, orphans, statusChanged |
| `sync anomaly` (warn) | Mỗi bất thường khiến lượt bị giữ lại | code, detail |
| `sync run quarantined (...)` | Lượt bị giữ lại | số máy/key thấy, plannedNotInAd |
| `computer not seen by the full run: flagged not in AD` | Mỗi máy bị gắn nhãn "Không còn trong AD" (lúc lượt kết thúc, hoặc khi Admin HQ chấp nhận lượt bị giữ lại) | computerId, objectGuid, name, branchId, lastSeenRun |
| `quarantined sync run decided` | Admin HQ chấp nhận / bác bỏ | decision, by, markedNotInAd |
| `sync run completed` / `sync run failed` | Kết thúc lượt | computersSeen, computersInDb, keysSeen, keysAdded, highestUsn, markedNotInAd / errorCode |

Xem log (dev):

```bash
docker compose logs server | grep '"component":"sync"'
```

Lọc một lượt, ví dụ lượt 812:

```bash
docker compose logs server | grep '"component":"sync"' | grep '"runId":812'
```

#### Log được ghi ở đâu, rotate thế nào

App không tự ghi file log: mọi log (kể cả log sync) in ra **stdout** dạng JSON, môi trường chạy app
giữ và xoay vòng log.

| Cách chạy | Log nằm ở | Rotate |
| --- | --- | --- |
| `docker compose` (dev) | Docker giữ theo container; xem bằng `docker compose logs server` | Đã cấu hình trong `docker-compose.yml`: driver `local`, 20 MB × 10 file mỗi container, có nén |
| `docker run` (production) | Như trên (trên Linux: `/var/lib/docker/containers/<id>/`) | Thêm `--log-driver local --log-opt max-size=50m --log-opt max-file=20` (đã có trong lệnh ở mục 3.5). Hoặc đặt cho mọi container trong `/etc/docker/daemon.json` rồi khởi động lại Docker: `{ "log-driver": "local", "log-opts": { "max-size": "50m", "max-file": "20" } }` |
| Node trực tiếp bằng systemd | journald; xem bằng `journalctl -u blk-server` | journald tự xoay vòng; giới hạn dung lượng bằng `SystemMaxUse=2G` trong `/etc/systemd/journald.conf` |
| Node trực tiếp, ghi ra file (`npm start >> /var/log/blk/app.log`) | File bạn chọn | Dùng logrotate với `copytruncate`, ví dụ `/etc/logrotate.d/blk`: `/var/log/blk/*.log { daily rotate 30 compress copytruncate missingok }` |

**Lưu ý quan trọng:** trên máy chủ Linux, nếu không cấu hình, Docker dùng driver `json-file` và
**không rotate**, log sẽ lớn mãi tới khi đầy đĩa. Luôn đặt một trong các cấu hình trên.

Rotate chỉ giữ một lượng log gần đây (ví dụ 50 MB × 20 = 1 GB mỗi container). Muốn giữ lâu và tìm
kiếm được, đẩy log về hệ thống log tập trung, ví dụ:
- Grafana Loki + Promtail / Grafana Alloy đọc log container Docker;
- ELK / OpenSearch, Graylog: dùng logging driver `gelf` hoặc `fluentd` của Docker, hoặc Filebeat;
- SIEM của công ty qua `syslog`.

Log đã là JSON (có `level`, `time`, `component`, `runId`, `msg`) nên các hệ thống trên tách trường
được ngay, không cần cấu hình parse. Nhật ký truy cập (ai xem key) nằm trong database chứ không phải
log này, và có hạn lưu trữ riêng ở Quản trị > Lưu trữ.

Truy vết một máy hoặc một key: lọc theo `"name":"HN-LT-0231"`, `"objectGuid":"..."` hoặc `"keyId":"..."`.
Ở production, log là stdout của container (hoặc của `npm start`); nên đẩy về hệ thống log tập trung để
giữ lâu dài và tìm kiếm.

---

### 6.11. Trang Báo cáo

Dành cho Trưởng IT, Admin HQ và Auditor, trong phạm vi chi nhánh của người xem. Chọn **kỳ báo cáo**
(mặc định 30 ngày gần nhất, tối đa 366 ngày, có nút nhanh 7 / 30 / 90 ngày), hoặc tích **Toàn bộ thời gian**
(nút nhanh **Toàn bộ**: từ ngày đầu tiên có dữ liệu đến hôm nay, không giới hạn 366 ngày, bỏ qua ô ngày); có thể
chọn một chi nhánh. Nút **Xuất Excel** xuất đúng kỳ đang xem, kể cả Toàn bộ thời gian.
Số máy, số key là số **hiện tại**; máy mới, key mới, máy rời AD và lượt hiện key tính **trong kỳ**.

| Phần | Nội dung |
| --- | --- |
| Tổng quan | Số chi nhánh, máy trong AD, % máy có key, số key, máy/key mới và máy rời AD trong kỳ, lượt hiện key (số người, số máy, số lượt ngoài giờ) |
| Chi tiết theo chi nhánh | Mỗi chi nhánh: máy, có key, chưa có key, % có key (dưới 90% được tô màu), số key, máy mới, key mới, rời AD; dòng tổng |
| Xem key theo chi nhánh | Mỗi chi nhánh: lượt hiện key, số người xem, số máy được xem, ngoài giờ, xuất kèm file, lý do nhiều nhất; bên dưới là bảng người xem key theo chi nhánh |
| Máy chưa có key | Máy còn trong AD chưa lưu key (trạng thái hiện tại, không theo kỳ). **Tất cả chi nhánh**: chỉ bảng tổng quan theo chi nhánh (chưa có key, lâu hơn 7 ngày, mới ≤ 7 ngày, link **Xem danh sách** sang trang Tìm máy), xếp chi nhánh nhiều máy lâu chưa có key lên đầu. **Một chi nhánh** (hoặc người xem chỉ có một chi nhánh): danh sách từng máy, máy lâu nhất lên đầu, cột số ngày chưa có key, nhãn "mới". Máy mới ghi nhận ≤ 7 ngày có thể vẫn đang chờ GPO. File Excel theo cùng quy tắc: tất cả chi nhánh thì sheet "Máy chưa có key" chỉ là bảng tổng hợp theo chi nhánh; một chi nhánh thì có danh sách từng máy |

"Ngoài giờ" chỉ được tính khi đã cấu hình giờ làm việc (cảnh báo xem key ngoài giờ).

Nút **Xuất Excel** tải file `.xlsx` theo đúng kỳ và chi nhánh đang chọn, gồm 5 sheet: *Tổng quan*,
*Theo chi nhánh*, *Xem key theo CN* (thêm một cột cho mỗi lý do), *Người xem key*, *Máy chưa có key*.
Mỗi sheet có dòng tiêu đề cố định và bộ lọc; ngày giờ theo `APP_TZ`. File **không bao giờ chứa
recovery key**. Mỗi lần xuất ghi một dòng `export_report` vào nhật ký.

### 6.12. Định danh máy và key, các tình huống thường gặp

Hệ thống **không định danh theo tên**:

| Đối tượng | Định danh | Ghi chú |
| --- | --- | --- |
| Máy | `objectGUID` do AD cấp | Duy nhất, không đổi khi đổi tên hay chuyển OU, không bao giờ cấp lại. Hiện ở trang chi tiết máy, dưới tên máy trong danh sách, trong CSV; dán GUID vào ô Tìm máy để tìm đúng máy |
| Key | Key ID (`msFVE-RecoveryGuid`) | 8 ký tự đầu là số hiện trên màn hình recovery |
| Key thuộc máy nào | `objectGUID` của máy cha (worker gửi kèm mỗi key) | Chỉ khi thiếu GUID mới dò theo DN, và ưu tiên máy còn trong AD, mới thấy gần nhất |

**Không bao giờ xóa** máy hay key: tài khoản ứng dụng trong DB không có quyền DELETE trên hai bảng này. Máy
không còn trong AD chỉ đổi trạng thái thành "Không còn trong AD"; xóa chi nhánh chỉ chuyển máy về N/A.

| Tình huống | Hệ thống làm gì |
| --- | --- |
| **Máy đổi tên** (hoặc chuyển OU) | Cùng `objectGUID` nên vẫn là **một máy**: cập nhật tên, DN, chi nhánh (đổi chi nhánh thì ghi nhật ký `computer_moved`). Giữ nguyên key, lịch sử hiện key, serial / email người dùng đã nhập. Không coi là máy mới, không gửi email máy mới. Tìm theo tên cũ sẽ không ra; tìm theo GUID hoặc Key ID vẫn ra |
| **Máy bị xóa khỏi AD rồi cài lại, join lại cùng tên** | AD tạo **object mới, GUID mới**, nên hệ thống tạo **máy mới** (có thể gửi email "máy mới"). Máy cũ ở lượt full kế tiếp chuyển sang "Không còn trong AD", **giữ nguyên các key cũ** (vẫn hiện được, ví dụ khi cần mở ổ của ảnh đĩa cũ). Key mới gắn vào máy mới theo GUID. Tìm theo tên sẽ thấy cả hai, máy còn trong AD đứng trước. Serial / email người dùng của máy cũ không tự chép sang máy mới |
| Máy cài lại nhưng admin **"Reset account"** thay vì xóa | Vẫn là object cũ, cùng GUID, nên vẫn là máy cũ; key mới thêm vào cùng máy |
| **Key mới cho cùng một ổ đĩa** (cùng `msFVE-VolumeGuid`) | Thêm key mới (không ghi đè). Key mới thành **Đang dùng**, key cũ của ổ đó thành **Có key mới hơn**; key cũ và mật khẩu cũ vẫn giữ. Ổ khác của máy không bị ảnh hưởng. Có thể gửi email "key mới" |
| Đẩy lại đúng key cũ (`manage-bde -adbackup` cùng protector) | Cùng Key ID nên không có gì mới: không trùng, không email |
| **Máy unjoin rồi join lại AD, sau đó đẩy lại key cũ** (ổ không mã hóa lại, Key ID không đổi) | AD tạo object mới (GUID mới) và key cũ nằm dưới object mới. Key **được chuyển sang máy mới** (không xóa, không chép thành 2 key), ghi lịch sử chuyển: **cùng tên, cùng domain** thì chuyển ngay ở lượt sync đó và máy cũ được gắn "Không còn trong AD" (AD không thể có 2 máy cùng tên); **khác tên** thì tạm ghi là Key ID trùng, lượt full kế tiếp thấy máy cũ rời AD thì chuyển key và tự đóng, không gửi mail. Trang máy cũ ghi "Key đã chuyển sang máy …", trang máy mới ghi "Key chuyển từ máy cũ …" |
| **Cùng Key ID dưới 2 máy đều còn trong AD** (ví dụ clone từ image đã bật BitLocker) | Key **giữ ở máy đang giữ**, ghi nhận Key ID trùng. Sau khi một lượt full xác nhận, gửi **1 mail** "Key ID trùng giữa 2 máy" (mỗi cặp 1 lần, không nhắc lại; không ảnh hưởng Online / Offline). Hiện ở Quản trị > Sync AD (nút **Đã xem xét** để đóng hẳn, ghi nhật ký `key_duplicate_review`) và trên trang cả hai máy. Tự đóng khi một trong hai máy rời AD |
| Cùng Key ID nhưng **mật khẩu khác** | Không chuyển, không ghi đè; ghi nhận và cảnh báo như Key ID trùng (cột Mật khẩu: khác nhau) |
| Key cũ bị xóa trong AD | Hệ thống vẫn giữ key đó (không bao giờ xóa) |

Lưu ý: khi xóa máy khỏi AD, AD xóa luôn các key của máy đó. Xóa **nhiều** máy cùng lúc làm số máy và số key
mà lượt full thấy giảm mạnh, nên lượt đó bị **giữ lại** chờ Admin HQ duyệt (mục 6.1). Đây là cơ chế an toàn,
không phải lỗi.

### 6.13. Hiện key và sao chép

Trang hiện key cho thấy 8 nhóm số và tự ẩn sau 60 giây. Nút **Sao chép key** chép cả key (kèm dấu gạch
ngang, dán thẳng vào màn hình BitLocker được). Khi key tự ẩn hoặc bấm "Ẩn key", trang cố xóa luôn clipboard;
trình duyệt có thể không cho, nên người dùng nên tự xóa (copy nội dung khác) sau khi dùng xong. Sao chép
cần HTTPS (hoặc localhost); không được thì trang chọn sẵn key để người dùng nhấn Ctrl+C. Mọi lần hiện key đã
được ghi nhật ký kèm lý do.

## 7. Xử lý sự cố

| Hiện tượng | Nguyên nhân thường gặp | Cách xử lý |
| --- | --- | --- |
| App không khởi động, log ghi `Invalid configuration` | Thiếu hoặc sai biến trong `.env` | Đọc tên biến trong log, sửa `.env` (xem mục 3.4) |
| `/healthz` trả 503 | Không kết nối được DB | Kiểm tra `DATABASE_URL`, tường lửa, `DB_SSL` |
| Đăng nhập AD báo không kết nối được máy chủ AD | Sai `LDAP_URL`, chặn cổng 636, hoặc app không tin CA của DC | Thử `openssl s_client -connect dc01.corp.local:636`, đặt `LDAP_CA_FILE` |
| Tài khoản AD "không khớp" | Tài khoản AD bị xóa rồi tạo lại | Admin bấm "Gỡ liên kết AD" cho user đó |
| Worker nhận 401 | Sai API key | So khớp `INGEST_API_KEY` với `Ingest:ApiKey` (mã hóa lại bằng `protect`) |
| Worker nhận 403 | IP worker không có trong `INGEST_ALLOWED_IPS` | Log server ghi `ingest: address not allowed` kèm IP nhìn thấy; bổ sung IP rồi khởi động lại server |
| Worker không kết nối được HTTPS (lỗi chứng chỉ) | Máy worker không tin CA, hoặc `BaseUrl` dùng IP / tên không có trong chứng chỉ | Mục 3.6: đặt `Ingest.CaFile`, dùng đúng tên |
| Key không có mật khẩu (`keysEmptyPassword` > 0) | Tài khoản worker thiếu quyền đọc `msFVE-RecoveryPassword` | Cấp quyền theo mục 4.1, chạy `check` |
| Worker Go: `ldap_tls_failed`, connection reset ở 636 | DC chưa có chứng chỉ TLS | Cấp chứng chỉ cho DC, hoặc dùng `Protocol: Ldap` (mặc định, mục 4B.2) |
| Worker Go: `x509: certificate signed by unknown authority` | Máy Linux không tin CA của DC | Đặt `Ldap.CaFile` hoặc cài CA vào kho hệ thống |
| Lượt sync bị giữ lại liên tục | Ngưỡng không hợp với thực tế, hoặc DB còn dữ liệu thử | Xem lý do trên tab Quản trị > Sync AD, chấp nhận hoặc bác bỏ |
| Máy hiện "Không còn trong AD" | Máy bị xóa khỏi AD, hoặc nằm ngoài `SearchBases` của worker | Kiểm tra AD và `SearchBases`. Máy xuất hiện lại trong AD thì nhãn tự mất |
| Lượt sync lỗi `ldap_search_base_failed` | Một OU trong `SearchBases` không tồn tại, bị đổi tên/di chuyển, hoặc tài khoản worker không có quyền đọc | Log worker ghi tên OU. Chạy `check` để xem OU nào `FAIL`, sửa `SearchBases` hoặc cấp quyền (mục 4.1) |
| Trang Tổng quan báo dữ liệu có thể đã cũ | Worker dừng, lỗi, hoặc lượt sync bị giữ lại | Xem Quản trị > Sync AD và log worker; ngưỡng ở Quản trị > Ngưỡng cảnh báo |
| Quên mật khẩu admin | | `node src/cli/users.js reset-password admin` |
| Không nhận được email | Chưa bật mail server, sai SMTP, hoặc người nhận chưa có email | Quản trị > Mail server > **Gửi thử** để xem lỗi; Quản trị > Log email xem trạng thái và lỗi từng mail; kiểm tra email của user ở Quản trị > Người dùng |
| App không khởi động, log nhắc `mail-templates.yaml` | File mẫu email hỏng hoặc thiếu mẫu | Sửa theo thông báo (tên mẫu thiếu), hoặc lấy lại file mẫu gốc trong repo (mục 6.6) |
| `/api/docs` trả 401 | Chưa đăng nhập web | Đăng nhập web trước, rồi mở lại `/api/docs` |

---

## 8. Tham chiếu

### 8.1. Biến môi trường của server

| Biến | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` bật các kiểm tra bảo mật ở mục 3.4 |
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
| `DB_SSL`, `DB_POOL_MAX` | `false`, `10` | |
| `LDAP_URL` | trống (tắt đăng nhập AD) | Danh sách DC, thử lần lượt |
| `LDAP_DOMAIN`, `LDAP_BASE_DN` | | Bắt buộc khi có `LDAP_URL` |
| `LDAP_CA_FILE`, `LDAP_TIMEOUT_MS` | , `8000` | |
| `LOCAL_LOGIN_ENABLED` | `true` | Cho phép đăng nhập bằng tài khoản local |
| `SESSION_SECRET` | | 32 ký tự trở lên |
| `SESSION_IDLE_MINUTES`, `SESSION_MAX_HOURS` | `15`, `8` | Thời gian chờ và thời gian tối đa của phiên (mặc định; Admin HQ đổi được ở Quản trị > Bảo mật) |
| `COOKIE_SECURE` | bật trong production | |
| `LOG_HMAC_KEY` | | 64 ký tự hex |
| `BACKUP_DIR` | `backups` | Thư mục ghi file sao lưu (mục 6.8) |
| `BACKUP_DATABASE_URL` | | Tài khoản chỉ đọc `blk_backup` cho `pg_dump`; bỏ trống thì không sao lưu database |
| `PG_DUMP_PATH` | `pg_dump` | Đường dẫn `pg_dump` bản 17 (khi chạy ngoài Docker) |
| `SMTP_URL`, `NOTIFY_FROM`, `NOTIFY_TO`, `TEAMS_WEBHOOK_URL` | | SMTP dự phòng khi chưa cấu hình mail server trong Quản trị; địa chỉ luôn nhận cảnh báo; Teams webhook |
| `MAIL_TEMPLATES_FILE` | `server/templates/mail-templates.yaml` | File mẫu email (mục 6.6) |
| `JOBS_ENABLED`, `APP_TZ` | `true`, `Asia/Ho_Chi_Minh` | Job nền và múi giờ |
| `LOG_LEVEL` | `info` | |

### 8.2. API cho người dùng

**Tài liệu Swagger:** `https://<server>/api/docs` (dev: https://localhost/api/docs). Mở sau khi
đã đăng nhập web; trang dùng luôn phiên đăng nhập đó.
- Muốn thử các lệnh POST/PUT/DELETE trong "Try it out": gọi `GET /api/me`, chép `csrfToken`, bấm
  **Authorize** và dán vào ô `csrfHeader`.
- Spec gốc: `/api/docs/openapi.yaml` hoặc `/api/docs/openapi.json` (file
  `server/openapi/app.openapi.yaml`). Mỗi thao tác có `operationId`, dùng được để sinh client.
- Có test đối chiếu: mọi route trong code phải có trong spec và ngược lại, nên thêm API mới mà quên
  cập nhật spec thì test báo lỗi.

Đăng nhập bằng `POST /api/auth/login` để nhận cookie phiên. Các request POST/PUT/DELETE phải kèm
header `X-CSRF-Token` (lấy từ `GET /api/me`). Lỗi trả về dạng
`{ "error": "<mã>", "message": "<tiếng Anh>" }`.

#### Gọi API của app từ script

API của app dùng **cùng cách đăng nhập với web**: không có API key riêng. Script phải đăng nhập, giữ
cookie phiên rồi gửi kèm ở mỗi request. Các bước:

1. **Chọn tài khoản.** Nên tạo một tài khoản riêng cho script (Quản trị > Người dùng), chỉ cấp vai trò
   và chi nhánh cần thiết, ví dụ `auditor` để đọc nhật ký/báo cáo. Tài khoản AD hay local đều dùng được.
   Không dùng tài khoản `admin` cá nhân cho script.
2. **Đăng nhập**: `POST /api/auth/login` với `{ "username": "...", "password": "..." }`. Server trả cookie
   `blk.sid` và `csrfToken` trong body. Tài khoản local mới tạo phải đổi mật khẩu trước
   (`mustChangePassword: true`, gọi `POST /api/auth/change-password`).
3. **Gọi API** kèm cookie. Với POST/PUT/DELETE thêm header `X-CSRF-Token: <csrfToken>` và
   `Content-Type: application/json` (thiếu thì nhận 403 `csrf_failed` hoặc 415 `json_required`).
4. **Đăng xuất** khi xong: `POST /api/auth/logout`.

Lưu ý:

- Phiên hết hạn sau số phút không dùng và thời gian tối đa ở Quản trị > Bảo mật (mặc định `SESSION_IDLE_MINUTES`
  15 phút, `SESSION_MAX_HOURS` 8 giờ). Nhận 401 thì đăng nhập lại. Tài khoản bật xác thực 2 bước cần thêm bước
  `POST /api/auth/2fa` (mục 6.14).
- Cookie có cờ `Secure` ở production, nên phải gọi qua **HTTPS** (qua reverse proxy).
- Đăng nhập sai nhiều lần sẽ khóa tài khoản tạm thời, như trên web.
- Mọi thao tác qua API được ghi nhật ký như trên web: hiện key, xuất CSV, xuất Excel, thay đổi quản trị.
  Hiện key qua API vẫn bắt chọn lý do.
- Không lưu mật khẩu trong script: đọc từ biến môi trường hoặc kho bí mật.

Ví dụ với `curl` (Linux, macOS, Git Bash). File `cookies.txt` giữ cookie phiên:

```bash
BASE=https://blk.corp.local
# 1. Đăng nhập, lấy csrfToken (mật khẩu lấy từ biến môi trường BLK_PASSWORD)
CSRF=$(curl -s -c cookies.txt -H 'Content-Type: application/json' \
  -d "{\"username\":\"svc-report\",\"password\":\"$BLK_PASSWORD\"}" \
  "$BASE/api/auth/login" | jq -r .csrfToken)

# 2. Đọc (GET không cần CSRF)
curl -s -b cookies.txt "$BASE/api/computers?q=HN-LT" | jq '.rows[] | {name, branch_code}'
curl -s -b cookies.txt "$BASE/api/reports/summary?from=2026-10-01&to=2026-10-31" | jq .totals

# 3. Tải báo cáo Excel
curl -s -b cookies.txt -o bao-cao.xlsx "$BASE/api/reports/summary?from=2026-10-01&to=2026-10-31&format=xlsx"

# 4. Ghi (cần X-CSRF-Token), ví dụ cập nhật serial / email của máy 42
curl -s -b cookies.txt -X PUT -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
  -d '{"deviceSerial":"5CG1234XYZ","ownerEmail":"nguyenvana@corp.local"}' \
  "$BASE/api/computers/42/info"

# 5. Đăng xuất
curl -s -b cookies.txt -X POST -H "X-CSRF-Token: $CSRF" "$BASE/api/auth/logout"
```

Ví dụ với PowerShell (`WebSession` tự giữ cookie):

```powershell
$base = 'https://blk.corp.local'
$cred = Get-Credential   # nhập tài khoản của script
$body = @{ username = $cred.UserName; password = $cred.GetNetworkCredential().Password } | ConvertTo-Json
$login = Invoke-RestMethod "$base/api/auth/login" -Method Post -Body $body -ContentType 'application/json' -SessionVariable s
$h = @{ 'X-CSRF-Token' = $login.csrfToken }

# Đọc
(Invoke-RestMethod "$base/api/dashboard" -WebSession $s).totals
Invoke-WebRequest "$base/api/audit?action=reveal&format=csv" -WebSession $s -OutFile reveal.csv

# Ghi
$info = @{ deviceSerial = '5CG1234XYZ'; ownerEmail = 'nguyenvana@corp.local' } | ConvertTo-Json
Invoke-RestMethod "$base/api/computers/42/info" -Method Put -WebSession $s -Headers $h -ContentType 'application/json' -Body $info

Invoke-RestMethod "$base/api/auth/logout" -Method Post -WebSession $s -Headers $h
```

Dev: `BASE=https://localhost`. Chứng chỉ tự ký: curl thêm `--cacert cert/ca.crt` (curl dùng OpenSSL) hoặc `-k`
(chỉ dev); PowerShell 7 thêm `-SkipCertificateCheck`.

| Method | Path | Ai dùng được |
| --- | --- | --- |
| POST | `/api/auth/login`, `/api/auth/logout`, `/api/auth/change-password` | mọi người |
| GET | `/api/me`, `/api/dashboard` | đã đăng nhập |
| GET | `/api/computers?q=&page=&branchId=&status=&includeDeleted=&dateField=&from=&to=` (`branchId=na`: máy N/A; `dateField=seen` (mặc định) hoặc `ad`, `from`/`to` dạng YYYY-MM-DD), `/api/computers/:id`, `/api/keys/search?keyId=` | it, lead, admin |
| GET | `/api/computers?format=csv&` + cùng bộ lọc: xuất CSV danh sách máy (không có key) | it, lead, admin |
| PUT | `/api/computers/:id/info` `{deviceSerial, ownerEmail}`: thông tin bổ sung của máy | it, lead, admin (trong phạm vi) |
| POST | `/api/keys/export` `{branchId?, status?, includeDeleted?, dateField?, from?, to?, reason, reasonNote?, ticketNo?}`: CSV kèm recovery password | theo tab Tính năng |
| GET | `/api/keys/reveal-options`; POST `/api/keys/:keyId/reveal` `{reason, reasonNote?, ticketNo?}` | it, lead, admin |
| GET | `/api/audit?branchId&user&action&computer&from&to&page[&format=csv]` | lead (chi nhánh mình), admin, auditor |
| GET | `/api/reports/summary?from=&to=&branchId=` (JSON; `&format=xlsx`: file Excel, ghi `export_report`), `/api/reports/no-key`, `/api/reports/reveals?days=` | lead, admin, auditor |
| * | `/api/admin/branches` (DELETE `/api/admin/branches/:id` `{confirmCode}`, GET `/:id/delete-preview`), `/api/admin/users`, `/api/admin/sync`, `/api/admin/sync-runs` | admin |
| GET | `/api/admin/settings` (mail server, thông báo, tính năng; mật khẩu SMTP không bao giờ trả về), `/api/admin/settings/thresholds` | admin |
| PUT | `/api/admin/settings/mail-server`, `/notifications`, `/features`, `/thresholds`, `/retention`; POST `/settings/mail-server/test` `{to}`, `/settings/retention/run` | admin |
| GET | `/api/admin/mail?status=&q=&page=`, `/api/admin/mail/:id`; POST `/api/admin/mail/:id/retry` | admin |

### 8.3. Ingest API (cho worker)

Đặc tả OpenAPI ở `server/openapi/ingest.openapi.yaml`, Swagger UI ở `https://<server>:8443/docs`.

Ingest API là API **riêng cho sync worker**, chạy trên cổng riêng (`INGEST_PORT`, mặc định 8443).
API này không có phiên đăng nhập và không có endpoint nào trả key ra. Bình thường bạn **không cần gọi
tay**: worker tự gọi. Chỉ gọi tay khi kiểm tra kết nối, hoặc khi viết một nguồn dữ liệu khác thay
worker .NET.

| Method | Path | Việc |
| --- | --- | --- |
| GET | `/api/ingest/sync-runs/last` | Lượt gần nhất (để worker chọn delta hay full) |
| POST | `/api/ingest/sync-runs` | Mở lượt sync |
| POST | `/api/ingest/computers` | Gửi một lô máy |
| POST | `/api/ingest/keys` | Gửi một lô key (kèm `volumeGuid`) |
| POST | `/api/ingest/sync-runs/:id/complete` | Kết thúc lượt; server kiểm tra bất thường |
| POST | `/api/ingest/heartbeat` | Báo worker còn sống; nhận yêu cầu sync thủ công |

#### Xác thực khi gọi ingest API

Worker được kiểm tra bằng **ba lớp**, cả ba đều bắt buộc trên production:

| Lớp | Cấu hình | Bên gọi phải | Lỗi khi sai |
| --- | --- | --- | --- |
| HTTPS | nginx (cổng 8443, mục 3.6) | Gọi `https://`, tin chứng chỉ server | Lỗi TLS; gọi `http://` vào 8443 nhận 400 |
| IP được phép | `INGEST_ALLOWED_IPS` (IP nginx ghi vào `X-Forwarded-For`, client không giả được) | Gọi từ đúng IP trong danh sách | 403 `forbidden` |
| API key | `INGEST_API_KEY` | Header `Authorization: Bearer <INGEST_API_KEY>` | 401 `bad_api_key` |
Body là JSON, tối đa 2 MB, mỗi lô tối đa 500 máy hoặc 500 key.

#### Gọi thử ingest API

Kiểm tra kết nối và xác thực bằng các lệnh **chỉ đọc hoặc vô hại**: `GET /sync-runs/last` và
`POST /heartbeat`. Chạy trên máy worker (đúng IP được phép):

```bash
INGEST=https://blk.corp.local:8443/api/ingest
# API key qua HTTPS (thêm --cacert corp-ca.crt nếu máy chưa tin CA của chứng chỉ server)
curl -s -H "Authorization: Bearer $INGEST_API_KEY" "$INGEST/sync-runs/last"

# Heartbeat: worker xuất hiện ở Quản trị > Sync AD; nhận lại syncRequested (delta | full | null)
curl -s -H "Authorization: Bearer $INGEST_API_KEY" -H 'Content-Type: application/json' \
  -d '{"workerId":"TEST-CURL","version":"manual","ldapOk":true}' "$INGEST/heartbeat"
```

PowerShell trên máy worker:

```powershell
$ingest = 'https://blk.corp.local:8443/api/ingest'
$h = @{ Authorization = "Bearer $env:INGEST_API_KEY" }
Invoke-RestMethod "$ingest/sync-runs/last" -Headers $h
```

**Gửi dữ liệu thật qua ingest** (khi viết nguồn dữ liệu thay worker): làm đúng trình tự trong đặc tả,
tóm tắt như sau:

1. `POST /sync-runs` `{ "mode": "delta" | "full", "dcName": "DC01.corp.local" }`, rồi dùng `runId`, `mode`,
   `sinceUsn` mà server trả về. Server có thể đổi delta thành full.
2. `POST /computers` từng lô `{ "runId": ..., "items": [...] }`. Gửi **máy trước**.
3. `POST /keys` từng lô. Key trả về trong `orphans` thì gửi máy cha của nó rồi gửi lại key.
4. `POST /sync-runs/{runId}/complete` với số đếm và `highestUsn`. Nếu lỗi thì gửi `status: failed` kèm `errorCode`.

Cẩn thận:

- Một lượt **full** coi mọi máy không được gửi là "Không còn trong AD". Đừng chạy full thử với dữ liệu
  thiếu trên hệ thống thật. Lượt có số liệu bất thường sẽ bị giữ lại chờ Admin HQ duyệt (mục 6.1).
- Chỉ một lượt được mở tại một thời điểm (409 `run_in_progress`). Nếu worker thật đang chạy, hãy dừng
  service trước.
- Mỗi lô gửi lại được (idempotent). Lỗi 5xx hoặc lỗi mạng thì thử lại với backoff; lỗi 4xx thì sửa dữ liệu.
- Không ghi log và không lưu recovery password ở phía gọi.
- Ở dev (docker compose), ingest chạy ở `https://localhost:8443/api/ingest` (chứng chỉ tự ký, CA `cert/ca.crt`)
  và cần `Authorization: Bearer <INGEST_API_KEY>` lấy trong `server/.env`.

### 8.4. Cấu trúc code (`server/src`)

```
app.js                  app cho người dùng: file tĩnh, /healthz, /api, trang web
services.js             tạo mọi service một lần; web, API, ingest, job và CLI dùng chung
api/index.js            router /api: phiên đăng nhập, chỉ nhận JSON, CSRF header, lỗi dạng JSON
web/                    router trang web, biến dùng chung cho template, flash, dịch lỗi sang tiếng Việt (messages.js)
ingest/ingest.app.js    API cho worker trên cổng riêng (API key + lọc IP; HTTPS ở nginx)
jobs/                   lịch chạy job (mỗi job một instance nhờ advisory lock), watchdog sync, kiểm tra chuỗi hash
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
