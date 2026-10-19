# blk-sync: sync worker viết bằng Go (Linux)

Bản Go của sync worker, dành cho máy chủ Linux. Worker đọc **máy tính** và **BitLocker recovery key** từ
Active Directory qua LDAP, rồi đẩy lên **ingest API** của server. Việc làm và giao thức giống hệt bản
.NET ở thư mục [`../worker`](../worker/README.md). Chọn **một** trong hai bản; đừng chạy cả hai cùng lúc
vì server chỉ cho mở một lượt sync tại một thời điểm.

- Một file chạy duy nhất, build tĩnh, không cần cài runtime (Go 1.26, thư viện duy nhất: `go-ldap`).
- Chạy nền bằng **systemd**, log ra stdout (journald giữ lại).
- Cấu hình cùng tên mục như `appsettings.json` của bản .NET; dùng chung file `state.json`.

## Mục lục

1. [So sánh với bản .NET](#1-so-sánh-với-bản-net)
2. [Chọn cách kết nối LDAP](#2-chọn-cách-kết-nối-ldap)
3. [Cấu trúc thư mục](#3-cấu-trúc-thư-mục)
4. [Build và test](#4-build-và-test)
5. [File cấu hình](#5-file-cấu-hình)
6. [Cài lên máy chủ Linux](#6-cài-lên-máy-chủ-linux)
7. [Cập nhật phiên bản](#7-cập-nhật-phiên-bản)
8. [Vận hành](#8-vận-hành)
9. [Xử lý sự cố](#9-xử-lý-sự-cố)

Tài liệu liên quan: [CHANGELOG.md](CHANGELOG.md) · [SECURITY.md](SECURITY.md) ·
[docs/configuration.md](docs/configuration.md) (tham chiếu đầy đủ mọi khóa cấu hình).

## 1. So sánh với bản .NET

| | Bản .NET (`worker/`) | Bản Go (`worker-go/`) |
| --- | --- | --- |
| Hệ điều hành | Windows (Windows Service) | Linux (systemd); build được cả cho Windows để thử |
| Kết nối AD | Ldaps, StartTls, Ldap | Ldap (mặc định), Ldaps, StartTls |
| Xác thực AD | Negotiate (gMSA / Kerberos / NTLM) hoặc Basic | **Chỉ Basic** (simple bind bằng user + mật khẩu) |
| LDAP thường (389) | Với Negotiate: Kerberos tự mã hóa phiên | **Không mã hóa** (chỉ dùng trên mạng tin cậy) |
| Cất bí mật | `dpapi:...` | `cred:` (systemd credential), `file:`, `env:` |
| Xác thực tới server | API key qua HTTPS | API key qua HTTPS (giống hệt) |
| Tin chứng chỉ server không có trong máy | `Ingest:CaFile` (PEM) | `Ingest.CaFile` (PEM) |
| Lệnh | `run-once`, `check`, `protect` | `run-once`, `check`, `version` (không có `protect`) |

Giống nhau hoàn toàn:
- trình tự một lượt sync: mở lượt, chụp USN trước khi đọc, gửi máy, gửi key, xử lý orphan, đóng lượt;
- chuyển delta sang full khi DC bị restore (invocationId đổi) hoặc USN lùi;
- đọc lần lượt từng OU của `SearchBases`; OU không đọc được thì dừng cả lượt với `ldap_search_base_failed`;
- tùy chọn `Ldap.ExcludeOperatingSystems` (ví dụ `["Windows Server*"]`) bỏ qua máy theo hệ điều hành, kèm key của chúng;
- retry với backoff, heartbeat, mã lỗi, đóng lượt `cancelled` khi service dừng;
- chuyển GUID nhị phân của AD (thứ tự byte như Windows; có test so khớp với bản .NET).

## 2. Chọn cách kết nối LDAP

| `Ldap.Protocol` | Cổng | Mã hóa | Cần gì trên AD |
| --- | --- | --- | --- |
| `Ldap` (**mặc định**) | 389 | **Không**: mật khẩu bind và mọi recovery key đi dạng rõ | Không cần gì |
| `Ldaps` | 636 | Có (TLS từ đầu) | DC có chứng chỉ TLS |
| `StartTls` | 389 | Có (nâng lên TLS trước khi bind) | DC có chứng chỉ TLS |

Kiểm tra DC đã có chứng chỉ chưa (từ máy worker):

```bash
openssl s_client -connect dc01.corp.local:636 </dev/null
```

Có in chứng chỉ là dùng được `Ldaps`. Bị ngắt ngay (`connection reset`) hoặc lỗi `Error initializing SSL/TLS`
khi dùng StartTls nghĩa là DC chưa có chứng chỉ:

- Domain có AD CS (Enterprise CA): DC thường tự nhận chứng chỉ "Domain Controller"; nếu chưa có, cấp lại
  từ template **Kerberos Authentication** hoặc **Domain Controller Authentication**.
- Không có AD CS: cấp chứng chỉ từ CA nội bộ khác (tên DC trong SAN, EKU *Server Authentication*), nhập vào
  kho *Personal* của máy DC. DC tự nhận chứng chỉ, không cần khởi động lại.

Máy Linux phải tin CA đó: cài CA vào kho hệ thống (`/usr/local/share/ca-certificates/` rồi
`update-ca-certificates`) hoặc trỏ `Ldap.CaFile` tới file PEM của CA. Trong cấu hình dùng **tên** DC,
không dùng IP, vì chứng chỉ cấp theo tên.

`SkipCertificateValidation: true` bỏ kiểm tra chứng chỉ: vẫn mã hóa nhưng không phát hiện được DC giả.
Chỉ dùng cho lab.

`Ldap` (mặc định, không mã hóa) chạy ngay mà không cần gì trên AD; worker ghi cảnh báo vào log mỗi lần
kết nối. Chỉ dùng khi worker và DC nằm trên mạng tin cậy (điều kiện ở mục dưới). DC bật chính sách bắt buộc
LDAP signing sẽ từ chối simple bind trên 389 (lỗi `ldap_bind_failed`, LDAP 8).

### Dùng LDAP không mã hóa trên mạng tin cậy

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

## 3. Cấu trúc thư mục

```text
worker-go/
  cmd/blk-sync/main.go        lệnh: chạy nền, run-once, check, version
  internal/config/            đọc file cấu hình (JSON có comment), biến môi trường, kiểm tra, bí mật
  internal/directory/         đọc AD bằng go-ldap (Ldaps/StartTls/Ldap), đọc file mẫu (JsonFile), GUID, DN
  internal/ingest/            client của ingest API: JSON camelCase, Bearer, retry
  internal/syncrun/           một lượt sync; file state.json
  internal/scheduler/         vòng lặp: heartbeat, delta, full hằng đêm, yêu cầu từ Admin HQ
  internal/testfakes/         AD giả và server giả cho test
  deploy/blk-sync.service     unit systemd (có hardening, systemd credentials)
  deploy/install.sh           cài mới / cập nhật (tự quay lại bản cũ nếu lỗi)
  scripts/lab-test.ps1        thử với AD lab trên Windows (hỏi mật khẩu ở dấu nhắc ẩn)
  config.example.json         mẫu cấu hình có chú thích (commit)
  config.json                 cấu hình của máy này (không commit)
  sample-directory.json       dữ liệu AD mẫu cho Source = JsonFile
  docs/configuration.md       tham chiếu mọi khóa cấu hình
```

## 4. Build và test

Cần Go 1.26 trở lên.

```bash
cd worker-go
go test ./...          # test đơn vị, port từ test của bản .NET
make linux             # dist/blk-sync: Linux amd64, build tĩnh
make linux-arm64       # dist/blk-sync-arm64
make package           # dist/blk-sync-1.1.0-linux-amd64.tar.gz: binary + script + 2 bản unit (systemd mới/cũ) + cấu hình mẫu + README
```

Không có `make` (ví dụ Windows): `go build -o bin/ ./cmd/blk-sync`, hoặc build cho Linux:

```powershell
$env:CGO_ENABLED='0'; $env:GOOS='linux'; $env:GOARCH='amd64'; go build -trimpath -ldflags "-s -w -X main.version=1.0.0" -o dist/blk-sync ./cmd/blk-sync
```

Thử với AD lab trên máy Windows (server dev đang chạy bằng docker compose):

```powershell
.\scripts\lab-test.ps1          # check + run-once delta
.\scripts\lab-test.ps1 -Full    # check + run-once full
```

Script hỏi mật khẩu AD ở dấu nhắc ẩn, lấy API key từ `server/.env`, chỉ giữ chúng trong tiến trình
PowerShell đó.

## 5. File cấu hình

Worker tìm file cấu hình theo thứ tự:

1. `--config <file>`;
2. biến môi trường `BLKSYNC_CONFIG`;
3. `config.json` ở thư mục hiện tại (khi phát triển: `worker-go/config.json`);
4. `config.json` cạnh file chạy.

| File | Commit | Dùng để |
| --- | --- | --- |
| `config.example.json` | Có | Mẫu đầy đủ mọi khóa, có chú thích, giá trị kiểu production |
| `config.json` | Không (`.gitignore`) | Cấu hình thật của máy này. Tạo bằng cách chép từ `config.example.json` |
| `/etc/blk-sync/config.json` | | Cấu hình của service trên máy chủ Linux (`install.sh` chép từ mẫu) |

File là JSON, cho phép comment `//`, `/* */` và dấu phẩy thừa, giống `appsettings.json`. Mọi khóa
ghi đè được bằng biến môi trường `Mục__Khóa` (không phân biệt hoa thường), ví dụ `Ldap__Servers=dc01,dc02`,
`Schedule__DeltaEveryMinutes=10`. Danh sách đầy đủ ở [docs/configuration.md](docs/configuration.md).

**Bí mật** (`Ldap.Password`, `Ingest.ApiKey`) không ghi thẳng vào file. Dùng một trong các dạng:

| Dạng | Đọc từ |
| --- | --- |
| `cred:ldap-password` | systemd credential (khuyến nghị: mã hóa bằng khóa của máy, TPM nếu có) |
| `file:/etc/blk-sync/ldap-password` | file chỉ user của service đọc được (`chmod 0400`) |
| `env:BLK_LDAP_PASSWORD` | biến môi trường |
| giá trị thường | chính giá trị đó (chỉ dùng khi thử nhanh) |

Giá trị `dpapi:...` của bản .NET không dùng được trên Linux.

Tối thiểu cần sửa trong `config.json`: `Ldap.Servers`, `Ldap.Protocol`, `Ldap.Username`, `Ldap.Password`,
`Ldap.BaseDn`, `Ldap.SearchBases` (nếu chỉ được đọc vài OU), `Ingest.BaseUrl`, `Ingest.ApiKey`.

### 5.1. Xác thực với server (ingest)

Worker xác thực bằng **API key qua HTTPS**, và server chỉ nhận từ **IP của máy worker**. Không có cách nào khác.

1. Lấy giá trị `INGEST_API_KEY` trong `server/.env` của server (chuỗi ngẫu nhiên, tối thiểu 32 ký tự).
2. Lưu nó làm bí mật cho worker (systemd credential `ingest-api-key`, mục 6.3) và đặt
   `"ApiKey": "cred:ingest-api-key"`.
3. Thêm IP máy worker vào `INGEST_ALLOWED_IPS` của server.
4. `BaseUrl` dùng `https://` và đúng tên trong chứng chỉ của server (ví dụ `https://blk.corp.local:8443/api/ingest`).
   Máy worker chưa tin CA đã cấp chứng chỉ đó thì đặt `CaFile` là file PEM của CA gốc
   (dev: `"CaFile": "../cert/ca.crt"`, CA tự ký của `cert/generate-self-signed.sh`).

Worker gửi key trong header `Authorization: Bearer <key>`. Server trả 401 `bad_api_key` khi sai key, 403 khi IP
không nằm trong danh sách.

Đổi key: tạo key mới (`openssl rand -base64 48`), cập nhật `INGEST_API_KEY` trên server rồi khởi động lại
server, sau đó cập nhật credential của worker và `systemctl restart blk-sync`. Giữa hai bước worker nhận
401 và tự thử lại (trong `RetryForMinutes`).

## 6. Cài lên máy chủ Linux

### 6.1. Tài khoản đọc AD

Tạo một tài khoản dịch vụ thường (ví dụ `svc-blk`; không dùng được gMSA vì bản Go chỉ có simple bind).
Cấp quyền đọc key **chỉ trong các OU máy tính** (chạy trên máy có RSAT AD, làm cho từng OU):

```powershell
dsacls "OU=Computers,DC=corp,DC=local" /I:S /G "CORP\svc-blk:RP;;msFVE-RecoveryInformation"
dsacls "OU=Computers,DC=corp,DC=local" /I:S /G "CORP\svc-blk:CA;msFVE-RecoveryPassword;msFVE-RecoveryInformation"
```

Đặt mật khẩu dài, không hết hạn hoặc có quy trình đổi định kỳ. Không dùng tài khoản cá nhân hay admin.

### 6.2. Cài

```bash
make package
scp dist/blk-sync-1.1.0-linux-amd64.tar.gz admin@sync01:/tmp/
ssh admin@sync01
mkdir /tmp/blk-sync && tar -C /tmp/blk-sync -xzf /tmp/blk-sync-1.0.0-linux-amd64.tar.gz
cd /tmp/blk-sync
sudo ./install.sh
```

Script tạo user hệ thống `blk-sync` và cài các file:
- `/opt/blk-sync/blk-sync`;
- `/etc/blk-sync/config.json` (chép từ mẫu nếu chưa có);
- unit `/etc/systemd/system/blk-sync.service`.

Script **không** tự bật service.

### 6.3. Sửa cấu hình và lưu bí mật

```bash
sudo nano /etc/blk-sync/config.json
```

Lưu bí mật thành systemd credential đã mã hóa. Bí mật được gõ ở dấu nhắc, không nằm trong lịch sử shell:

```bash
sudo sh -c 'systemd-ask-password -n "AD password:" | systemd-creds encrypt --name=ldap-password - /etc/blk-sync/ldap-password.cred'
```

```bash
sudo sh -c 'systemd-ask-password -n "Ingest API key:" | systemd-creds encrypt --name=ingest-api-key - /etc/blk-sync/ingest-api-key.cred'
```

Trong `config.json` đặt `"Password": "cred:ldap-password"` và `"ApiKey": "cred:ingest-api-key"`. Unit
`blk-sync.service` đã khai báo hai credential này (`LoadCredentialEncrypted=`). **systemd cũ** (CentOS/RHEL 7 là systemd 219, không có `systemd-creds`): `install.sh` tự cài `blk-sync-legacy.service` (không có `LoadCredentialEncrypted` và `StateDirectory`) và tạo sẵn `/var/lib/blk-sync`; bí mật để trong file `chmod 0400`, chủ sở hữu `blk-sync`, cấu hình `"Password": "file:/etc/blk-sync/ldap-password"` và `"ApiKey": "file:/etc/blk-sync/ingest-api-key"`.

Binary là bản tĩnh (`CGO_ENABLED=0`): build một lần ở máy có Go 1.26+ rồi chép sang máy chủ chạy ngay, không cần cài Go hay thư viện (đã thử chạy trên CentOS 7.9).

### 6.4. Kiểm tra rồi bật service

Chạy `check` với đúng user và credential của service:

```bash
sudo systemd-run --pty --wait -p User=blk-sync -p LoadCredentialEncrypted=ldap-password:/etc/blk-sync/ldap-password.cred -p LoadCredentialEncrypted=ingest-api-key:/etc/blk-sync/ingest-api-key.cred /opt/blk-sync/blk-sync --config /etc/blk-sync/config.json check
```

Kết quả mong đợi:

```text
LDAP OK: dc01.corp.local, highestCommittedUSN 123456, invocationId ..., LDAPS certificate expires 2027-06-30
  OK    OU=Computers,OU=HN,DC=corp,DC=local: first 5 computers, first 5 keys (0 without a readable password)
```

Mã thoát: `0` tốt; `3` không kết nối / bind được; `4` có OU không đọc được.

```bash
sudo systemctl enable --now blk-sync
```

```bash
journalctl -u blk-sync -f
```

Lần chạy đầu worker chạy một lượt **full**. Worker xuất hiện ở Quản trị > Sync AD sau heartbeat đầu tiên,
với version có đuôi `-go`.

**Chuyển từ bản .NET sang bản Go:** dừng và tắt service Windows trước (`Stop-Service BitlockerSync`,
`Set-Service BitlockerSync -StartupType Disabled`). Có thể chép `state.json` của bản .NET sang
`/var/lib/blk-sync/state.json` để giữ lịch full; không chép cũng được (chỉ tốn thêm một lượt full).

## 7. Cập nhật phiên bản

```bash
make package VERSION=1.1.0
```

Chép gói lên máy chủ, giải nén, rồi:

```bash
sudo ./install.sh --update
```

Script chạy `check` bằng bản mới; lỗi thì không thay gì. Sau đó script dừng service, thay binary (giữ
`blk-sync.previous`) và khởi động lại. Service không lên thì script tự quay lại bản cũ. Khi dừng, worker
đóng lượt đang chạy với `cancelled`, nên lần chạy sau không bị chặn `run_in_progress`.

## 8. Vận hành

| Việc | Lệnh |
| --- | --- |
| Xem log | `journalctl -u blk-sync -f` (`Logging.Format: json` nếu đẩy log sang SIEM) |
| Chạy một lượt ngay | `sudo systemctl stop blk-sync` rồi `run-once full` như mục 6.4 (thay `check`), sau đó `start` lại. Hoặc bấm yêu cầu sync ở Quản trị > Sync AD |
| Trạng thái | `systemctl status blk-sync`; trên web: Quản trị > Sync AD |
| Phiên bản | `/opt/blk-sync/blk-sync version` |

Lịch chạy giống bản .NET:
- heartbeat mỗi `HeartbeatEveryMinutes`;
- delta mỗi `DeltaEveryMinutes`;
- full mỗi ngày lúc `FullAt` (giờ địa phương của máy, theo `TZ`/`timedatectl`), và full ngay ở lần chạy đầu;
- yêu cầu sync từ Admin HQ được chạy ngay ở heartbeat kế tiếp.

## 9. Xử lý sự cố

| Hiện tượng | Nguyên nhân | Cách xử lý |
| --- | --- | --- |
| `ldap_tls_failed`, "connection reset" ở 636 hoặc `Error initializing SSL/TLS` | DC chưa có chứng chỉ TLS | Cấp chứng chỉ cho DC (mục 2), hoặc dùng `Protocol: Ldap` (mặc định) |
| `ldap_tls_failed`, `x509: certificate signed by unknown authority` | Máy Linux không tin CA của DC | Cài CA vào kho hệ thống hoặc đặt `Ldap.CaFile` |
| `ldap_tls_failed`, `certificate is valid for dc01..., not 192.168...` | Cấu hình dùng IP | Dùng tên DC trong `Ldap.Servers` |
| `ldap_bind_failed` (LDAP 49) | Sai user / mật khẩu, tài khoản bị khóa | Kiểm tra tài khoản; worker không thử DC khác để tránh khóa tài khoản |
| `ldap_bind_failed` (LDAP 8, "requires signing/TLS") | DC bắt buộc LDAP signing, từ chối simple bind trên 389 | Dùng `Ldaps` hoặc `StartTls` |
| `ldap_search_base_failed` | OU trong `SearchBases` sai tên hoặc tài khoản không có quyền | `check` cho biết OU nào `FAIL` |
| `check` báo key "without a readable password" | Thiếu quyền đọc `msFVE-RecoveryPassword` | Cấp quyền như mục 6.1 |
| Worker không khởi động: `invalid configuration` | Cấu hình sai | Đọc danh sách lỗi in ra, sửa `config.json` |
| `secret: cred: needs a systemd credential` | Chạy tay nhưng cấu hình dùng `cred:` | Chạy qua `systemd-run` như mục 6.4, hoặc tạm dùng `env:` |
| Server trả 409 `run_in_progress` | Bản .NET hoặc worker khác vẫn đang chạy | Chỉ chạy một worker |
