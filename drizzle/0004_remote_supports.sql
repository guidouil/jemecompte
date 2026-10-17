-- Event-scoped identifiers cannot be linked between events. They follow the same
-- retention deadline and purge marker as presences.
CREATE TABLE supports (
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  anonymous_event_id bytea NOT NULL,
  counting_day date NOT NULL,
  PRIMARY KEY (event_id, anonymous_event_id),
  CONSTRAINT supports_identifier_length CHECK (octet_length(anonymous_event_id) = 32)
);

CREATE TABLE support_counters (
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  counting_day date NOT NULL,
  count bigint NOT NULL DEFAULT 0,
  revision bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (event_id, counting_day),
  CONSTRAINT support_counters_nonnegative CHECK (count >= 0 AND revision >= 0)
);

-- Deliberately no event reference, event identifier or timestamp. A daily claim
-- only prevents this anonymous day token being used twice before Paris midnight.
CREATE TABLE daily_support_claims (
  counting_day date NOT NULL,
  anonymous_day_id bytea NOT NULL,
  PRIMARY KEY (counting_day, anonymous_day_id),
  CONSTRAINT daily_support_claims_identifier_length CHECK (octet_length(anonymous_day_id) = 32)
);
