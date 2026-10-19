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

[Chưa phát hành]: https://github.com/vietcf/bitlocker-ad-sync/compare/v2.2.0...HEAD
[2.2.0]: https://github.com/vietcf/bitlocker-ad-sync/releases/tag/v2.2.0
[2.1.0]: https://github.com/vietcf/bitlocker-ad-sync/releases/tag/v2.1.0
[2.0.2]: https://github.com/vietcf/bitlocker-ad-sync/releases/tag/v2.0.2
[2.0.1]: https://github.com/vietcf/bitlocker-ad-sync/releases/tag/v2.0.1
[2.0.0]: https://github.com/vietcf/bitlocker-ad-sync/releases/tag/v2.0.0
[1.1.0]: https://github.com/vietcf/bitlocker-ad-sync/releases/tag/v1.1.0
[1.0.0]: https://github.com/vietcf/bitlocker-ad-sync/releases/tag/v1.0.0
