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

## [2.24.1] - 2026-10-23

### Đổi

- `install.sh` cài mới (chưa có `data/postgres`): nếu còn container cũ của project (cài dở, hoặc chạy cấu hình cũ) thì **dừng và xóa container** trước khi làm mới cấu hình. Không xóa volume, `data/`, `backups/`, `cert/`, không đụng project khác. Đã có database thì vẫn chỉ cảnh báo và thoát, không dừng gì.

## [2.24.0] - 2026-10-23

### Khi nâng cấp

- Từ bản này, cập nhật production dùng `bash install.sh --db docker --update --up` (không có `--update` thì script chỉ cảnh báo vì đã có database).

### Đổi

- `install.sh` chạy lại được: DB trong Docker mà đã có `data/postgres` thì **cảnh báo và thoát** (không đụng cấu hình, khóa, database); chưa có thì **xóa cấu hình cũ** (`server/.env`, `server/db.env`, `.env`, `nginx/redirect.conf`) và tạo mới toàn bộ. Thêm `--update` để cập nhật bản mới mà giữ cấu hình. DB ngoài: chạy lại vẫn giữ cấu hình như cũ.
- `INGEST_ALLOWED_IPS` không còn bắt buộc ở production: **để trống = cho mọi IP** gọi ingest API (vẫn bắt buộc HTTPS và API key). Server ghi cảnh báo khi khởi động nếu để trống. `install.sh` không còn tự đặt `127.0.0.1` khi chưa có IP worker (giá trị đó chặn mọi worker và làm server không khởi động ở một số cấu hình). Muốn giới hạn: `--worker-ips <IP>`.

## [2.23.2] - 2026-10-23

### Đổi

- Dev: nginx nghe mặc định trên `0.0.0.0` (máy khác truy cập được); `BIND_ADDR=127.0.0.1` để chỉ máy này. PostgreSQL dev vẫn chỉ `127.0.0.1`. Dev dùng tài khoản và mật khẩu mặc định, đừng mở ra mạng không tin cậy.

## [2.23.1] - 2026-10-23

### Sửa

- nginx không còn chết khi thiếu file `blk-redirect.conf` (chuyển hướng cổng 80): thiếu file thì dùng chuyển hướng mặc định sang HTTPS, nginx vẫn khởi động. Trước đó thiếu file là lỗi `[emerg] open() "/etc/nginx/blk-redirect.conf" failed`.

## [2.23.0] - 2026-10-23

### Đổi

- Database PostgreSQL lưu ở **thư mục `data/postgres`** ngay trong thư mục cài (dev và production), không còn dùng Docker volume `blk-pg`. Production bật nhãn SELinux (`:z`). Xóa sạch DB dev: `docker compose down` rồi xóa thư mục `data/`; `down -v` không còn xóa database.

### Khi nâng cấp

- Máy đã chạy bản cũ (DB trong volume `<thư-mục>_blk-pg`): **trước khi nâng cấp** chép dữ liệu sang thư mục mới, nếu không DB sẽ trống. Dừng container (`docker compose down`), rồi: `mkdir -p data/postgres && docker run --rm -v <thư-mục>_blk-pg:/from:ro -v "$PWD/data/postgres:/to" postgres:17.6 sh -c "cp -a /from/. /to/"`, rồi `docker compose up -d`. Volume cũ giữ nguyên làm bản dự phòng. Production chưa cài thì bỏ qua.

## [2.22.2] - 2026-10-23

### Đổi

- Cài dev chỉ cần **một lệnh** `docker compose up --build --watch`: dịch vụ `certs` tự tạo chứng chỉ tự ký lần đầu (không cần `bash cert/generate-self-signed.sh`). Có `DB_PORT` để đổi cổng PostgreSQL dev.

### Sửa

- Healthcheck của DB (dev và production) kiểm tra qua TCP, nên `migrate` không còn chạy trước khi khởi tạo DB xong (đôi khi lỗi ở lần cài đầu tiên).

## [2.22.1] - 2026-10-23

### Sửa

- `docker-compose.yml` (dev): nginx thiếu mount `nginx/redirect.conf`, nên tạo lại container nginx báo `open() "/etc/nginx/blk-redirect.conf" failed`. Production không bị (compose production đã có mount).

## [2.22.0] - 2026-10-23

### Thêm

- Báo cáo hằng ngày: **tỉ lệ % máy có recovery key** (toàn hệ thống, chỉ máy hoạt động gần đây) ở dòng chữ và thêm biểu đồ 10 ngày; dòng dưới biểu đồ là tăng giảm so với ngày trước, tính bằng điểm %.

## [2.21.3] - 2026-10-23

### Đổi

- Báo cáo hằng ngày: số **key** (tổng, biểu đồ, key mới, theo chi nhánh) cũng chỉ tính key của máy hoạt động gần đây, giống số máy. Mail có đúng một dòng chú thích ở cuối (đăng nhập AD trong N tháng, gồm máy chưa có dữ liệu đăng nhập).

## [2.21.2] - 2026-10-22

### Đổi

- Báo cáo hằng ngày: số máy (tổng, biểu đồ 10 ngày, máy mới, máy rời phạm vi, theo chi nhánh) chỉ tính máy **hoạt động gần đây**: có đăng nhập AD trong `computer.recent_months` tháng (cùng ngưỡng với nhãn "Hoạt động gần đây"). Máy chưa có dữ liệu đăng nhập vẫn tính. Số key không đổi.

## [2.21.1] - 2026-10-21

### Đổi

- Quản trị > Tính năng > **Hiển thị: số dòng mỗi trang** có thêm **Các lượt sync** (mặc định 50, từ 5 đến 200). Áp dụng cho bảng lượt sync và `GET /api/admin/sync-runs`.

## [2.21.0] - 2026-10-21

### Đổi

- Quản trị > Sync AD: **Các lượt sync gần đây** có phân trang (50 lượt/trang), xem được toàn bộ lịch sử còn lưu thay vì chỉ 30 lượt mới nhất. `GET /api/admin/sync-runs` nhận `?page=` và trả thêm `page, pages, total, pageSize`. "Lần sync thành công gần nhất" không phụ thuộc trang đang xem.

## [2.20.1] - 2026-10-21

### Sửa

- Key ID trùng: sau khi bấm **Gán cho máy mới hơn**, lần full scan sau **không báo lại** cặp đó nữa (trước đây máy cũ vẫn còn key trong AD nên bị ghi thành cặp trùng mới và gửi mail lần nữa). **Dùng chung 2 máy** vốn đã không báo lại.

## [2.20.0] - 2026-10-20

### Đổi

- Cảnh báo dữ liệu: **Đã xử lý** nay khác **Bỏ qua**. Đã xử lý = đã sửa nguyên nhân: **đóng cảnh báo ngay** (ghi người xử lý và ghi chú), watchdog **theo dõi lại sau 24 giờ** (ngưỡng `alerts.fix_grace_hours`, thay `alerts.ack_reopen_days`, chỉnh ở Cảnh báo sync); lúc đó điều kiện còn thì mở cảnh báo mới. Bỏ qua = giữ cảnh báo, im lặng 1/7/30 ngày.
- Tình trạng sync: rút gọn dòng giải thích ở ô Worker Offline.

## [2.19.9] - 2026-10-20

### Sửa

- Tình trạng sync: đoạn giải thích Đã xử lý / Bỏ qua chỉ hiện khi có cảnh báo dữ liệu đang chờ xử lý, và rút còn một câu (trước đây luôn hiện dài ở cuối danh sách cảnh báo).

## [2.19.8] - 2026-10-20

### Sửa

- Báo cáo: nút **Lọc** vẫn còn (chỉ bỏ các nút chọn thời gian nhanh). Hai ô **Đăng nhập AD gần nhất** và **Máy chưa có dữ liệu** là một cặp, luôn nằm cạnh nhau trên một hàng (chỉ xuống dòng khi màn hình hẹp), không còn bị tách ra hai hàng.

## [2.19.7] - 2026-10-20

### Đổi

- Báo cáo: bộ lọc chia **hai khung**: **Kỳ báo cáo** (hai ngày, Toàn bộ thời gian, Máy mới / key mới theo) và **Máy trong báo cáo** (Chi nhánh, Đăng nhập AD gần nhất, Máy chưa có dữ liệu), mỗi khung có dòng ghi áp dụng cho số liệu nào.
- Excel của báo cáo: sắp lại thứ tự cột theo nhóm. Theo chi nhánh: định danh, số hiện tại, hoạt động đăng nhập AD, số trong kỳ. Xem key theo CN: lượt hiện key, xuất file, ngoài giờ, rồi người và máy. Danh sách máy: máy, các mốc ngày theo thứ tự thời gian, thông tin key hoặc sync, DN ở cuối. Tổng quan thêm dòng trống ngăn nhóm.

## [2.19.6] - 2026-10-20

### Đổi

- Báo cáo: bỏ các nút chọn thời gian nhanh (7 / 30 / 90 ngày, Toàn bộ). Vẫn chọn kỳ bằng hai ô ngày hoặc tích **Toàn bộ thời gian**.

## [2.19.5] - 2026-10-20

### Hiệu năng

Đo trên dữ liệu cỡ production (50.000 máy, 60.000 key, 300.000 dòng nhật ký, 600 lượt sync), Admin HQ:

| Trang | Trước | Sau |
| --- | --- | --- |
| Tổng quan | 5,2 s | 0,32 s |
| Báo cáo (30 ngày) | 2,9 s | 0,51 s |
| Báo cáo (toàn bộ thời gian) | 6,3 s | 0,77 s |
| Xuất Excel báo cáo | 2,9 s | 0,68 s |
| Nhật ký, trang 1 | 414 ms | 89 ms |
| Tìm máy, danh sách | 111 ms | 34 ms |
| Lọc theo đăng nhập AD | 69 ms | 33 ms |

Nguyên nhân và cách sửa:

- **Tổng quan:** biểu đồ số máy và key theo ngày quét lại cả hai bảng 30 lần (mỗi ngày một lần). Nay gom theo ngày một lần rồi cộng dồn (số liệu giống hệt, có test so với cách tính từng ngày).
- **Báo cáo:** mỗi lượt hiện key tạo mới một bộ định dạng giờ để kiểm tra giờ làm việc (hàng chục nghìn lần); nay dùng chung một bộ cho mỗi múi giờ. Ngày đầu tiên có dữ liệu không còn nối hai bảng.
- **Phân quyền theo chi nhánh (RLS):** chính sách của `recovery_key`, `key_duplicate`, `key_owner_change` luôn dựng bảng băm của toàn bộ bảng máy cho mỗi truy vấn, kể cả Admin HQ. Thêm `app_all_branches() OR` lên đầu để Admin HQ bỏ qua; ý nghĩa phân quyền không đổi (migration 040).
- **Nhật ký và danh sách máy:** tổng số trang được đếm riêng thay vì đếm cả bảng kèm sắp xếp; trang đầu ngắn không cần đếm. Thêm chỉ mục cho thứ tự danh sách máy, ngày key đầu tiên và lọc nhật ký theo người dùng (migration 039).

## [2.19.4] - 2026-10-20

### Đổi

- Bảng "Các lượt sync gần đây": hai cột **Máy** và **Key** hiện số thay đổi có dấu: Máy `+N` (thêm vào hệ thống) `−M` (bị gắn "không còn trong phạm vi giám sát" bởi lượt đó), Key `+N`. Thay cho các cột Máy (thấy), Máy mới và Key mới.
- Trang chi tiết lượt delta: thêm **Máy hiện tại** và **Key hiện tại** cạnh số máy / key lượt đó thấy (vẫn không so với toàn hệ thống). Migration 038 thêm `sync_run.marked_not_in_ad` (các lượt cũ ghi 0).

## [2.19.3] - 2026-10-20

### Sửa

- "Gán cho máy mới hơn" bị từ chối: thông báo ngắn, nêu đúng lý do kèm tên hai máy: "A (đang giữ key) đã mới hơn B", "A và B được tạo cùng lúc trên AD", "mật khẩu của 2 máy khác nhau" hoặc "thiếu ngày tạo trên AD".
- Lượt sync **delta**: thêm cột **Máy mới** (số máy lần đầu được thêm vào hệ thống bởi lượt đó) ở bảng "Các lượt sync gần đây" (lượt full hiện "—") và trong trang chi tiết của lượt delta (toàn hệ thống và từng chi nhánh). Lượt full giữ nguyên.
- Form người dùng: ô **Admin HQ** đặt lên đầu mục Quyền (mặc định không chọn); chọn Admin HQ thì **ẩn** bảng quyền theo từng chi nhánh cho đỡ dài trang.

## [2.19.2] - 2026-10-20

### Sửa

- Key ID trùng, nút **Gán cho máy mới hơn**: khi không gán được (máy đang giữ key đã là máy mới hơn hoặc cùng thời điểm, mật khẩu 2 máy khác nhau, thiếu ngày tạo trên AD) nay quay lại trang với thông báo nêu đúng lý do bằng tiếng Việt, thay vì trang lỗi chung "Dữ liệu gửi lên không hợp lệ" (câu giải thích bị truyền sai tham số). Cũng áp dụng cho nút Đã xử lý / Bỏ qua của cảnh báo dữ liệu.

## [2.19.1] - 2026-10-20

### Sửa

- Đổi tên thư mục cài không còn làm database "biến mất": `tools/install.sh` ghi `COMPOSE_PROJECT_NAME` vào `.env` (cài mới: `blk`; máy đã cài: giữ đúng tên project đang dùng, phát hiện qua volume `<thư-mục>_blk-pg` hoặc container cũ). Trước đây volume đặt tên theo thư mục nên đổi tên thư mục là Docker tạo database trống mới (volume cũ vẫn còn). README mục 3.6 ghi cách lấy lại.

## [2.19.0] - 2026-10-20

### Thêm

- Báo cáo: ô **"Máy mới / key mới theo"** chọn tính máy mới và key mới trong kỳ theo **ngày ghi nhận trên hệ thống** (mặc định) hoặc **ngày tạo trên AD**. Áp dụng cho trang, mốc "Toàn bộ thời gian" và file Excel (ghi rõ ở sheet Tổng quan). API `/api/reports/summary` nhận `dateField` (`seen` | `ad`).

## [2.18.3] - 2026-10-20

### Thêm

- Cảnh báo sync > Kiểm tra khi lượt sync kết thúc: kiểm tra **"Có key nhưng không đọc được mật khẩu"** (mất quyền đọc thuộc tính confidential) nay có khung riêng với công tắc **Bật/Tắt** và ngưỡng chỉnh được (số key tối thiểu, mặc định 1; trước đây luôn bật và không chỉnh được).

## [2.18.2] - 2026-10-20

### Sửa

- Tình trạng sync: bỏ đoạn giải thích dưới hai dòng "Sự cố hệ thống" và "Cảnh báo dữ liệu" (sự cố hệ thống tự hết, cảnh báo dữ liệu cần xử lý, watchdog 5 phút, thông tin mail).
- Sửa test của trang cấu hình cảnh báo cho khớp việc bỏ khung giải thích ở 2.18.1.

## [2.18.1] - 2026-10-20

### Sửa

- Cảnh báo sync: bỏ khung giải thích "Cách các ngưỡng kết hợp" ở đầu trang.

## [2.18.0] - 2026-10-20

Bản phát hành gộp: không có thay đổi mới so với 2.13.2. Số phiên bản nhảy thẳng lên 2.18 (không có 2.14 đến 2.17); các mục 2.13.x và cũ hơn bên dưới là lịch sử của cùng đợt thay đổi.

## [2.13.2] - 2026-10-20

### Sửa

- Bộ lọc đăng nhập AD: gợi ý khi rê chuột vào "Máy chưa có dữ liệu" chỉ giải thích đó là máy nào (bỏ phần diễn giải từng lựa chọn).

## [2.13.1] - 2026-10-20

### Sửa

- Cảnh báo sync: khung "VÀ · phải vượt cả 2 ngưỡng" nhạt hơn (viền mảnh, nền gần như trắng, chữ ghi chú màu xám) để không nổi hơn các mục chính.

## [2.13.0] - 2026-10-20

### Thêm

- Cảnh báo sync: công tắc **Bật/Tắt** cho từng **kiểm tra khi lượt full kết thúc** (thấy quá ít máy, thấy quá ít key, chi nhánh giảm đột ngột, quá nhiều máy sắp bị gắn "không còn trong phạm vi") và cho từng **sự cố hệ thống** (worker mất kết nối, không đọc được AD, lâu không có lượt sync, lượt sync treo, canary cũ, USN đứng yên), cạnh ngưỡng riêng của nó. Tắt thì không theo dõi loại đó. Riêng kiểm tra "key đọc được nhưng mật khẩu rỗng" luôn bật. API `/api/admin/settings/thresholds` trả thêm `checks`, `alerts[].group` và nhận `check.<code>`, `alert.<type>`.

### Đổi

- Cảnh báo sync: tiêu đề các mục lớn đổi sang màu nhấn có viền riêng để phân biệt với khung con.

## [2.12.4] - 2026-10-20

### Sửa

- Sao lưu chạy ngay sau khi cài, không phải cấu hình thêm: `docker-compose.prod.yml` có dịch vụ `backups-init` tự cấp quyền ghi cho `./backups` (trước đây phải `sudo chown 1000:1000 backups` tay khi không chạy `install.sh` bằng root); `tools/install.sh` điền `BACKUP_DATABASE_URL` cho cả hai cách Docker; README cách C (không Docker) điền `BACKUP_DATABASE_URL` và coi `pg_dump` 17 là bắt buộc. Đã thử cài mới bằng `install.sh --db docker` rồi bấm Sao lưu ngay: ra đủ hai file (máy/key và database).
- Bỏ mục 3.8 "Thao tác hay dùng" khỏi README (đã có trong phần cập nhật, mục 3.7).

## [2.12.3] - 2026-10-20

### Sửa

- Tìm máy: khung "Đăng nhập AD gần nhất" nằm cùng hàng với Chi nhánh và Tình trạng, các ô chọn thẳng hàng. Báo cáo vẫn để khung ở hàng riêng.

## [2.12.2] - 2026-10-20

### Sửa

- Bộ lọc đăng nhập AD gọn hơn: hai ô cùng một dòng, nhãn nằm trên ô chọn như các ô khác, khoanh bằng một viền mờ (bỏ khung trắng cao và tiêu đề riêng). Tìm máy và Báo cáo.

## [2.12.1] - 2026-10-20

### Sửa

- Bộ lọc đăng nhập AD (Tìm máy, Báo cáo): hai ô gom vào một **khung riêng** "Đăng nhập AD gần nhất" trên một hàng riêng (nhãn ô thứ hai rút gọn thành "Máy chưa có dữ liệu"). Báo cáo: hàng 1 là kỳ báo cáo và chi nhánh, hàng 2 là khung đăng nhập AD, hết vỡ bố cục.

## [2.12.0] - 2026-10-20

### Thêm

- Báo cáo: bộ lọc **Đăng nhập AD** và **Chưa có dữ liệu đăng nhập AD** (cùng cách với Tìm máy) trên trang và trong file Excel; Excel ghi bộ lọc đang dùng ở sheet Tổng quan. API `/api/reports/summary` nhận `activity`, `noLogon`. Hai ô lọc dùng chung một partial với Tìm máy.

### Đổi

- Nhãn ô "Chưa có dữ liệu" thành **"Chưa có dữ liệu đăng nhập AD"** (một dòng, không lệch hàng), rê chuột có giải thích đầy đủ.

## [2.11.5] - 2026-10-20

### Sửa

- Tìm máy: bỏ số máy hiện cạnh ô "Chưa có dữ liệu" và rút ngắn nhãn của ô này (trước là "Máy chưa có dữ liệu đăng nhập") để bộ lọc không bị lệch hàng.

## [2.11.4] - 2026-10-20

### Sửa

- Bỏ biểu tượng ⓘ cạnh "Đăng nhập AD gần nhất"; chữ giải thích khi rê chuột nay có gạch chân chấm và con trỏ dấu hỏi.

## [2.11.3] - 2026-10-20

### Sửa

- Cảnh báo sync: ngưỡng "Cảnh báo dữ liệu đã xử lý tự báo lại sau (ngày)" có khung riêng "Chung cho mọi cảnh báo dữ liệu" ở đầu mục (trước đây nằm lửng sau cảnh báo cuối nên trông như thuộc về cảnh báo đó).

## [2.11.2] - 2026-10-20

### Sửa

- Nút gạt Bật/Tắt của cảnh báo dữ liệu không hiện (chỉ thấy chữ "Bật") do CSS của form ép nhãn thành khối và thanh trượt thành `inline`. Nay hiện đúng: Bật là xanh với núm bên phải, Tắt là xám với núm bên trái.

## [2.11.1] - 2026-10-20

### Sửa

- Cảnh báo sync: công tắc Bật/Tắt của từng cảnh báo dữ liệu nay là **nút gạt** ở bên phải tiêu đề cảnh báo (trước là ô chọn khó nhìn), hiện rõ "Bật" (xanh) / "Tắt" (xám).

## [2.11.0] - 2026-10-20

### Đổi

- Cấu hình cảnh báo sync gom về một chỗ: Quản trị > Đồng bộ AD > **Cảnh báo sync** (trước là "Ngưỡng cảnh báo"). Mỗi cảnh báo dữ liệu có công tắc **Bật/Tắt** ngay cạnh ngưỡng riêng của nó (máy mới không có key, tỉ lệ không key tăng, full sync quá hạn, chứng chỉ DC); ngưỡng "full quá hạn", "máy mới chưa có key" và "tỉ lệ không key tăng" chuyển vào đúng cảnh báo. Sự cố hệ thống đứng riêng, không có công tắc. Công tắc không còn ở Hệ thống > Tính năng. API `/api/admin/settings/thresholds` trả thêm `alerts` và nhận `alert.<type>`.
- Form "Đã xử lý" / "Bỏ qua" của cảnh báo dữ liệu: ô ghi chú một dòng riêng, các nút bên dưới có khoảng cách (trước đây các nút dính sát ô ghi chú).

## [2.10.1] - 2026-10-20

### Sửa

- Trang chi tiết lượt sync: lượt **delta** không còn so với toàn hệ thống (trước đây hiện "Máy đang có" và chênh lệch âm rất lớn gây hiểu nhầm). Delta chỉ hiện máy thấy, key thấy, key mới thêm, key không đọc được; chỉ lượt full mới so sánh với dữ liệu đang có.

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
