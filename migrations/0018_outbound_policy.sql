-- Outbound policy (company signatures, disclaimer, DLP). The policy itself lives in
-- settings under key 'outbound'; these profile fields fill the signature template.
ALTER TABLE users ADD COLUMN job_title TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN phone TEXT NOT NULL DEFAULT '';
