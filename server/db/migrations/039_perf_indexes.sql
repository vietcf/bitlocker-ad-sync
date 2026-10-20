-- Chi muc cho cac truy van cham tren du lieu lon (50k may, 60k key, hang trieu dong nhat ky):
--  * ix_computer_list: thu tu danh sach Tim may (may dang giam sat truoc, theo ten) doc truc tiep tu chi muc, khong sap xep ca bang
--  * ix_key_first_synced_at / ix_key_ad_created_at: ngay dau tien co du lieu cua bao cao "Toan bo thoi gian"
CREATE INDEX ix_computer_list ON computer (deleted_in_ad_at NULLS FIRST, lower(name::text));
CREATE INDEX ix_key_first_synced_at ON recovery_key (first_synced_at);
CREATE INDEX ix_key_ad_created_at ON recovery_key (ad_created_at);
-- Loc nhat ky theo nguoi dung (LIKE '%...%') dung chi muc trigram thay vi quet ca bang nhat ky
CREATE INDEX ix_log_user_trgm ON access_log USING gin (lower(user_upn) gin_trgm_ops);
