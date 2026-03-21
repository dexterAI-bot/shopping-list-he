import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'db.sqlite');

export const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS households (
  id TEXT PRIMARY KEY,
  telegram_chat_id TEXT UNIQUE NOT NULL,
  name TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  name_he TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  category TEXT NOT NULL,
  qty REAL,
  unit TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (household_id) REFERENCES households(id)
);
CREATE INDEX IF NOT EXISTS idx_items_household_active ON items(household_id, active);
CREATE INDEX IF NOT EXISTS idx_items_norm ON items(household_id, normalized_name);

CREATE TABLE IF NOT EXISTS shopping_trips (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  store_name TEXT,
  store_branch TEXT,
  city TEXT,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  FOREIGN KEY (household_id) REFERENCES households(id)
);

CREATE TABLE IF NOT EXISTS cart_entries (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  in_cart INTEGER NOT NULL,
  price REAL,
  qty_bought REAL,
  note TEXT,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (trip_id) REFERENCES shopping_trips(id),
  FOREIGN KEY (item_id) REFERENCES items(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cart_unique ON cart_entries(trip_id, item_id);

CREATE TABLE IF NOT EXISTS purchases (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL,
  item_name_he TEXT NOT NULL,
  category TEXT NOT NULL,
  price REAL,
  qty_bought REAL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (trip_id) REFERENCES shopping_trips(id)
);

CREATE TABLE IF NOT EXISTS shopping_sessions (
  token TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  trip_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (household_id) REFERENCES households(id),
  FOREIGN KEY (trip_id) REFERENCES shopping_trips(id)
);
`);
