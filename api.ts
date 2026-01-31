import "dotenv/config";
import express from "express";
import cors from "cors";
import { db } from "./db.js";

// Railway обычно задаёт PORT сам
const PORT = Number(process.env.PORT || process.env.API_PORT || 3000);

// Переменные окружения
const CHANNEL_USERNAME = (process.env.CHANNEL_USERNAME || "").trim();
const CHAT_URL = (process.env.CHAT_URL || "").trim();
const WEBAPP_URL_RAW = (process.env.WEBAPP_URL || "").trim();

// Безопасно получаем origin из WEBAPP_URL (чтобы /meta не падал)
function safeOrigin(url: string): string {
  if (!url) return "";
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

const WEBAPP_ORIGIN = safeOrigin(WEBAPP_URL_RAW);

// Разрешённые origin'ы
const FALLBACK_ORIGINS = ["https://easypi9.github.io"];
const LOCAL_ORIGINS = ["http://127.0.0.1:8080", "http://localhost:8080"];

function postUrl(messageId: number) {
  if (!CHANNEL_USERNAME) return null;
  return `https://t.me/${CHANNEL_USERNAME}/${messageId}`;
}

const app = express();
app.use(express.json());

// CORS
app.use(
  cors({
    origin: (origin, cb) => {
      // запросы без origin (curl/сервер-сервер) — разрешим
      if (!origin) return cb(null, true);

      const allowed = new Set<string>([
        ...FALLBACK_ORIGINS,
        ...LOCAL_ORIGINS,
        ...(WEBAPP_ORIGIN ? [WEBAPP_ORIGIN] : []),
      ]);

      const ok = allowed.has(origin);
      return cb(ok ? null : new Error(`CORS blocked for ${origin}`), ok);
    },
  })
);

// Корень
app.get("/", (_req, res) => {
  res.type("text/plain").send("OK. Try /health or /meta");
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// meta (НИКОГДА не падает)
app.get("/meta", (_req, res) => {
  const allowed = [
    ...(WEBAPP_ORIGIN ? [WEBAPP_ORIGIN] : []),
    ...FALLBACK_ORIGINS,
    ...LOCAL_ORIGINS,
  ];

  res.json({
    channel_username: CHANNEL_USERNAME || null,
    chat_url: CHAT_URL || null,
    webapp_url: WEBAPP_URL_RAW || null,
    webapp_origin: WEBAPP_ORIGIN || null,
    allowed_origins: allowed,
  });
});

// lessons: GET /lessons?section=prep|steam
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

  res.json({
    section,
    items: rows.map((r) => ({
      ...r,
      post_url: postUrl(r.message_id),
    })),
  });
});

// links
app.get("/links", (_req, res) => {
  const rows = db
    .prepare("SELECT title, url, ord FROM links ORDER BY ord ASC, id ASC")
    .all();
  res.json({ items: rows });
});

// news
app.get("/news", (_req, res) => {
  const rows = db
    .prepare("SELECT message_id, created_at FROM news ORDER BY id DESC LIMIT 200")
    .all() as Array<{ message_id: number; created_at: string }>;

  res.json({
    items: rows.map((r) => ({
      ...r,
      post_url: postUrl(r.message_id),
    })),
  });
});

// progress: GET /progress?user_id=123
app.get("/progress", (req, res) => {
  const userId = Number(req.query.user_id);
  if (!userId) return res.status(400).json({ error: "user_id required" });

  const rows = db
    .prepare("SELECT section, ord, updated_at FROM progress WHERE user_id=?")
    .all(userId) as Array<{
    section: "prep" | "steam";
    ord: number;
    updated_at: string;
  }>;

  const items = rows.map((p) => {
    const lesson = db
      .prepare("SELECT title, message_id FROM lessons WHERE section=? AND ord=?")
      .get(p.section, p.ord) as
      | { title: string; message_id: number }
      | undefined;

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
  console.log(`API started on port ${PORT}`);
  console.log(`WEBAPP_URL=${WEBAPP_URL_RAW || "(empty)"}`);
  console.log(`WEBAPP_ORIGIN=${WEBAPP_ORIGIN || "(empty)"}`);
});
