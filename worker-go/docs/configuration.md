# Tham chiếu cấu hình blk-sync (Go)

File JSON (cho phép comment và dấu phẩy thừa). Mẫu đầy đủ: [`../config.example.json`](../config.example.json).
Mọi khóa ghi đè được bằng biến môi trường `Mục__Khóa` (không phân biệt hoa thường). Danh sách ghi bằng
dấu phẩy, ví dụ `Ldap__SearchBases=OU=HN,DC=corp,DC=local;...` không hợp lệ, phải là
`Ldap__Servers=dc01.corp.local,dc02.corp.local`.

Đường dẫn tương đối (`StateFile`, `CaFile`, `JsonFilePath`, file chứng chỉ) tính từ thư mục chứa file cấu hình.

Bí mật (đánh dấu 🔒) nhận các dạng `cred:TÊN` (systemd credential), `file:/đường/dẫn`, `env:TÊN_BIẾN`
hoặc giá trị thường (chỉ khi thử nhanh).

## Ldap

| Khóa | Mặc định | Giá trị | Ý nghĩa |
| --- | --- | --- | --- |
| `Source` | `Ldap` | `Ldap` \| `JsonFile` | `JsonFile`: đọc `JsonFilePath` thay AD (chỉ để phát triển) |
| `Servers` | (bắt buộc) | danh sách tên DC | Thử theo thứ tự; DC đầu là DC chính. Đổi DC thì server buộc chạy full |
| `Protocol` | `Ldap` | `Ldap` \| `Ldaps` \| `StartTls` | `Ldap`: 389, không mã hóa (mạng tin cậy). `Ldaps`/`StartTls`: mã hóa, cần DC có chứng chỉ |
| `Port` | 389 / 636 | 1–65535 | 389, hoặc 636 với `Ldaps` |
| `Auth` | `Basic` | `Basic` | Simple bind. `Negotiate` (gMSA/Kerberos) chỉ có ở bản .NET |
| `Username` | (bắt buộc) | UPN, `MIỀN\user` hoặc DN | Tài khoản đọc AD |
| `Password` 🔒 | (bắt buộc) | | Mật khẩu của `Username` |
| `BaseDn` | (bắt buộc) | DN | Ví dụ `DC=corp,DC=local` |
| `SearchBases` | `[]` | danh sách DN | Rỗng = cả `BaseDn`. Đọc lần lượt; OU trùng hoặc OU con bị bỏ; phải nằm trong `BaseDn` |
| `ExcludeOperatingSystems` | `[]` | danh sách mẫu | Tùy chọn. Bỏ qua máy (và key của máy) có `operatingSystem` khớp mẫu, `*` là ký tự đại diện, không phân biệt hoa thường, ví dụ `["Windows Server*"]`. Máy không có thuộc tính này vẫn được đọc. Tối đa 50 mẫu. Biến môi trường (cách nhau dấu phẩy): `Ldap__ExcludeOperatingSystems=Windows Server*,Ubuntu*` |
| `PageSize` | 1000 | 1–1000 | Số object mỗi trang (paged search) |
| `TimeoutSeconds` | 60 | 5–600 | Thời gian chờ mỗi thao tác LDAP |
| `CaFile` | | file PEM | `Ldaps`/`StartTls`: CA đã cấp chứng chỉ cho DC, thêm vào kho hệ thống |
| `SkipCertificateValidation` | `false` | bool | `Ldaps`/`StartTls`, lab: chấp nhận mọi chứng chỉ của DC |
| `AllowInsecure` | | | Không còn dùng (bỏ qua); giữ để file cấu hình cũ vẫn đọc được |
| `JsonFilePath` | `sample-directory.json` | file | Dùng khi `Source: JsonFile` |

## Ingest

Xác thực: **API key qua HTTPS**, server còn kiểm tra IP worker (README mục 5.1).

| Khóa | Mặc định | Giá trị | Ý nghĩa |
| --- | --- | --- | --- |
| `BaseUrl` | (bắt buộc) | URL | Ví dụ `https://blk.corp.local:8443/api/ingest`. `http` chỉ cho localhost |
| `ApiKey` 🔒 | (bắt buộc) | | `INGEST_API_KEY` của server, gửi `Authorization: Bearer` qua HTTPS |
| `CaFile` | | file PEM | CA đã cấp chứng chỉ HTTPS của server, khi máy chưa tin CA đó (dev: `../cert/ca.crt`) |
| `TimeoutSeconds` | 60 | 5–600 | Thời gian chờ mỗi request |
| `BatchSize` | 500 | 1–500 | Số máy / key mỗi lô |
| `RetryForMinutes` | 60 | 1–1440 | Thử lại (lỗi mạng, 5xx) trong bao lâu trước khi bỏ lượt |
| `SkipCertificateValidation` | `false` | bool | Lab: chấp nhận mọi chứng chỉ của server |

## Schedule

| Khóa | Mặc định | Giá trị | Ý nghĩa |
| --- | --- | --- | --- |
| `DeltaEveryMinutes` | 15 | 1–1440 | Chu kỳ delta sync |
| `FullAt` | `01:00` | `HH:mm` | Giờ chạy full hằng đêm (giờ địa phương của máy) |
| `HeartbeatEveryMinutes` | 5 | 1–60 | Chu kỳ heartbeat |
| `WorkerId` | tên máy | chuỗi | Tên hiển thị ở Quản trị > Sync AD |
| `StateFile` | `/var/lib/blk-sync/state.json` | file | DC, invocationId, ngày full gần nhất. Không chứa bí mật |

## Logging

| Khóa | Mặc định | Giá trị |
| --- | --- | --- |
| `Level` | `Information` | `Debug` \| `Information` \| `Warning` \| `Error` |
| `Format` | `text` | `text` \| `json` |

## Biến môi trường khác

| Biến | Ý nghĩa |
| --- | --- |
| `BLKSYNC_CONFIG` | Đường dẫn file cấu hình (khi không có `--config`) |
| `CREDENTIALS_DIRECTORY` | Do systemd đặt; nơi đọc các bí mật `cred:` |
| `TZ` | Múi giờ cho `FullAt` (mặc định múi giờ của máy) |
