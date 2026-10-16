-- Who may export keys with their recovery passwords (Quan tri > Tinh nang):
-- 'off' (default), 'admin' (Admin HQ only) or 'all' (IT, lead and Admin HQ, each within their branches).
-- Every exported key is logged as a reveal, plus one export_keys row; Admin HQ is alerted.
INSERT INTO app_setting (key, value) VALUES ('export.keys', '"off"') ON CONFLICT (key) DO NOTHING;
