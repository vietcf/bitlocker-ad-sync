-- Chi Admin HQ duoc xem toan bo chi nhanh. Vai tro khac (it, lead, auditor) phai gan theo tung
-- chi nhanh: quyen "tat ca chi nhanh" (branch_id NULL) cua cac vai tro nay bi bo (tu nay khong co
-- tac dung) va khong tao duoc nua.
DELETE FROM user_grant WHERE branch_id IS NULL AND role <> 'admin';
ALTER TABLE user_grant ADD CONSTRAINT user_grant_all_branches_admin_only CHECK (role = 'admin' OR branch_id IS NOT NULL);
