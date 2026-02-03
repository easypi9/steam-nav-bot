import "dotenv/config";
import express from "express";
import cors from "cors";
import { db } from "./db.js";

// Railway обычно задаёт PORT сам
const PORT = Number(process.env.PORT || process.env.API_PORT || 3000);

// WebApp URL (GitHub Pages)
const WEBAPP_URL = (process.env.WEBAPP_URL || "").trim();
const WEBAPP_ORIGIN = WEBAPP_URL ? new URL(WEBAPP_URL).origin : "";

// Фолбэк: разрешим твой GitHub Pages origin даже если WEBAPP_URL не задан
const FALLBACK_ORIGINS = ["https://easypi9.github.io"];

// Local dev
const LOCAL_ORIGINS = ["http://127.0.0.1:8080", "http://localhost:8080"];

// Channel + chat for links
const CHANNEL_USERNAME = (process.env.CHANNEL_USERNAME || "").trim();
const CHAT_URL = (process.env.CHAT_URL || "").trim();

// Админ-секрет для POST /admin/*
const ADMIN_SECRET = (process.env.ADMIN_SECRET || "").trim();

function postUrl(messageId: number) {
  if (!CHANNEL_USERNAME) return "";
  return `https://t.me/${CHANNEL_USERNAME}/${messageId}`;
}

function adminGuard(req: express.Request, res: express.Response): boolean {
  if (!ADMIN_SECRET) {
    res.status(500).json({ error: "ADMIN_SECRET is not set on server" });
    return false;
  }
  const got = String(req.headers["x-admin-secret"] || "");
  if (!got || got !== ADMIN_SECRET) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}

const app = express();
app.use(express.json());

// CORS
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

// Удобный корень
app.get("/", (_req, res) => {
  res.send("OK. Try /health or /meta");
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// meta
app.get("/meta", (_req, res) => {
  res.json({
    channel_username: CHANNEL_USERNAME,
    chat_url: CHAT_URL,
    webapp_url: WEBAPP_URL,
    webapp_origin: WEBAPP_ORIGIN,
    allowed_origins: [
      ...(WEBAPP_ORIGIN ? [WEBAPP_ORIGIN] : []),
      ...FALLBACK_ORIGINS,
      ...LOCAL_ORIGINS,
    ],
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
    .all(section) as Array<{ ord: number; title: string; message_id: number }>;

  res.json({
    section,
    items: rows.map((r) => ({ ...r, post_url: postUrl(r.message_id) })),
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
    items: rows.map((r) => ({ ...r, post_url: postUrl(r.message_id) })),
  });
});

// progress (GET)
app.get("/progress", (req, res) => {
  const userId = Number(req.query.user_id);
  if (!userId) return res.status(400).json({ error: "user_id required" });

  const rows = db
    .prepare("SELECT section, ord, updated_at FROM progress WHERE user_id=?")
    .all(userId) as Array<{ section: "prep" | "steam"; ord: number; updated_at: string }>;

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

// ✅ progress (POST) — НОВОЕ, для WebApp
app.post("/progress", (req, res) => {
  const user_id = Number(req.body?.user_id);
  const section = String(req.body?.section || "").trim();
  const ord = Number(req.body?.ord);

  if (!Number.isFinite(user_id) || user_id <= 0) {
    return res.status(400).json({ error: "user_id must be a positive number" });
  }
  if (section !== "prep" && section !== "steam") {
    return res.status(400).json({ error: "section must be prep|steam" });
  }
  if (!Number.isFinite(ord) || ord <= 0) {
    return res.status(400).json({ error: "ord must be a positive number" });
  }

  db.prepare(
    `INSERT OR REPLACE INTO progress(user_id, section, ord, updated_at)
     VALUES (?, ?, ?, datetime('now'))`
  ).run(user_id, section, ord);

  res.json({ ok: true });
});

/**
 * -------------------------
 * ADMIN ENDPOINTS (seed DB on Railway)
 * -------------------------
 */

// add/update lesson
// POST /admin/lesson
// body: { section: "prep"|"steam", ord: number, title: string, message_id: number }
app.post("/admin/lesson", (req, res) => {
  if (!adminGuard(req, res)) return;

  const section = String(req.body?.section || "").trim();
  const ord = Number(req.body?.ord);
  const title = String(req.body?.title || "").trim();
  const message_id = Number(req.body?.message_id);

  if ((section !== "prep" && section !== "steam") || !ord || !title || !message_id) {
    return res.status(400).json({
      error: "body must be { section: prep|steam, ord: number, title: string, message_id: number }",
    });
  }

  db.prepare(
    "INSERT OR REPLACE INTO lessons(section, ord, title, message_id) VALUES (?,?,?,?)"
  ).run(section, ord, title, message_id);

  res.json({ ok: true });
});

// add link
// POST /admin/link
// body: { title: string, url: string, ord?: number }
app.post("/admin/link", (req, res) => {
  if (!adminGuard(req, res)) return;

  const title = String(req.body?.title || "").trim();
  const url = String(req.body?.url || "").trim();
  const ord = Number(req.body?.ord || 0);

  if (!title || !url) {
    return res.status(400).json({ error: "body must be { title: string, url: string, ord?: number }" });
  }

  db.prepare("INSERT INTO links(title, url, ord) VALUES (?,?,?)").run(title, url, ord);
  res.json({ ok: true });
});

// add news by message_id
// POST /admin/news
// body: { message_id: number }
app.post("/admin/news", (req, res) => {
  if (!adminGuard(req, res)) return;

  const message_id = Number(req.body?.message_id);
  if (!message_id) return res.status(400).json({ error: "body must be { message_id: number }" });

  db.prepare("INSERT OR IGNORE INTO news(message_id) VALUES (?)").run(message_id);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`API started on port ${PORT}`);
  if (WEBAPP_ORIGIN) console.log(`CORS allowed: ${WEBAPP_ORIGIN}`);
});
