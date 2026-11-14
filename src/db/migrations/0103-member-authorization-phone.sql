ALTER TABLE members ADD COLUMN phone text CHECK(phone IS NULL OR phone ~ '^[0-9]{10,12}$');
