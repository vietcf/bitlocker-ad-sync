-- Xac thuc 2 buoc (TOTP, app Authenticator) cho tung nguoi dung, do Admin HQ bat / tat.
--   totp_required     Admin HQ bat: sau mat khau phai nhap ma 6 so
--   totp_secret       khoa bi mat, ma hoa AES-256-GCM (khoa suy ra tu LOG_HMAC_KEY), khong bao gio hien lai
--   totp_enrolled_at  NULL = chua dang ky xong (lan dang nhap toi se hien ma QR)
--   totp_last_step    buoc thoi gian (30 giay) cua ma da dung gan nhat: mot ma khong dung lai duoc
ALTER TABLE app_user
  ADD COLUMN totp_required    boolean     NOT NULL DEFAULT false,
  ADD COLUMN totp_secret      text        NULL,
  ADD COLUMN totp_enrolled_at timestamptz NULL,
  ADD COLUMN totp_last_step   bigint      NULL;
