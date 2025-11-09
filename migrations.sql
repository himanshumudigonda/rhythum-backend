-- Simple migrations for Rhythum
CREATE TABLE IF NOT EXISTS playlists (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  tracks JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS history (
  id SERIAL PRIMARY KEY,
  track JSONB NOT NULL,
  played_at TIMESTAMP DEFAULT NOW()
);