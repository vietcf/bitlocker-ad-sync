-- Moi nguoi dung chi co mot vai tro tren moi chi nhanh (Admin HQ khong gan chi nhanh, loai tru cac vai tro khac o tang ung dung).
CREATE UNIQUE INDEX ux_user_grant_one_role_per_branch ON user_grant (user_id, branch_id) WHERE branch_id IS NOT NULL;
