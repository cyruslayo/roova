CREATE TABLE panorama_rooms (
  id TEXT PRIMARY KEY,
  tour_id TEXT NOT NULL REFERENCES tours(id),
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft',
  panorama_key TEXT,
  thumbnail_key TEXT,
  pending_panorama_key TEXT,
  pending_thumbnail_key TEXT,
  width INTEGER,
  height INTEGER,
  published_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX panorama_rooms_tour ON panorama_rooms(tour_id,sort_order);
-- Preserve the existing capture ID so Safari IndexedDB frames stay linked to their room.
INSERT INTO panorama_rooms(id,tour_id,name,sort_order,updated_at)
SELECT id,id,room_name,0,updated_at FROM tours;
