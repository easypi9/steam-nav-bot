import "dotenv/config";
import express from "express";
import cors from "cors";
import { db } from "./db.js";

//
// ENV
//
const PORT = Number(process.env.PORT || 8080);

const CHANNEL_USERNAME = (process.env.CHANNEL_USERNAME || "").trim();
const CHAT_URL = (process.env.CHAT_URL || "").trim();
const WEBAPP_URL = (process.env.WEBAPP_URL || "").trim();
const WEBAPP_ORIGIN = WEBAPP_URL ? new URL(WEBAPP_URL).origin : "";

const FALLBACK_ORIGINS = ["https://easypi9.github.io"];
const LOCAL_ORIGINS = ["http://127.0.0.1:8080", "http://localhost:8080"];

function postUrl(messageId: number) {
  if (!CHANNEL_USERNAME) return "";
  return `https://t.me/${CHANNEL_USERNAME}/${messageId}`;
}

//
// API
//
const app = express();
app.use(express.json());

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      const ok =
        origin === WEBAPP_ORIGIN ||
        FALLBACK_ORIGINS.includes(origin) ||
        LOCAL_ORIGINS.includes(origin);
      return cb(ok ? null : new Error(`CORS blocked for ${origin}`), ok);
    },
  })
);

app.get("/", (_req, res) => res.send("OK. Try /health or /meta"));
app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/meta", (_req, res) => {
  res.json({
    channel_username: CHANNEL_USERNAME,
    chat_url: CHAT_URL,
    webapp_url: WEBAPP_URL,
    webapp_origin: WEBAPP_ORIGIN,
  });
});

// lessons
app.get("/lessons", (req, res) => {
  const section = String(req.query.section || "").trim();
  if (section !== "prep" && section !== "steam") {
    return res.status(400).json({ error: "section must be prep|steam" });
  }

  const rows = db
    .prepare(
      "SELECT ord, title, message_id FROM lessons WHERE section=? ORDER BY ord ASC"
    )
    .all(section);

  res.json({
    section,
    items: rows.map((r: any) => ({ ...r, post_url: postUrl(r.message_id) })),
  });
});

// news
app.get("/news", (_req, res) => {
  const rows = db
    .prepare("SELECT message_id, created_at FROM news ORDER BY id DESC LIMIT 200")
    .all();

  res.json({
    items: rows.map((r: any) => ({ ...r, post_url: postUrl(r.message_id) })),
  });
});

// links
app.get("/links", (_req, res) => {
  const rows = db
    .prepare("SELECT title, url, ord FROM links ORDER BY ord ASC, id ASC")
    .all();
  res.json({ items: rows });
});

// progress (GET)
app.get("/progress", (req, res) => {
  const userId = Number(req.query.user_id);
  if (!userId) return res.status(400).json({ error: "user_id required" });

  const rows = db
    .prepare("SELECT section, ord, updated_at FROM progress WHERE user_id=?")
    .all(userId);

  res.json({ user_id: userId, items: rows });
});

// progress (POST) ⭐ NEW
app.post("/progress", (req, res) => {
  const user_id = Number(req.body?.user_id);
  const section = String(req.body?.section || "").trim();
  const ord = Number(req.body?.ord);

  if (!user_id || !["prep", "steam"].includes(section) || !ord) {
    return res.status(400).json({ error: "invalid payload" });
  }

  db.prepare(`
    INSERT OR REPLACE INTO progress(user_id, section, ord, updated_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(user_id, section, ord);

  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`API started on port ${PORT}`);
});
