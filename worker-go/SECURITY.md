# Bảo mật: blk-sync (Go)

Worker đọc **recovery key BitLocker** từ AD và gửi lên server. Mất key đồng nghĩa với mất khả năng bảo vệ
dữ liệu trên ổ đĩa đã mã hóa, vì vậy các điểm dưới đây là bắt buộc trên production.

## Dữ liệu nhạy cảm đi qua worker

| Dữ liệu | Ở đâu | Bảo vệ |
| --- | --- | --- |
| Mật khẩu tài khoản đọc AD | Bí mật `Ldap.Password` | systemd credential mã hóa (`cred:`), hoặc file `0400` |
| API key của ingest | Bí mật `Ingest.ApiKey` | Như trên |
| Recovery key | Chỉ trong bộ nhớ, khi gửi lên server | Không bao giờ ghi ra file hay log; kiểu dữ liệu in ra `[REDACTED]` |
| `state.json` | `/var/lib/blk-sync` | Không có bí mật (DC, invocationId, ngày full) |

## Khuyến nghị

1. **Kết nối AD**: mặc định là `Protocol: Ldap` (389), gửi mật khẩu bind và mọi recovery key **dạng rõ**;
   worker ghi cảnh báo mỗi lần kết nối. Chỉ dùng trên mạng tin cậy: worker cùng VLAN máy chủ với DC, firewall
   chỉ mở 389 từ worker tới DC, không có port mirroring lưu payload (README mục "Dùng LDAP không mã hóa trên
   mạng tin cậy"). Khi DC có chứng chỉ, chuyển sang `Ldaps` và kiểm tra chứng chỉ (`CaFile`, không bật
   `SkipCertificateValidation`).
2. **Tài khoản đọc AD tối thiểu quyền**: chỉ quyền đọc trên các OU máy tính và thuộc tính
   `msFVE-RecoveryPassword`; không thuộc nhóm quản trị; không đăng nhập tương tác được.
3. **Ingest qua HTTPS** (nginx, cổng 8443) với **API key** dài (`openssl rand -base64 48`) và **whitelist IP**
   worker ở server (`INGEST_ALLOWED_IPS`). Kiểm tra chứng chỉ server: dùng tên đúng với chứng chỉ, `CaFile`
   khi cần; không bật `SkipCertificateValidation` trên production.
4. **Chạy bằng user riêng `blk-sync`** với unit có hardening sẵn (`deploy/blk-sync.service`):
   `ProtectSystem=strict`, `NoNewPrivileges`, không capability, chỉ mạng IP.
5. **File cấu hình**: `/etc/blk-sync` thuộc `root:blk-sync`, quyền `0750`/`0640`. Không đặt bí mật dạng
   rõ trong `config.json`; `config.json` của thư mục dev đã nằm trong `.gitignore`.
6. **Log**: worker không ghi body request/response. Khi `Logging.Level: Debug` vẫn không có key; đừng bật
   debug của thư viện ngoài nếu tự sửa code.
7. **Cập nhật**: build lại khi Go hoặc `go-ldap` có bản vá bảo mật (`go list -m -u all`, `govulncheck ./...`).

## Báo lỗi bảo mật

Báo trực tiếp cho nhóm quản trị hệ thống (không mở issue công khai), kèm phiên bản (`blk-sync version`)
và cách tái hiện.
