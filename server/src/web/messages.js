// Text for the web UI. Services, the API and logs speak English (AppError.message); the web looks errors up
// here by code (or by the English message when one code has several) and translates them with t().
// The Vietnamese text is the translation key (see src/i18n). Anything not listed falls back to the English message.

import { tk } from '../i18n/index.js';

const BY_CODE = {
  invalid_request: (d, t) => t('Dữ liệu gửi lên không hợp lệ.'),
  duplicate_password_differs: (d, t) => t('Không gán được: mật khẩu của 2 máy khác nhau.'),
  duplicate_created_unknown: (d, t) => t('Không gán được: thiếu ngày tạo trên AD của {holder} hoặc {other}.', { holder: d?.holder, other: d?.other }),
  duplicate_not_newer: (d, t) => t('Không gán được: {holder} (đang giữ key) đã mới hơn {other}.', { holder: d?.holder, other: d?.other }),
  duplicate_same_time: (d, t) => t('Không gán được: {holder} và {other} được tạo cùng lúc trên AD.', { holder: d?.holder, other: d?.other }),
  alert_not_markable: (d, t) => t('Chỉ cảnh báo tính từ dữ liệu mới xử lý hoặc bỏ qua được; sự cố hệ thống tự hết khi sửa xong.'),
  unauthenticated: (d, t) => t('Bạn cần đăng nhập.'),
  api_requires_local: (d, t) => t('API chỉ nhận tài khoản local. Tài khoản AD đăng nhập trên web.'),
  forbidden: (d, t) => t('Bạn không có quyền thực hiện thao tác này.'),
  csrf_failed: (d, t) => t('Phiên làm việc không hợp lệ, vui lòng tải lại trang và thử lại.'),
  json_required: (d, t) => t('Request phải là JSON.'),
  too_large: (d, t) => t('Dữ liệu gửi lên quá lớn.'),
  session_expired: (d, t) => t('Phiên đăng nhập đã hết hạn.'),
  password_change_required: (d, t) => t('Bạn cần đổi mật khẩu trước khi tiếp tục.'),
  invalid_credentials: (d, t) => t('Sai tên đăng nhập hoặc mật khẩu.'),
  account_locked: (d, t) => (d?.minutes === 0
    ? t('Tài khoản bị khóa do nhập sai nhiều lần. Liên hệ Admin HQ để mở khóa.')
    : t('Tài khoản đang bị khóa tạm thời do nhập sai nhiều lần. Thử lại sau {minutes} phút.', { minutes: d?.minutes ?? 15 })),
  directory_not_configured: (d, t) => t('Đăng nhập bằng tài khoản AD chưa được cấu hình.'),
  directory_unavailable: (d, t) => t('Không kết nối được máy chủ AD. Thử lại sau; nếu khẩn cấp, liên hệ Admin HQ.'),
  ad_account_mismatch: (d, t) => t('Tài khoản AD này không khớp với tài khoản đã đăng ký trong hệ thống. Liên hệ Admin HQ.'),
  mismatch: (d, t) => t('Hai lần nhập mật khẩu mới không khớp.'),
  wrong_current_password: (d, t) => t('Mật khẩu hiện tại không đúng.'),
  weak_password: (d, t) =>
    ({
      too_short: () => t('Mật khẩu mới phải có ít nhất {min} ký tự.', { min: d?.minLength ?? 12 }),
      missing_upper: () => t('Mật khẩu mới phải có ít nhất một chữ hoa.'),
      missing_lower: () => t('Mật khẩu mới phải có ít nhất một chữ thường.'),
      missing_digit: () => t('Mật khẩu mới phải có ít nhất một chữ số.'),
      missing_special: () => t('Mật khẩu mới phải có ít nhất một ký tự đặc biệt (không phải chữ hoặc số).'),
      too_long: () => t('Mật khẩu mới quá dài.'),
      contains_username: () => t('Mật khẩu mới không được chứa tên đăng nhập.'),
      same_as_current: () => t('Mật khẩu mới phải khác mật khẩu hiện tại.'),
    })[d?.reason]?.(),
  ou_taken: (d, t) => t('OU đã thuộc chi nhánh khác: {list}', { list: (d?.taken ?? []).map((x) => `${x.ou} (${x.branch})`).join('; ') }),
  code_taken: (d, t) => t('Mã chi nhánh {code} đã tồn tại.', { code: d?.code }),
  username_taken: (d, t) => t('Tên đăng nhập {username} đã tồn tại.', { username: d?.username }),
  invalid_branch: (d, t) => t('Chi nhánh không tồn tại.'),
  confirm_mismatch: (d, t) => t('Mã xác nhận không khớp. Gõ đúng mã chi nhánh {code} để xóa.', { code: d?.code ?? '' }),
  invalid_username: (d, t) => t('Không chuyển được: {reason}. Tạo user mới với tên phù hợp.', { reason: fieldText(d?.authSource === 'ldap' ? 'invalid_ad_username' : 'invalid_local_username', t) }),
  self_lockout: (d, t) => t('Không thể tự bỏ quyền admin hoặc tự khóa tài khoản của mình.'),
  root_admin_protected: (d, t) => t('Chỉ admin gốc (tài khoản admin tạo lúc khởi tạo) mới được sửa tài khoản admin gốc.'),
  only_root_can_demote_admin: (d, t) => t('Chỉ admin gốc mới được bỏ quyền admin hoặc khóa một admin khác.'),
  user_has_log: (d, t) => t('Không thể xóa {username} vì nhật ký đã có ghi nhận liên quan đến người này. Chỉ có thể vô hiệu hóa (bỏ chọn "Đang hoạt động"), không thể xóa.', { username: d?.username ?? t('người dùng này') }),
  self_delete: (d, t) => t('Không thể tự xóa tài khoản của mình.'),
  admin_exclusive: (d, t) => t('Admin HQ đã bao gồm mọi chi nhánh nên không chọn kèm vai trò khác.'),
  one_role_per_branch: (d, t) => t('Mỗi chi nhánh chỉ được chọn một vai trò cho một người dùng.'),
  last_admin: (d, t) => t('Phải còn ít nhất một admin đang hoạt động.'),
  ticket_required: (d, t) => t('Vui lòng nhập số ticket.'),
  run_in_progress: (d, t) => t('Một lượt sync khác đang chạy.'),
  run_closed: (d, t) => t('Lượt sync này đã đóng.'),
  not_quarantined: (d, t) => t('Lượt sync này không chờ quyết định.'),
  feature_disabled: (d, t) => t('Tính năng này đang tắt (Quản trị > Tính năng).'),
  smtp_not_configured: (d, t) => t('Hãy lưu cấu hình mail server trước.'),
  not_failed: (d, t) => t('Chỉ gửi lại được mail đã thất bại.'),
};

const BY_MESSAGE = {
  'Branch not found.': tk('Không tìm thấy chi nhánh.'),
  'User not found.': tk('Không tìm thấy user.'),
  'Computer not found.': tk('Không tìm thấy máy.'),
  'Key not found.': tk('Không tìm thấy key.'),
  'Sync run not found.': tk('Không tìm thấy lượt sync.'),
  'Mail not found.': tk('Không tìm thấy mail.'),
  'Not found.': tk('Không tìm thấy.'),
  'Choose a valid reason.': tk('Vui lòng chọn lý do hợp lệ.'),
  'The reason "other" needs a note.': tk('Lý do "khác" cần ghi chú cụ thể.'),
  'AD accounts change their password in Windows/AD, not here.': tk('Tài khoản AD đổi mật khẩu trên Windows/AD, không đổi ở đây.'),
  'This user signs in with AD; the password is managed by AD.': tk('User này đăng nhập bằng tài khoản AD; mật khẩu do AD quản lý.'),
};

// Validation messages of individual form fields (custom ones are codes).
const FIELD = {
  invalid_dn: (d, t) => t('DN không hợp lệ (ví dụ OU=Computers,OU=HN,DC=corp,DC=local)'),
  invalid_branch_code: (d, t) => t('Mã chi nhánh: 1–16 ký tự A-Z, 0-9, _ hoặc -'),
  mismatch: (d, t) => t('Hai lần nhập mật khẩu không khớp.'),
  invalid_time: (d, t) => t('Giờ không hợp lệ (HH:MM).'),
  backup_password_short: (d, t) => t('Mật khẩu sao lưu phải có ít nhất {min} ký tự.', { min: d?.min ?? 16 }),
  backup_password_missing: (d, t) => t('Đặt mật khẩu sao lưu trước khi bật sao lưu tự động (hoặc tắt mã hóa).'),
  backup_nothing_selected: (d, t) => t('Chọn ít nhất một loại sao lưu (máy và key, hoặc database).'),
  all_branches_admin_only: (d, t) => t('Chỉ Admin HQ được xem toàn bộ chi nhánh; các vai trò khác phải chọn từng chi nhánh.'),
  invalid_ad_username: (d, t) => t('Tài khoản AD: nhập sAMAccountName (tên đăng nhập Windows, tối đa 20 ký tự), ví dụ nguyenvana'),
  invalid_local_username: (d, t) => t('Tài khoản nội bộ: 2–64 ký tự chữ, số, dấu chấm, gạch'),
  name_email_required_local: (d, t) => t('Tài khoản nội bộ cần nhập họ tên và email.'),
  invalid_email: (d, t) => t('Email không hợp lệ (ví dụ nguyenvana@corp.local)'),
  invalid_date: (d, t) => t('Ngày không hợp lệ (định dạng YYYY-MM-DD)'),
  host_required: (d, t) => t('Nhập địa chỉ mail server khi bật gửi mail'),
  access_log_days_required: (d, t) => t('Nhập số ngày giữ nhật ký, hoặc chọn "Giữ mãi"'),
};

const identity = (key, params = {}) => key.replace(/\{(\w+)\}/g, (m, k) => (k in params ? params[k] : m));

/** Text of an AppError (or any error with code/message/details) in the language of `t` (default: Vietnamese). */
export function errorText(err, t = identity) {
  // English: the AppError message is already English; Vietnamese/English dictionaries cover the UI strings.
  const byMessage = BY_MESSAGE[err.message];
  if (byMessage) return t(byMessage);
  const entry = BY_CODE[err.code];
  const text = entry ? entry(err.details, t) : undefined;
  return text ?? err.message;
}

/** Text of one field validation message. */
export function fieldText(message, t = identity) {
  const range = /^out_of_range:(.+)-(.+)$/.exec(message ?? '');
  if (range) return t('Phải từ {min} đến {max}', { min: range[1], max: range[2] });
  const entry = FIELD[message];
  return entry ? entry(undefined, t) : t(message ?? '');
}
