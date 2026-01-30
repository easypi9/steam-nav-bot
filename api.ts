import "dotenv/config";
import express from "express";
import cors from "cors";
import { db } from "./db.js";

const PORT = Number(process.env.API_PORT || 3000);

// WebApp URL (GitHub Pages)
const WEBAPP_URL = (process.env.WEBAPP_URL || "").trim();
const WEBAPP_ORIGIN = WEBAPP_URL ? new URL(WEBAPP_URL).origin : "";

// Local dev
const LOCAL_ORIGINS = ["http://127.0.0.1:8080", "http://localhost:8080"];

// Channel + chat for links
const CHANNEL_USERNAME = (process.env.CHANNEL_USERNAME || "").trim();
const CHAT_URL = (process.env.CHAT_URL || "").trim();

function postUrl(messageId: number) {
  if (!CHANNEL_USERNAME) return "";
  return `https://t.me/${CHANNEL_USERNAME}/${messageId}`;
}

const app = express();
app.use(express.json());

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      const ok = origin === WEBAPP_ORIGIN || LOCAL_ORIGINS.includes(origin);
      return cb(ok ? null : new Error("CORS blocked"), ok);
    },
  })
);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// ---- meta: channel/chat ----
app.get("/meta", (_req, res) => {
  res.json({
    channel_username: CHANNEL_USERNAME,
    chat_url: CHAT_URL,
    webapp_origin: WEBAPP_ORIGIN,
  });
});

// ---- lessons list ----
// GET /lessons?section=prep
app.get("/lessons", (req, res) => {
  const section = String(req.query.section || "").trim();
  if (section !== "prep" && section !== "steam") {
    return res.status(400).json({ error: "section must be prep|steam" });
  }

  const rows = db
    .prepare(
      "SELECT ord, title, message_id FROM lessons WHERE section=? ORDER BY ord ASC"
    )
    .all(section) as Array<{ ord: number; title: string; message_id: number }>;

  const items = rows.map((r) => ({
    ...r,
    post_url: postUrl(r.message_id),
  }));

  res.json({ section, items });
});

// ---- links ----
app.get("/links", (_req, res) => {
  const rows = db
    .prepare("SELECT title, url, ord FROM links ORDER BY ord ASC, id ASC")
    .all();
  res.json({ items: rows });
});

// ---- news ----
app.get("/news", (_req, res) => {
  const rows = db
    .prepare("SELECT message_id, created_at FROM news ORDER BY id DESC LIMIT 200")
    .all() as Array<{ message_id: number; created_at: string }>;

  const items = rows.map((r) => ({
    ...r,
    post_url: postUrl(r.message_id),
  }));

  res.json({ items });
});

// ---- progress ----
// GET /progress?user_id=123
app.get("/progress", (req, res) => {
  const userId = Number(req.query.user_id);
  if (!userId) return res.status(400).json({ error: "user_id required" });

  const rows = db
    .prepare("SELECT section, ord, updated_at FROM progress WHERE user_id=?")
    .all(userId) as Array<{ section: "prep" | "steam"; ord: number; updated_at: string }>;

  // подтягиваем данные урока, если он существует
  const items = rows.map((p) => {
    const lesson = db
      .prepare("SELECT title, message_id FROM lessons WHERE section=? AND ord=?")
      .get(p.section, p.ord) as { title: string; message_id: number } | undefined;

    return {
      ...p,
      title: lesson?.title || null,
      message_id: lesson?.message_id || null,
      post_url: lesson?.message_id ? postUrl(lesson.message_id) : null,
    };
  });

  res.json({ user_id: userId, items });
});

app.listen(PORT, () => {
  console.log(`API started: http://127.0.0.1:${PORT}`);
  if (WEBAPP_ORIGIN) console.log(`CORS allowed: ${WEBAPP_ORIGIN}`);
});
