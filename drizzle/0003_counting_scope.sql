ALTER TABLE events
  ADD COLUMN counting_scope varchar(16) NOT NULL DEFAULT 'gathering',
  ADD CONSTRAINT events_counting_scope_check CHECK (counting_scope IN ('gathering','city'));

-- Existing rows keep their exact geometry and counting data, with the historical gathering scope.
ALTER TABLE events DROP CONSTRAINT events_polygon_check;
ALTER TABLE events ADD CONSTRAINT events_polygon_check CHECK (
  COALESCE(
    jsonb_typeof(geofence) = 'object'
    AND jsonb_typeof(geofence->'coordinates') = 'array'
    AND (
      (counting_scope = 'gathering' AND geofence->>'type' = 'Polygon')
      OR (counting_scope = 'city' AND geofence->>'type' IN ('Polygon','MultiPolygon'))
    ), false
  )
);
