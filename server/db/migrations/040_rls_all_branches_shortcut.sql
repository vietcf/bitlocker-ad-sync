-- Hieu nang: chinh sach RLS cua recovery_key / key_duplicate / key_owner_change dung bang bam cua TOAN BO bang computer
-- (EXISTS ... computer) cho moi truy van, ke ca Admin HQ thay tat ca chi nhanh. Them "app_all_branches() OR" len dau:
-- voi Admin HQ phan EXISTS khong bao gio chay (do tren 50k may / 60k key: Tong quan 5,2 giay -> 0,3 giay cung voi cac sua khac).
-- Y nghia phan quyen KHONG doi: voi pham vi "tat ca", moi may deu thay duoc nen EXISTS von luon dung (khoa ngoai dam bao
-- may ton tai); voi pham vi theo chi nhanh dieu kien van y nhu cu.
ALTER POLICY recovery_key_branch_scope ON recovery_key
  USING (app_all_branches() OR EXISTS (SELECT 1 FROM computer c WHERE c.id = recovery_key.computer_id))
  WITH CHECK (app_all_branches() OR EXISTS (SELECT 1 FROM computer c WHERE c.id = recovery_key.computer_id));

ALTER POLICY key_duplicate_scope ON key_duplicate
  USING (app_all_branches()
         OR EXISTS (SELECT 1 FROM computer c WHERE c.id = key_duplicate.computer_id)
         OR EXISTS (SELECT 1 FROM recovery_key k WHERE k.key_id = key_duplicate.key_id))
  WITH CHECK (app_all_branches() OR EXISTS (SELECT 1 FROM computer c WHERE c.id = key_duplicate.computer_id));

ALTER POLICY key_owner_change_scope ON key_owner_change
  USING (app_all_branches()
         OR EXISTS (SELECT 1 FROM computer c WHERE c.id = ANY (ARRAY[key_owner_change.from_computer_id, key_owner_change.to_computer_id])))
  WITH CHECK (app_all_branches() OR EXISTS (SELECT 1 FROM computer c WHERE c.id = key_owner_change.to_computer_id));
