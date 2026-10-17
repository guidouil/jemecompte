-- Short-lived spent-work markers only. No event reference, IP or participant token.
CREATE TABLE admission_claims (
  nonce_hash bytea PRIMARY KEY CHECK (octet_length(nonce_hash) = 32),
  expires_at timestamptz NOT NULL
);
CREATE INDEX admission_claims_expiry ON admission_claims(expires_at);
