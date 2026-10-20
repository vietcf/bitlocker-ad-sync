# Changelog

Định dạng theo [Keep a Changelog](https://keepachangelog.com/vi/1.1.0/), phiên bản theo
[Semantic Versioning](https://semver.org/lang/vi/): `MAJOR` khi thay đổi làm hỏng cách dùng hoặc cần thao tác tay
khi nâng cấp, `MINOR` khi thêm tính năng tương thích, `PATCH` khi sửa lỗi.

Mỗi bản release gắn git tag `vX.Y.Z` trên `main`; bản thử gắn `vX.Y.Z-rc.N`. Version của server nằm ở
`server/package.json` (hiện ở chân trang và trong log khi khởi động). Worker .NET và worker Go có version và
`CHANGELOG` riêng khi giao thức ingest không đổi (xem `worker-go/CHANGELOG.md`).

Nâng cấp: sao lưu DB, rồi `docker compose -f docker-compose.prod.yml up -d --build`. Migration tự chạy trước khi
server khởi động (README mục 3.7). Mục **Khi nâng cấp** của mỗi bản liệt kê việc cần làm thêm, nếu có.

## [Chưa phát hành]

## [2.10.0] - 2026-10-20

### Thêm

- Tìm máy: bộ lọc đăng nhập AD nay gồm hai ô kết hợp được, mốc thời gian và "Máy chưa có dữ liệu đăng nhập" (Không gồm / Gồm cả = HOẶC / Chỉ máy này), kèm số máy chưa có dữ liệu. Tham số `noLogon` (API, CSV, xuất kèm key); `activity=unknown` cũ vẫn dùng được; `activity` nhận N từ 1 đến 60.
- Báo cáo: mục "Hoạt động của máy" theo chi nhánh (hoạt động gần đây / không hoạt động gần đây / chưa có dữ liệu, % hoạt động) với link sang Tìm máy; Excel có thêm các cột đó và cột "Đăng nhập AD gần nhất" ở các sheet danh sách máy.

## [2.9.0] - 2026-10-20

### Thêm

- Quản trị > Tính năng: công tắc **tắt từng loại cảnh báo dữ liệu** (`escrow_broken`, `no_key_rising`, `full_stale`, `dc_cert_expiring`). Loại đã tắt không mở, đang mở thì đóng; ô trạng thái ghi số loại đã tắt. Sự cố hệ thống không tắt được.

### Đổi

- **Đã xử lý** ở cảnh báo dữ liệu nay có thời hạn (ngưỡng `alerts.ack_reopen_days`, mặc định 30 ngày, Quản trị > Ngưỡng cảnh báo): hết hạn mà điều kiện còn thì báo lại, tránh im lặng mãi khi tình hình xấu đi. Migration 037 tính hạn cho các cảnh báo đã xử lý trước đó.

## [2.8.0] - 2026-10-20

### Thêm

- Ngưỡng "Hoạt động gần đây" của máy cấu hình được ở Quản trị > Ngưỡng cảnh báo (mục Hoạt động của máy, mặc định 3 tháng, tối đa 60). Tooltip ở trang máy và danh sách hiển thị đúng số tháng đang cấu hình.

## [2.7.1] - 2026-10-20

### Sửa

- Trang máy và danh sách Tìm máy: rê chuột vào "Đăng nhập AD gần nhất" (nhãn, giá trị, tiêu đề cột) hiện giải thích ý nghĩa, độ lệch ~14 ngày và các nhãn hoạt động.

## [2.7.0] - 2026-10-20

### Thêm

- Đăng nhập AD gần nhất của máy (`lastLogonTimestamp`, lệch tối đa ~14 ngày, một DC là đủ): hiện ở trang máy, danh sách Tìm máy và CSV (`last_logon_utc`), kèm nhãn "Hoạt động gần đây" / "Không hoạt động gần đây" / "Chưa có dữ liệu". Bộ lọc **Hoạt động** (trong hoặc quá 1/3/6/9/12/24 tháng, hoặc chưa có dữ liệu), cũng áp dụng cho xuất CSV, xuất kèm key và API (`activity`). Trường ingest `lastLogon` tùy chọn: worker cũ vẫn chạy, giá trị đã lưu không bị xóa. Migration 036 thêm `computer.last_logon_at`.

## [2.6.1] - 2026-10-20

### Sửa

- Quản trị > Sync AD: bỏ ô ghi chú và nút ở các sự cố hệ thống (worker, LDAP...). Chỉ cảnh báo dữ liệu có **Đã xử lý** / **Bỏ qua**; API từ chối thao tác với sự cố hệ thống.

## [2.6.0] - 2026-10-20

### Thêm

- Quản trị > Sync AD: ô "Đồng bộ AD" tách hai phần, **Sự cố hệ thống** và **Cảnh báo dữ liệu** ("Có cảnh báo nhẹ"); Tổng quan hiển thị riêng hai loại.
- Cảnh báo tính từ dữ liệu (`escrow_broken`, `no_key_rising`, `full_stale`, `dc_cert_expiring`) có nút **Đã xử lý** (ghi chú, ngừng mail, không tính vào trạng thái, tự đóng khi hết, báo lại nếu tái phát) và **Bỏ qua 1/7/30 ngày**. Sự cố hệ thống (worker, LDAP...) tự hết nên không có nút nào. Ghi nhật ký `alert_ack`, `alert_snooze`. Migration 035 thêm `acked_at`, `acked_by`, `ack_note`, `snoozed_until` cho `sync_alert`.
- Báo cáo hằng ngày không liệt kê cảnh báo đã xử lý / bỏ qua.

## [2.5.0] - 2026-10-20

### Thêm

- Quản trị > Sync AD, mục Key ID trùng: hai nút xử lý. **Gán cho máy mới hơn** so ngày tạo trên AD của 2 máy và gán key cho máy tạo sau (cần mật khẩu giống nhau). **Dùng chung 2 máy** giữ key ở máy đang giữ và hiện ghi chú dùng chung ở cả 2 máy (không đổi quyền xem). Thêm cột ngày tạo trên AD và chú thích mô tả hai action; ghi nhật ký kèm kết quả. Migration 034 thêm lý do chuyển key `review_newer` và kết quả `shared`.

## [2.4.1] - 2026-10-20

### Sửa

- `tools/install.sh` thiếu `BACKUP_DATABASE_URL` nên chức năng sao lưu database báo chưa cấu hình. Nay script điền sẵn: DB trong Docker dùng tài khoản chỉ đọc `blk_backup` (có sẵn); PostgreSQL ngoài dùng `blk_backup` nếu có `BLK_BACKUP_PASSWORD`, không thì tạm dùng `blk_owner` và nhắc; có `?sslmode=require` khi bật TLS.

### Khi nâng cấp

Máy đã cài bằng `install.sh` bản cũ: chạy lại `bash install.sh --db ... --up` (giữ nguyên khóa cũ, chỉ thêm dòng còn thiếu), hoặc thêm tay `BACKUP_DATABASE_URL` vào `server/.env` (README mục 6.8) rồi `docker compose ... up -d`.

## [2.4.0] - 2026-10-19

### Thêm

- Đổi cổng ra ngoài khi cài bằng Docker Compose: `docker-compose.prod.yml` đọc `HTTPS_PORT`, `INGEST_PUBLIC_PORT`, `HTTP_PORT` (mặc định 443, 8443, 80); `tools/install.sh --https-port N --ingest-port N --http-port N` ghi vào `.env` cạnh file compose, kiểm tra `healthz` đúng cổng và in địa chỉ web, `Ingest.BaseUrl` cho worker và hướng dẫn `Ingest.CaFile` khi dùng chứng chỉ tự ký.

### Đổi

- Cổng 80 chuyển hướng sang HTTPS giữ đúng cổng HTTPS khi khác 443 (nginx đọc `nginx/redirect.conf`, do `install.sh` ghi).

### Khi nâng cấp

Không có migration. File mới `nginx/redirect.conf` được `docker-compose.prod.yml` gắn vào nginx; gói offline đã kèm file này.

## [2.3.2] - 2026-10-19

### Sửa

- Worker Go (1.1.1): thư mục trạng thái `/var/lib/blk-sync` thiếu quyền khiến mỗi lượt đều chạy full (`Could not save the state file: ... permission denied`). `install.sh` luôn tạo thư mục đúng chủ sở hữu, kể cả khi `--update`, và `--update` cập nhật unit systemd khi khác bản trong gói.

### Khi nâng cấp

Trên máy worker: build gói 1.1.1 (README mục 4B.4), chép sang rồi chạy `sudo ./install.sh --update`. Chưa muốn cập nhật: `sudo install -d -m 0750 -o blk-sync -g blk-sync /var/lib/blk-sync && sudo systemctl restart blk-sync`.

## [2.3.1] - 2026-10-19

### Sửa

- Worker cài cùng máy với Docker bị `403 ingest: address not allowed`: server thấy IP nguồn là gateway của mạng Docker (thường `172.18.0.1`). `install.sh` nay nhắc điều này khi IP worker là chính máy này, và README mục 4B.6 giải thích cách xử lý.

### Khi nâng cấp

Không có migration. Worker cùng máy với Docker: thêm gateway vào `INGEST_ALLOWED_IPS`.

## [2.3.0] - 2026-10-19

### Thêm

- `tools/install.sh`: cài production bằng Docker Compose trong một lệnh (DB trong Docker hoặc PostgreSQL ngoài). Tạo `server/.env` và `server/db.env` đúng giá trị, sinh khóa bí mật (chạy lại không đổi khóa cũ), điền chuỗi kết nối, tạo chứng chỉ tự ký tạm nếu chưa có, kiểm tra cấu hình rồi khởi động và chờ `healthz`. Có sẵn trong gói cài offline.
- Worker Go (1.1.0) chạy được trên systemd cũ như CentOS/RHEL 7: `install.sh` tự cài `deploy/blk-sync-legacy.service`; binary tĩnh nên máy đích không cần cài thư viện (đã thử trên CentOS 7.9).

### Đổi

- `docker-compose.prod.yml`: cài đặt riêng của Docker (`NODE_ENV`, `USER_HOST`, `INGEST_HOST`, cổng, cờ proxy, `COOKIE_SECURE`, `BACKUP_DIR`) nằm trong compose và ghi đè `server/.env`, nên `.env` sai cũng không còn gây lỗi 502.
- README mục 3: cách A và B rút gọn thành các bước dùng `install.sh`; mục 4B: build một lần chạy mọi nơi, hỗ trợ CentOS 7.

### Khi nâng cấp

Không có migration. Hệ thống đang chạy bằng Docker Compose: `docker compose -f docker-compose.prod.yml up -d --build` (thêm `--profile db` nếu DB trong Docker); `server/.env` cũ vẫn dùng được.

## [2.2.1] - 2026-10-19

### Sửa

- `cert/generate-self-signed.sh` chạy được trên OpenSSL cũ (1.0.2 của CentOS/RHEL 7): không còn dùng `-addext` và `x509 -ext`.
- README mục 3 (cài production, cách A, B, C): các bước điền `server/.env` viết lại bằng lệnh `set_env` (đổi giá trị nếu dòng đã có, thêm nếu chưa), tránh trùng dòng với `.env.example`. Sửa thiếu sót khiến cài bằng Docker Compose bị lỗi 502: `.env.example` đặt `USER_HOST` và `INGEST_HOST` là `127.0.0.1` nên nginx không nối được tới app; hướng dẫn nay đặt `0.0.0.0`.

### Khi nâng cấp

Không có migration. Hệ thống đã cài bằng Docker Compose theo README bản cũ mà gặp lỗi 502: trong `server/.env` đặt `USER_HOST=0.0.0.0` và `INGEST_HOST=0.0.0.0`, rồi `docker compose -f docker-compose.prod.yml up -d` (thêm `--profile db` nếu DB trong Docker).

## [2.2.0] - 2026-10-19

### Thêm

- Worker (cả bản .NET và Go, lên 1.1.0): tùy chọn `Ldap:ExcludeOperatingSystems` bỏ qua máy theo hệ điều hành, ví dụ `["Windows Server*"]`, cùng key của chúng. Mặc định rỗng nên không đổi hành vi. README mục 4.4.

### Khi nâng cấp

Không có migration và không đổi `.env`. Cập nhật worker lên 1.1.0 nếu muốn dùng tùy chọn mới; bật tùy chọn trên hệ thống đã chạy thì lượt full kế tiếp coi các Server đã đồng bộ là "ngoài phạm vi" và có thể bị giữ lại chờ duyệt.

## [2.1.0] - 2026-10-19

### Thêm

- Cài trên máy chủ không có internet: `tools/build-offline.sh` đóng gói image Docker (app, nginx, PostgreSQL) cùng file cấu hình thành một file `.tar.gz` kèm SHA-256; trên máy chủ chạy `load.sh` rồi `docker compose up -d --no-build`. README mục 3.7.

### Đổi

- `docker-compose.prod.yml`: image app có tên cố định `blk-server:${BLK_VERSION:-latest}` (trước đây Compose tự đặt tên theo thư mục và build hai lần cho `server` và `migrate`).

### Khi nâng cấp

Không có migration và không đổi `.env`. Lần đầu build lại sẽ có image mới tên `blk-server`; image cũ theo tên thư mục không còn dùng, xóa bằng `docker image prune` nếu cần.

## [2.0.2] - 2026-10-19

### Đổi

- DB trong Docker (`--profile db`): bốn mật khẩu tạo database chuyển sang file riêng `server/db.env` (mẫu `server/db.env.example`), chỉ container database đọc. App không còn thấy mật khẩu superuser `postgres` trong biến môi trường. Lệnh chạy không cần `--env-file server/.env` nữa.

### Khi nâng cấp

Chỉ cần với cách cài **DB trong Docker**: chuyển bốn dòng `POSTGRES_PASSWORD`, `BLK_OWNER_PASSWORD`, `APP_NODE_PASSWORD`, `BLK_BACKUP_PASSWORD` khỏi `server/.env` sang `server/db.env` (hoặc xóa chúng, vì database đã khởi tạo xong), rồi chạy `docker compose -f docker-compose.prod.yml --profile db up -d --build`. DB ngoài không cần làm gì.

## [2.0.1] - 2026-10-19

### Sửa

- `docker-compose.prod.yml` với DB trong Docker (`--profile db`): `migrate` đợi database sẵn sàng trước khi chạy, trước đây lần cài đầu có thể lỗi vì database chưa kịp khởi động.

### Đổi

- README mục 3 (cài production) viết lại theo từng trường hợp, mỗi cách tự đủ từng bước: A Compose + DB ngoài, B Compose + DB trong Docker, C không Docker. Bỏ hướng dẫn `docker run`. Lệnh tự sinh và điền các khóa bí mật vào `.env`.

### Khi nâng cấp

Không có migration và không đổi `.env`.

## [2.0.0] - 2026-10-19

### Bỏ

- **Chuỗi hash của nhật ký truy cập** và mọi thứ đi kèm: kiểm tra hằng ngày, cảnh báo "chuỗi hash nhật ký gãy", ô giờ kiểm tra ở
  Quản trị > Bảo mật, lệnh `audit.js`. Nhật ký vẫn chỉ thêm (trigger chặn sửa và xóa; xóa theo hạn lưu trữ qua hàm riêng), chỉ
  không còn ký HMAC từng dòng.

### Đổi

- Khóa `LOG_HMAC_KEY` đổi tên `SECRET_KEY` (tên cũ vẫn nhận). Khóa chỉ còn dùng mã hóa mật khẩu SMTP, mật khẩu sao lưu và khóa 2 bước.
- Khôi phục database không còn nhắc tới khóa: các mật khẩu không đọc được bị xóa để nhập lại sau khi vào.

### Khi nâng cấp

- Migration 033 xóa cột `prev_hash`, `hash` của `access_log` và `last_hash` của `access_log_purge` (không hoàn tác được; sao lưu DB trước).
- `server/.env`: đổi `LOG_HMAC_KEY` thành `SECRET_KEY` cùng giá trị (không bắt buộc, tên cũ vẫn chạy). Giữ nguyên giá trị để
  các mật khẩu đã lưu vẫn đọc được.

## [1.1.0] - 2026-10-18

### Thêm

- Khôi phục database một lệnh: `node src/cli/restore.js <file.zip>` (kiểm tra mật khẩu và SHA-256, nạp dữ liệu, chạy migration, báo
  nhật ký và các bí mật không đọc được). Tùy chọn `--force`, `--new-log-key`, `--reset-2fa`, `--reset-admin`. Không cần `LOG_HMAC_KEY`
  cũ để app chạy.
- `node src/cli/audit.js verify | reanchor --yes`: kiểm tra chuỗi hash nhật ký và đặt mốc mới sau khi đổi khóa (bỏ ở 2.0.0).

### Khi nâng cấp

Không có migration mới và không đổi `.env`.

## [1.0.0] - 2026-10-18

Bản phát hành đầu tiên.

### Giới hạn đã biết

Sẽ xử lý ở các bản sau: giới hạn số lần thử đăng nhập theo IP (hiện chỉ khóa theo tài khoản), hủy các phiên cũ khi đổi
hoặc reset mật khẩu, recovery key lưu rõ trong database (bảo vệ bằng quyền truy cập và sao lưu mã hóa), đăng nhập AD
mới được kiểm thử trên mô phỏng và kết nối thử, chưa qua một đợt thử lâu trên AD sản xuất.

### Thêm

- Quản lý người dùng:
  - Admin gốc (superadmin): chỉ admin gốc đổi được cấu hình của chính nó; nhãn "Superadmin" trong danh sách.
  - CLI cho mọi tài khoản: `reset-password`, `unlock`, `disable-2fa`, `reset-2fa`, `enable`.
  - Xóa người dùng khi nhật ký chưa có dòng nào của họ; có thì chỉ vô hiệu hóa.
  - Họ tên và email của tài khoản AD để trống thì tự lấy từ AD ở lần đăng nhập đầu (không bao giờ ghi đè).
  - Quy tắc vai trò: Admin HQ đứng một mình, mỗi chi nhánh một vai trò.
  - API chỉ nhận tài khoản local (`403 api_requires_local` với tài khoản AD).
- Đăng nhập AD: cấu hình `LDAP_SERVERS` (danh sách DC) và `LDAP_PROTOCOL` (`ldap` mặc định, `starttls`, `ldaps`).
- Cảnh báo hệ thống chia 4 nhóm, mỗi nhóm bật tắt và chọn người nhận riêng: Agent, AD, Key, Sao lưu.
- Báo cáo: tab Excel "Máy rời phạm vi", bộ lọc tự áp dụng, nút nhanh 7/30/90 ngày/Toàn bộ được tô nổi.
- Bộ lọc thống nhất ở Máy, Báo cáo, Nhật ký truy cập, Log email (tự áp dụng, có Lọc và Xóa lọc); lọc tình trạng
  "Đã có key".
- Nhãn "Máy ngoài phạm vi" ở key và máy; tooltip giải thích nhãn và nút "Gỡ liên kết AD".
- Sao lưu: chạy nền, ghi thẳng ra file (không giữ cả bản sao lưu trong RAM), ô mật khẩu chỉ nhập được khi tích "Mã hóa".
- `docker-compose.prod.yml`: chạy production, DB trong Docker hoặc DB ngoài.
- Version hiển thị ở chân trang và log khởi động; file này.

### Đổi

- README tách cài đặt dev và production, viết gọn lại.
- Bộ kiểm tra quyền chạy qua mọi API và trang theo vai trò (`permission-matrix.test.js`).

### Sửa

- Lượt sync bị treo khi worker sập: tự giải phóng sau 30 phút im lặng.
- `finished_at` của lượt sync không bị ghi đè khi chấp nhận lượt bị giữ lại.
- Hai admin cùng hạ quyền nhau không còn để lại 0 admin.
- Chuỗi hash nhật ký, lọc "Đến ngày", lỗi 500 với ngày không hợp lệ hoặc ký tự NUL.
- Pool database có timeout và ghi log lỗi; migrate có khóa phiên; `rejectUnauthorized` mặc định bật.
- Chính sách CSP: bỏ `style=` nội tuyến.
- `ldap://` không còn bị bật TLS nhầm; `GET /api/computers` và `/api/keys/search` kiểm tra quyền trước khi đọc đầu vào.

### Khi nâng cấp

- Migration 029 đến 032 tự chạy (admin gốc, hoạt động lượt sync, quyền xóa user, một vai trò mỗi chi nhánh).
- `server/.env`: `LDAP_URL` đã bỏ, thay bằng `LDAP_SERVERS` và `LDAP_PROTOCOL` (ví dụ `LDAP_SERVERS=dc01.corp.local`).
- Script gọi API bằng tài khoản AD phải chuyển sang tài khoản local.

[Chưa phát hành]: https://github.com/vietcf/bitlocker-ad-sync/compare/v2.4.1...HEAD
[2.4.1]: https://github.com/vietcf/bitlocker-ad-sync/releases/tag/v2.4.1
[2.4.0]: https://github.com/vietcf/bitlocker-ad-sync/releases/tag/v2.4.0
[2.3.2]: https://github.com/vietcf/bitlocker-ad-sync/releases/tag/v2.3.2
[2.3.1]: https://github.com/vietcf/bitlocker-ad-sync/releases/tag/v2.3.1
[2.3.0]: https://github.com/vietcf/bitlocker-ad-sync/releases/tag/v2.3.0
[2.2.1]: https://github.com/vietcf/bitlocker-ad-sync/releases/tag/v2.2.1
[2.2.0]: https://github.com/vietcf/bitlocker-ad-sync/releases/tag/v2.2.0
[2.1.0]: https://github.com/vietcf/bitlocker-ad-sync/releases/tag/v2.1.0
[2.0.2]: https://github.com/vietcf/bitlocker-ad-sync/releases/tag/v2.0.2
[2.0.1]: https://github.com/vietcf/bitlocker-ad-sync/releases/tag/v2.0.1
[2.0.0]: https://github.com/vietcf/bitlocker-ad-sync/releases/tag/v2.0.0
[1.1.0]: https://github.com/vietcf/bitlocker-ad-sync/releases/tag/v1.1.0
[1.0.0]: https://github.com/vietcf/bitlocker-ad-sync/releases/tag/v1.0.0
