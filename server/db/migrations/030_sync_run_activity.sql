-- Lan cuoi worker goi API cho luot sync (moi lo may/key, ket thuc). Luot dang chay ma im lang qua lau
-- (worker crash) duoc coi la mo coi va giai phong khi mo luot moi, khong cho tron 2 gio.
ALTER TABLE sync_run ADD COLUMN last_activity_at timestamptz NULL;
