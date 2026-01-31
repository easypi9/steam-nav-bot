import "dotenv/config";
import express from "express";
import cors from "cors";
import { db } from "./db.js";

/**
 * Railway всегда прокидывает PORT
 */
const PORT = Number(process.env.PORT || process.env.API_PORT || 3000);

/**
 * WebApp (GitHub Pages)
 */
const WEBAPP_URL = (process.env.WEBAPP_URL || "").trim();
const WEBAPP_ORIGIN = WEBAPP_URL ? new URL(WEBAPP_URL).origin : "";

/**
 * Allowed origins
 */
const FALLBACK_ORIGINS = ["https://easypi9.github.io"];
const LOCAL_ORIGINS = ["http://127.0.0.1:8080", "http://localhost:8080"];

/**
 * Channel data
 */
const CHANNEL_USERNAME = (process.env.CHANNEL_USERNAME || "").trim();
const CHAT_URL = (process.env.CHAT_URL || "").trim();

function postUrl(messageId: number) {
  if (!CHANNEL_USERNAME) return null;
  return `https://t.me/${CHANNEL_USERNAME}/${messageId}`;
}

const app = express();
app.use(express.json());

/**
 * CORS
 */
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);

      const allowed = [
        ...(WEBAPP_ORIGIN ? [WEBAPP_ORIGIN] : []),
        ...FALLBACK_ORIGINS,
        ...LOCAL_ORIGINS,
      ];

      const ok = allowed.includes(origin);
      return cb(ok ? null : new Error(`CORS blocked: ${origin}`), ok);
    },
  })
);

/**
 * Root
 */
app.get("/", (_req, res) => {
  res.status(200).send("OK. Try /health or /meta");
});

/**
 * Healthcheck
 */
app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

/**
 * Meta
 */
app.get("/meta", (_req, res) => {
  res.status(200).json({
    channel_username: CHANNEL_USERNAME,
    chat_url: CHAT_URL,
    webapp_origin: WEBAPP_ORIGIN,
    allowed_origins: [
      ...(WEBAPP_ORIGI‍N ? [WEBAPP_ORIGIN] : []),
      ...FALLBACK_ORIGINS,
      ...LOCAL_ORIGINS,
    ],
    port: PORT,
  });
});

/**
 * Lessons
 */
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

/**
 * Links
 */
app.get("/links", (_req, res) => {
  const rows = db
    .prepare("SELECT title, url, ord FROM links ORDER BY ord ASC, id ASC")
    .all();
  res.json({ items: rows });
});

/**
 * News
 */
app.get("/news", (_req, res) => {
  const rows = db
    .prepare("SELECT message_id, created_at FROM news ORDER BY id DESC LIMIT 200")
    .all() as Array<{ message_id: number; created_at: string }>;

  res.json({
    items: rows.map((r) => ({ ...r, post_url: postUrl(r.message_id) })),
  });
});

/**
 * Progress
 */
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
      title: lesson?.title ?? null,
      message_id: lesson?.message_id ?? null,
      post_url: lesson?.message_id ? postUrl(lesson.message_id) : null,
    };
  });

  res.json({ user_id: userId, items });
});

/**
 * IMPORTANT for Railway:
 * - bind to 0.0.0.0
 * - log address
 */
const server = app.listen(PORT, "0.0.0.0", () => {
  const addr = server.address();
  console.log("API started:", addr);
  console.log(`PORT env: ${process.env.PORT}`);
  console.log(`WEBAPP_ORIGIN: ${WEBAPP_ORIGIN || "(empty)"}`);
});

/**
 * Better crash visibility
 */
process.on("uncaughtException", (e) => console.error("uncaughtException", e));
process.on("unhandledRejection", (e) => console.error("unhandledRejection", e));
