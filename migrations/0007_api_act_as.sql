-- Act-as: a service key (for example, an internal tool) presents `X-Act-As: <email>` to scope a
-- request to one user's mailbox memberships. Only keys flagged here may do it, so
-- an ordinary key can never impersonate.
ALTER TABLE api_keys ADD COLUMN can_act_as INTEGER NOT NULL DEFAULT 0;
