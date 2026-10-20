-- So may bi gan nhan "khong con trong pham vi giam sat" boi mot luot (hien o bang Cac luot sync gan day: cot May, dau tru).
-- Cac luot cu khong biet nen de 0.
ALTER TABLE sync_run ADD COLUMN marked_not_in_ad int NOT NULL DEFAULT 0;
