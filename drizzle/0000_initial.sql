CREATE TABLE events (
  id uuid PRIMARY KEY,
  slug varchar(100) NOT NULL UNIQUE,
  name varchar(160) NOT NULL,
  city_code varchar(20) NOT NULL,
  city_name varchar(120) NOT NULL,
  description varchar(2000),
  geofence jsonb NOT NULL,
  geofence_version integer NOT NULL DEFAULT 1,
  metadata_version integer NOT NULL DEFAULT 1,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'draft',
  integrity_status varchar(16) NOT NULL DEFAULT 'normal',
  protocol_version integer NOT NULL DEFAULT 1,
  is_test boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finalized_at timestamptz,
  presences_purged_at timestamptz,
  CONSTRAINT events_dates_check CHECK (starts_at < ends_at),
  CONSTRAINT events_slug_check CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT events_name_check CHECK (length(name) > 0),
  CONSTRAINT events_city_code_check CHECK (length(city_code) > 0),
  CONSTRAINT events_city_name_check CHECK (length(city_name) > 0),
  CONSTRAINT events_status_check CHECK (status IN ('draft','published','paused','closed','cancelled')),
  CONSTRAINT events_integrity_check CHECK (integrity_status IN ('normal','anomaly','suspended')),
  CONSTRAINT events_versions_check CHECK (geofence_version > 0 AND metadata_version > 0 AND protocol_version = 1),
  CONSTRAINT events_polygon_check CHECK (COALESCE(jsonb_typeof(geofence) = 'object' AND geofence->>'type' = 'Polygon' AND jsonb_typeof(geofence->'coordinates') = 'array', false))
);

CREATE TABLE presences (
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  anonymous_event_id bytea NOT NULL,
  counting_day date NOT NULL,
  PRIMARY KEY (event_id, anonymous_event_id),
  CONSTRAINT presences_identifier_length CHECK (octet_length(anonymous_event_id) = 32)
);

CREATE TABLE event_counters (
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  counting_day date NOT NULL,
  count bigint NOT NULL DEFAULT 0,
  revision bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (event_id, counting_day),
  CONSTRAINT event_counters_nonnegative CHECK (count >= 0 AND revision >= 0)
);

CREATE TABLE admin_audit (
  id bigserial PRIMARY KEY,
  event_id uuid REFERENCES events(id) ON DELETE RESTRICT,
  operator varchar(120) NOT NULL,
  action varchar(40) NOT NULL,
  reason varchar(1000) NOT NULL,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
