CREATE TABLE IF NOT EXISTS entities (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  base_risk REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS indicators (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  label TEXT NOT NULL,
  unit TEXT NOT NULL,
  refresh_cadence INTEGER NOT NULL,
  is_live INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_code TEXT NOT NULL,
  indicator_id TEXT NOT NULL,
  raw_value REAL NOT NULL,
  normalized_value REAL NOT NULL,
  timestamp TEXT NOT NULL,
  FOREIGN KEY (entity_code) REFERENCES entities(code),
  FOREIGN KEY (indicator_id) REFERENCES indicators(id)
);

CREATE TABLE IF NOT EXISTS composite_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_code TEXT NOT NULL,
  score REAL NOT NULL,
  timestamp TEXT NOT NULL,
  FOREIGN KEY (entity_code) REFERENCES entities(code)
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  domain_id TEXT NOT NULL,
  message TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS briefs (
  id TEXT PRIMARY KEY,
  tag TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  headline TEXT NOT NULL,
  body TEXT NOT NULL,
  ref_sector_code TEXT NOT NULL,
  composite_score REAL NOT NULL,
  FOREIGN KEY (ref_sector_code) REFERENCES entities(code)
);
