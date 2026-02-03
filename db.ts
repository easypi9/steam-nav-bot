// db.ts — ПОЛНАЯ ЗАМЕНА (сохраняем твою схему, меняем только путь БД)

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

// Railway Volume будем монтировать в /data
// Можно переопределить через переменную окружения DB_PATH
const DB_PATH = (process.env.DB_PATH || "/data/bot.db").trim();

// гарантируем, что папка под БД существует
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);

// (опционально, но полезно для стабильности sqlite)
db.pragma("journal_mode = WAL");

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
