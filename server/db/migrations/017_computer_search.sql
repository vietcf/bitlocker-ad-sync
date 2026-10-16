-- The search box also finds computers by machine serial and user e-mail (prefix, any case).
CREATE INDEX ix_computer_serial ON computer (lower(device_serial) text_pattern_ops) WHERE device_serial IS NOT NULL;
CREATE INDEX ix_computer_owner_email ON computer (lower(owner_email) text_pattern_ops) WHERE owner_email IS NOT NULL;
