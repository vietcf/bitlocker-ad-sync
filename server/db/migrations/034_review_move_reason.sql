-- Them ly do chuyen key: Admin HQ bam "Da kiem tra" o muc Key ID trung, he thong so ngay tao tren AD cua 2 may
-- va gan key cho may moi hon.
ALTER TABLE key_owner_change DROP CONSTRAINT key_owner_change_reason_check;
ALTER TABLE key_owner_change ADD CONSTRAINT key_owner_change_reason_check
  CHECK (reason IN ('rejoin_same_name', 'old_not_in_ad', 'review_newer'));

-- Cap trung co the duoc danh dau "dung chung": key giu nguyen o may dang giu, 2 may deu hien ghi chu.
ALTER TABLE key_duplicate DROP CONSTRAINT key_duplicate_resolution_check;
ALTER TABLE key_duplicate ADD CONSTRAINT key_duplicate_resolution_check
  CHECK (resolution IN ('reviewed', 'gone', 'moved', 'shared'));
