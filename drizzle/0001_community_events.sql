ALTER TABLE events
  ADD COLUMN creation_source varchar(16) NOT NULL DEFAULT 'team',
  ADD COLUMN creation_request_hash bytea,
  ADD CONSTRAINT events_creation_source_check CHECK (creation_source IN ('team','community')),
  ADD CONSTRAINT events_creation_hash_check CHECK (
    (creation_source='team' AND creation_request_hash IS NULL)
    OR (creation_source='community' AND creation_request_hash IS NOT NULL AND octet_length(creation_request_hash)=32)
  );
