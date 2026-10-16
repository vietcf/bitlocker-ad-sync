-- Admin HQ may delete a branch (Quan tri > Chi nhanh). Its computers are moved to no branch first;
-- branch_ou and user_grant rows go with it (ON DELETE CASCADE). access_log keeps the old branch id.
GRANT DELETE ON branch TO app_node;
