# Changelog

Định dạng theo [Keep a Changelog](https://keepachangelog.com/vi/1.1.0/), phiên bản theo
[Semantic Versioning](https://semver.org/lang/vi/).

## [1.1.0] - 2026-10-19

### Thêm

- Chạy được trên systemd cũ (CentOS/RHEL 7, systemd 219): `install.sh` tự nhận biết và cài `deploy/blk-sync-legacy.service` (không dùng credential mã hóa và `StateDirectory`), tạo sẵn `/var/lib/blk-sync`, bí mật dùng `file:`. Binary tĩnh nên không cần cài thư viện (đã thử chạy trên CentOS 7.9).
- Tùy chọn `Ldap.ExcludeOperatingSystems`: bỏ qua máy có `operatingSystem` khớp mẫu (ví dụ `["Windows Server*"]`) cùng key của chúng. Mặc định rỗng (đọc tất cả); máy không có thuộc tính hệ điều hành vẫn được đọc.

## [1.0.0] - 2026-10-14

### Thêm

- Sync worker bằng Go cho Linux, cùng chức năng và giao thức ingest với bản .NET (`../worker`):
  - Delta / full, chụp USN trước khi đọc, chuyển sang full khi DC bị restore (invocationId đổi) hoặc USN lùi.
  - Đọc nhiều OU (`SearchBases`) lần lượt; OU không đọc được thì dừng lượt với `ldap_search_base_failed`.
  - Gửi máy trước, key sau, theo lô; xử lý key mồ côi; giữ USN cũ khi còn key mồ côi.
  - Heartbeat, nhận yêu cầu sync từ Admin HQ; full hằng đêm lúc `FullAt`.
  - Retry với backoff (1 s, 2 s, 4 s... tối đa 5 phút) trong `RetryForMinutes`; heartbeat không retry.
  - Đóng lượt `cancelled` khi service dừng.
- Kết nối AD bằng `go-ldap`: `Ldap` (mặc định, 389, không mã hóa, cảnh báo trong log), `Ldaps`, `StartTls`; simple bind;
  `CaFile`, `SkipCertificateValidation` (lab); báo hạn chứng chỉ LDAPS của DC trong heartbeat.
- Xác thực ingest: API key qua HTTPS (+ whitelist IP ở server); `Ingest.CaFile` để tin CA của chứng chỉ server.
- Cấu hình JSON cùng tên mục với `appsettings.json` (cho phép comment), ghi đè bằng biến môi trường
  `Mục__Khóa`; bí mật dạng `cred:` (systemd credential), `file:`, `env:`.
- Lệnh `run-once [full|delta]`, `check` (từng OU: OK/FAIL, mã thoát 0/3/4), `version`.
- Unit systemd có hardening, script `install.sh` (cài mới / `--update` có tự quay lại bản cũ), `Makefile`,
  script thử với AD lab trên Windows (`scripts/lab-test.ps1`).
- Test đơn vị port từ bản .NET: GUID nhị phân, thời gian AD, DN, SearchBases, cấu hình, client ingest,
  một lượt sync, lịch chạy.
