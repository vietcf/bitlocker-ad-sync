-- Lan dang nhap gan nhat cua computer (AD: lastLogonTimestamp, dong bo giua cac DC, do chinh xac ~14 ngay).
-- Dung de biet may nao con duoc dung: hien o trang may va loc o trang Tim may.
ALTER TABLE computer ADD COLUMN last_logon_at timestamptz NULL;
CREATE INDEX ix_computer_last_logon_at ON computer (last_logon_at);
