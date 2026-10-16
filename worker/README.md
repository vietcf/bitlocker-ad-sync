# BitlockerSync worker (.NET)

Windows Service đọc máy tính và BitLocker recovery key từ Active Directory rồi đẩy lên ingest API
của app. Đặc tả API nằm ở `server/openapi/ingest.openapi.yaml`; Swagger UI ở
`https://<server>:8443/docs`.

Worker không quyết định lưu gì. Các việc sau đều do server làm: map máy vào chi nhánh, tính trạng
thái key theo từng ổ đĩa, gắn nhãn "Không còn trong AD", kiểm tra bất thường.

Hướng dẫn cài đặt từng bước cho production nằm trong [README chính](../README.md#4-cài-sync-worker-trên-windows).

| Khi nào | Việc gì |
| --- | --- |
| Mỗi 5 phút | Gửi heartbeat. Nếu Admin HQ đã yêu cầu sync trên web, chạy ngay |
| Mỗi 15 phút | Delta sync: chỉ đọc object có `uSNChanged` lớn hơn USN của lượt trước |
| 01:00 hằng đêm (và lần đầu khởi động) | Full sync: đọc tất cả. Máy không thấy sẽ được server gắn nhãn "Không còn trong AD"; không có gì bị xóa |

Mỗi key đọc từ AD gồm các thuộc tính `msFVE-RecoveryGuid` (Key ID), `msFVE-VolumeGuid` (ổ đĩa),
`msFVE-RecoveryPassword`, `whenCreated` và `distinguishedName`. Máy được nhận diện bằng `objectGUID`.

## Cấu trúc

```
src/BitlockerSync.Worker/
  Program.cs             host, DI, các lệnh (run-once, check, protect)
  Options/               cấu hình và kiểm tra cấu hình khi khởi động
  Directory/             đọc LDAP (System.DirectoryServices.Protocols); bản đọc file JSON cho dev
  Ingest/                HTTP client gọi ingest API qua HTTPS (thử lại, API key, CaFile)
  Sync/SyncRunner.cs     một lượt: mở lượt -> chụp USN -> máy -> key -> key mồ côi -> kết thúc
  Scheduling/            vòng lặp của service
tests/BitlockerSync.Tests/  xUnit
scripts/install-service.ps1   cài / đổi tài khoản service
scripts/update-worker.ps1     cập nhật lên bản mới, giữ nguyên appsettings.json
```

## Cấu hình (`appsettings.json`)

| Thiết lập | Giá trị |
| --- | --- |
| `Ldap:Source` | `Ldap` (AD thật) · `JsonFile` (đọc file mẫu, chỉ dùng cho dev) |
| `Ldap:Servers` | Danh sách DC theo thứ tự. DC đầu là DC chính, các DC sau dự phòng. Đổi DC sẽ buộc chạy full |
| `Ldap:Protocol` | `Ldaps` (636, mặc định) · `StartTls` (389 + TLS) · `Ldap` (389, không TLS) |
| `Ldap:Auth` | `Negotiate` (mặc định: tài khoản chạy service/gMSA, hoặc `Username` + `Password`) · `Basic` (simple bind bằng `Username` + `Password`) |
| `Ldap:Username` / `Ldap:Password` | `CORP\svc-blk` hoặc `svc-blk@corp.local`; mật khẩu dạng `dpapi:...` (xem bên dưới) |
| `Ldap:BaseDn`, `Ldap:SearchBases` | DN của domain; danh sách OU cần đọc (để trống = cả `BaseDn`). Các OU được đọc **lần lượt** trong cùng một lượt sync; OU phải nằm trong `BaseDn`; OU trùng hoặc OU con của OU đã có được bỏ qua. Một OU không đọc được (không tồn tại, thiếu quyền) làm cả lượt dừng với mã `ldap_search_base_failed`, để lượt full không coi máy trong OU đó là "Không còn trong AD" |
| `Ldap:AllowInsecure` | `Ldap` + `Basic` gửi mật khẩu và mọi key dạng rõ, nên worker từ chối chạy trừ khi đặt `true` (chỉ dùng cho lab). `Ldap` + `Negotiate` được chấp nhận vì Kerberos signing + sealing mã hóa phiên |
| `Ingest:BaseUrl` | `https://blk.corp.local:8443/api/ingest` (chỉ localhost mới được dùng http) |
| `Ingest:ApiKey` | API key (`dpapi:...`): cách xác thực duy nhất của worker, gửi qua HTTPS |
| `Ingest:CaFile` | File PEM của CA gốc khi Windows chưa tin chứng chỉ của server (dev: CA tự ký trong `cert/`) |
| `Ingest:SkipCertificateValidation` | `true` = không kiểm tra chứng chỉ server (chứng chỉ tự ký, chỉ cho lab; có cảnh báo trong log). Mặc định `false` |
| `Schedule:*` | Chu kỳ chạy, giờ full sync, worker id |

Trên máy chủ, không ghi secret dạng rõ vào file. Mã hóa bằng DPAPI cho đúng máy đó:

```powershell
.\BitlockerSync.Worker.exe protect    # hỏi secret mà không hiện lên màn hình (không lưu vào lịch sử shell)
# -> dpapi:AQAAANCMnd8BFdERjHoAwE...  : dán chuỗi này làm giá trị
```

## Quyền trên Active Directory

Tài khoản worker (khuyến nghị gMSA) cần đọc computer object (mặc định ai đã xác thực cũng đọc được)
và thuộc tính confidential `msFVE-RecoveryPassword` trên object `msFVE-RecoveryInformation`, chỉ
trong các OU máy tính. **Không** cấp Domain Admin. Ví dụ (thử ở lab trước):

```powershell
# gMSA (một lần): New-ADServiceAccount gmsa-blk -DNSHostName gmsa-blk.corp.local -PrincipalsAllowedToRetrieveManagedPassword 'BLK-SYNC-01$'
dsacls "OU=Computers,DC=corp,DC=local" /I:S /G "CORP\gmsa-blk$:RP;;msFVE-RecoveryInformation"
dsacls "OU=Computers,DC=corp,DC=local" /I:S /G "CORP\gmsa-blk$:CA;msFVE-RecoveryPassword;msFVE-RecoveryInformation"
```

Kiểm tra quyền trước khi cài: `BitlockerSync.Worker.exe check` kết nối DC, đọc RootDSE, rồi đọc thử vài
máy và vài key **trong từng OU** của `SearchBases` và in `OK`/`FAIL` cho mỗi OU, kèm số key không đọc
được mật khẩu (thiếu quyền). Có OU `FAIL` thì mã thoát là 4.

## Cài đặt

```powershell
dotnet publish src/BitlockerSync.Worker -c Release -o C:\BitlockerSync
Copy-Item .\scripts C:\BitlockerSync\scripts -Recurse    # publish không chép thư mục scripts
# sửa C:\BitlockerSync\appsettings.json, rồi chạy với quyền Administrator:
C:\BitlockerSync\scripts\install-service.ps1 -Account 'CORP\gmsa-blk$' -InstallDir C:\BitlockerSync
Start-Service BitlockerSync
```

`-Account` nhận một trong ba loại: gMSA (`CORP\gmsa-blk$`), tài khoản domain thường (`CORP\svc-blk`,
script hỏi mật khẩu), hoặc tài khoản ảo `NT SERVICE\BitlockerSync` khi LDAP dùng `Ldap:Username` /
`Ldap:Password` trong file cấu hình. Chi tiết từng cách ở
[README chính, mục 4.6](../README.md#46-cài-windows-service).

Cập nhật lên bản mới (giữ nguyên `appsettings.json`, có sao lưu và kiểm tra trước khi chạy lại):

```powershell
D:\drop\BitlockerSync-1.1\scripts\update-worker.ps1 -Source D:\drop\BitlockerSync-1.1 -InstallDir C:\BitlockerSync
```

Chi tiết và cách quay lại bản cũ ở [README chính, mục 4.7](../README.md#47-cập-nhật-worker-lên-phiên-bản-mới).

Log ghi vào Event Viewer > Application, source `BitlockerSync`, bằng tiếng Anh. Recovery key không
bao giờ được ghi vào log.

## Phát triển

Không cần DC: `appsettings.Development.json` có thể đọc `sample-directory.json` (`Ldap:Source` =
`JsonFile`) và đẩy lên API của `docker compose up` (https://localhost:8443, tin CA dev qua `Ingest:CaFile`).

```bash
cd worker
dotnet test
cd src/BitlockerSync.Worker
DOTNET_ENVIRONMENT=Development dotnet run -- run-once full
```

Với AD lab: đặt `Ldap:Source` = `Ldap`, điền `Servers`, `BaseDn` và phần xác thực trong
`appsettings.Development.json` (mật khẩu dạng `dpapi:...`), rồi chạy `dotnet run -- check`.
