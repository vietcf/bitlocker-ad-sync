-- Sao luu (Quan tri > Sao luu).
-- 1. DN cua doi tuong key tren AD (msFVE-RecoveryInformation), de file backup ghi day du.
--    Key cu (truoc migration nay) duoc dien o lan sync full ke tiep.
ALTER TABLE recovery_key ADD COLUMN ad_dn text NULL;

-- 2. Tai khoan blk_backup (chi doc) cho pg_dump: SELECT moi bang / sequence. Role do quan tri
--    PostgreSQL tao (README "Sao luu database"); co role thi cap quyen o day, ke ca bang tao sau nay.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'blk_backup') THEN
    GRANT USAGE ON SCHEMA public TO blk_backup;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO blk_backup;
    GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO blk_backup;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO blk_backup;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO blk_backup;
  END IF;
END $$;
