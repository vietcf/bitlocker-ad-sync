-- Email co ban HTML (bao cao hang ngay co bieu do): body van la ban chu thuong (text/plain),
-- html la ban HTML gui kem (multipart/alternative). NULL = chi co ban chu.
ALTER TABLE mail_outbox ADD COLUMN html text NULL;
