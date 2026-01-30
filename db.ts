import Database from "better-sqlite3";

export const db = new Database("bot.db");

db.exec(`
CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  section TEXT NOT NULL,          -- prep | steam
  ord INTEGER NOT NULL,           -- порядок урока
  title TEXT NOT NULL,
  message_id INTEGER NOT NULL,    -- id поста в канале
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS lessons_unique
ON lessons(section, ord);

CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  ord INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS news (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- progress: где пользователь остановился в каждом разделе
CREATE TABLE IF NOT EXISTS progress (
  user_id INTEGER NOT NULL,
  section TEXT NOT NULL,          -- prep | steam
  ord INTEGER NOT NULL,           -- номер урока
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, section)
);
`);
