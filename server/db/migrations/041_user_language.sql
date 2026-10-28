-- UI language of each user (also used for the emails and reports sent to them).
ALTER TABLE app_user ADD COLUMN language text NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'vi'));
