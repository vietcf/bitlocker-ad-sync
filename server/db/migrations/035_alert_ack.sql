-- Admin HQ xac nhan canh bao: "Da xu ly" (acked_*) hoac "Bo qua N ngay" (snoozed_until). Chi canh bao loai du lieu
-- (escrow_broken, no_key_rising, full_stale, dc_cert_expiring) duoc im lang; canh bao su co he thong chi ghi nhan da xem.
ALTER TABLE sync_alert
  ADD COLUMN acked_at      timestamptz  NULL,
  ADD COLUMN acked_by      varchar(255) NULL,
  ADD COLUMN ack_note      varchar(300) NULL,
  ADD COLUMN snoozed_until timestamptz  NULL;
