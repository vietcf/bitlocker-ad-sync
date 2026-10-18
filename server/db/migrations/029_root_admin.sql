-- Admin goc: tai khoan admin tao luc khoi tao ung dung. Chi admin goc moi duoc ha quyen / khoa admin khac,
-- va admin khac khong sua duoc admin goc. Ban cu: nguoi dung admin tao som nhat.
ALTER TABLE app_user ADD COLUMN is_root boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX ux_app_user_root ON app_user (is_root) WHERE is_root;
UPDATE app_user SET is_root = true
 WHERE id = (SELECT min(u.id) FROM app_user u JOIN user_grant g ON g.user_id = u.id WHERE g.role = 'admin');
