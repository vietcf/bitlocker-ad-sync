// Vietnamese text for the web UI. Services, the API and logs speak English (AppError.message);
// the web looks errors up here by code, or by the English message when one code has several.
// Anything not listed falls back to the English message.

const BY_CODE = {
  invalid_request: 'Dữ liệu gửi lên không hợp lệ.',
  unauthenticated: 'Bạn cần đăng nhập.',
  forbidden: 'Bạn không có quyền thực hiện thao tác này.',
  csrf_failed: 'Phiên làm việc không hợp lệ, vui lòng tải lại trang và thử lại.',
  json_required: 'Request phải là JSON.',
  too_large: 'Dữ liệu gửi lên quá lớn.',
  session_expired: 'Phiên đăng nhập đã hết hạn.',
  password_change_required: 'Bạn cần đổi mật khẩu trước khi tiếp tục.',
  invalid_credentials: 'Sai tên đăng nhập hoặc mật khẩu.',
  account_locked: 'Tài khoản đang bị khóa tạm thời do nhập sai nhiều lần. Thử lại sau 15 phút.',
  directory_not_configured: 'Đăng nhập bằng tài khoản AD chưa được cấu hình.',
  directory_unavailable: 'Không kết nối được máy chủ AD. Thử lại sau; nếu khẩn cấp, liên hệ Admin HQ.',
  ad_account_mismatch: 'Tài khoản AD này không khớp với tài khoản đã đăng ký trong hệ thống. Liên hệ Admin HQ.',
  wrong_current_password: 'Mật khẩu hiện tại không đúng.',
  weak_password: (d) =>
    ({
      too_short: `Mật khẩu mới phải có ít nhất ${d?.minLength ?? 12} ký tự.`,
      missing_upper: 'Mật khẩu mới phải có ít nhất một chữ hoa.',
      missing_lower: 'Mật khẩu mới phải có ít nhất một chữ thường.',
      missing_digit: 'Mật khẩu mới phải có ít nhất một chữ số.',
      missing_special: 'Mật khẩu mới phải có ít nhất một ký tự đặc biệt (không phải chữ hoặc số).',
      too_long: 'Mật khẩu mới quá dài.',
      contains_username: 'Mật khẩu mới không được chứa tên đăng nhập.',
      same_as_current: 'Mật khẩu mới phải khác mật khẩu hiện tại.',
    })[d?.reason],
  ou_taken: (d) => `OU đã thuộc chi nhánh khác: ${(d?.taken ?? []).map((t) => `${t.ou} (${t.branch})`).join('; ')}`,
  code_taken: (d) => `Mã chi nhánh ${d?.code} đã tồn tại.`,
  username_taken: (d) => `Tên đăng nhập ${d?.username} đã tồn tại.`,
  invalid_branch: 'Chi nhánh không tồn tại.',
  confirm_mismatch: (d) => `Mã xác nhận không khớp. Gõ đúng mã chi nhánh ${d?.code ?? ''} để xóa.`,
  invalid_username: (d) => `Không chuyển được: ${FIELD[d?.authSource === 'ldap' ? 'invalid_ad_username' : 'invalid_local_username']}. Tạo user mới với tên phù hợp.`,
  self_lockout: 'Không thể tự bỏ quyền admin hoặc tự khóa tài khoản của mình.',
  last_admin: 'Phải còn ít nhất một admin đang hoạt động.',
  ticket_required: 'Vui lòng nhập số ticket.',
  run_in_progress: 'Một lượt sync khác đang chạy.',
  run_closed: 'Lượt sync này đã đóng.',
  not_quarantined: 'Lượt sync này không chờ quyết định.',
  feature_disabled: 'Tính năng này đang tắt (Quản trị > Tính năng).',
  smtp_not_configured: 'Hãy lưu cấu hình mail server trước.',
  not_failed: 'Chỉ gửi lại được mail đã thất bại.',
};

const BY_MESSAGE = {
  'Branch not found.': 'Không tìm thấy chi nhánh.',
  'User not found.': 'Không tìm thấy user.',
  'Computer not found.': 'Không tìm thấy máy.',
  'Key not found.': 'Không tìm thấy key.',
  'Sync run not found.': 'Không tìm thấy lượt sync.',
  'Mail not found.': 'Không tìm thấy mail.',
  'Not found.': 'Không tìm thấy.',
  'Choose a valid reason.': 'Vui lòng chọn lý do hợp lệ.',
  'The reason "other" needs a note.': 'Lý do "khác" cần ghi chú cụ thể.',
  'AD accounts change their password in Windows/AD, not here.': 'Tài khoản AD đổi mật khẩu trên Windows/AD, không đổi ở đây.',
  'This user signs in with AD; the password is managed by AD.': 'User này đăng nhập bằng tài khoản AD; mật khẩu do AD quản lý.',
};

// Validation messages of individual form fields (custom ones are codes).
const FIELD = {
  invalid_dn: 'DN không hợp lệ (ví dụ OU=Computers,OU=HN,DC=corp,DC=local)',
  invalid_branch_code: 'Mã chi nhánh: 1–16 ký tự A-Z, 0-9, _ hoặc -',
  mismatch: 'Hai lần nhập mật khẩu không khớp.',
  invalid_time: 'Giờ không hợp lệ (HH:MM).',
  backup_password_short: (d) => `Mật khẩu sao lưu phải có ít nhất ${d?.min ?? 16} ký tự.`,
  backup_password_missing: 'Đặt mật khẩu sao lưu trước khi bật sao lưu tự động (hoặc tắt mã hóa).',
  backup_nothing_selected: 'Chọn ít nhất một loại sao lưu (máy và key, hoặc database).',
  all_branches_admin_only: 'Chỉ Admin HQ được xem toàn bộ chi nhánh; các vai trò khác phải chọn từng chi nhánh.',
  invalid_ad_username: 'Tài khoản AD: nhập sAMAccountName (tên đăng nhập Windows, tối đa 20 ký tự), ví dụ nguyenvana',
  invalid_local_username: 'Tài khoản nội bộ: 2–64 ký tự chữ, số, dấu chấm, gạch',
  invalid_email: 'Email không hợp lệ (ví dụ nguyenvana@corp.local)',
  invalid_date: 'Ngày không hợp lệ (định dạng YYYY-MM-DD)',
  host_required: 'Nhập địa chỉ mail server khi bật gửi mail',
  access_log_days_required: 'Nhập số ngày giữ nhật ký, hoặc chọn "Giữ mãi"',
};

/** Vietnamese text of an AppError (or any error with code/message/details). */
export function errorText(err) {
  const byMessage = BY_MESSAGE[err.message];
  if (byMessage) return byMessage;
  const entry = BY_CODE[err.code];
  const text = typeof entry === 'function' ? entry(err.details) : entry;
  return text ?? err.message;
}

/** Vietnamese text of one field validation message. */
export const fieldText = (message) => {
  const range = /^out_of_range:(.+)-(.+)$/.exec(message ?? '');
  if (range) return `Phải từ ${range[1]} đến ${range[2]}`;
  return FIELD[message] ?? message;
};
