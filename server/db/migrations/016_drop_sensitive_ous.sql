-- The "sensitive OU" reveal alert is gone: only reveals outside working hours raise an alert.
DELETE FROM app_setting WHERE key = 'reveal.sensitive_ous';
