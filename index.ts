import "dotenv/config";
import express from "express";
import cors from "cors";
import Database from "better-sqlite3";
import { Telegraf, Markup } from "telegraf";

//
// ENV
//
const PORT = Number(process.env.PORT || 8080);

const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();

const CHANNEL_USERNAME = (process.env.CHANNEL_USERNAME || "").trim();
const CHAT_URL = (process.env.CHAT_URL || "").trim();

const ADMIN_IDS = String(process.env.ADMIN_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => Number(s))
  .filter((n) => Number.isFinite(n) && n > 0);

const ADMIN_SECRET = (process.env.ADMIN_SECRET || "").trim();

const WEBAPP_URL = (process.env.WEBAPP_URL || "").trim();
const WEBAPP_ORIGIN = WEBAPP_URL ? new URL(WEBAPP_URL).origin : "";

const FALLBACK_ORIGINS = ["https://easypi9.github.io"];
const LOCAL_ORIGINS = ["http://127.0.0.1:8080", "http://localhost:8080"];

//
// DB (single file for BOTH API and BOT)
//
const db = new Database("bot.db");

// init schema (idempotent)
db.exec(`
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  section TEXT NOT NULL CHECK(section IN ('prep','steam')),
  ord INTEGER NOT NULL,
  title TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  UNIQUE(section, ord)
);

CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  ord INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS news (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS progress (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  section TEXT NOT NULL CHECK(section IN ('prep','steam')),
  ord INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, section)
);
`);

function postUrl(messageId: number) {
  if (!CHANNEL_USERNAME) return "";
  return `https://t.me/${CHANNEL_USERNAME}/${messageId}`;
}

//
// API (Express)
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
    .all() as Array<{ title: string; url: string; ord: number }>;
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

// progress
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

function requireAdminSecret(req: any, res: any): boolean {
  if (!ADMIN_SECRET) {
    return res.status(500).json({ error: "ADMIN_SECRET is not set on server" });
  }
  const got = String(req.headers["x-admin-secret"] || "");
  if (got !== ADMIN_SECRET) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}

// admin: add lesson
app.post("/admin/lesson", (req, res) => {
  if (!requireAdminSecret(req, res)) return;

  const section = String(req.body?.section || "").trim();
  const ord = Number(req.body?.ord);
  const title = String(req.body?.title || "").trim();
  const message_id = Number(req.body?.message_id);

  if (section !== "prep" && section !== "steam") {
    return res.status(400).json({ error: "section must be prep|steam" });
  }
  if (!Number.isFinite(ord) || ord <= 0) return res.status(400).json({ error: "ord must be > 0" });
  if (!title) return res.status(400).json({ error: "title required" });
  if (!Number.isFinite(message_id) || message_id <= 0) {
    return res.status(400).json({ error: "message_id must be > 0" });
  }

  db.prepare(
    "INSERT OR REPLACE INTO lessons(section, ord, title, message_id) VALUES (?,?,?,?)"
  ).run(section, ord, title, message_id);

  res.json({ ok: true });
});

//
// BOT (Telegraf)
//
type Pending =
  | { kind: "add_lesson"; section: "prep" | "steam"; ord: number; title: string }
  | { kind: "add_news" }
  | null;

const pendingByUser = new Map<number, Pending>();

function isAdmin(userId?: number) {
  if (!userId) return false;
  return ADMIN_IDS.includes(userId);
}

function adminKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("➕ Урок (prep)", "admin_add_prep")],
    [Markup.button.callback("➕ Урок (steam)", "admin_add_steam")],
    [Markup.button.callback("📰 Добавить новость (пересылкой)", "admin_add_news")],
    [Markup.button.callback("📋 Список уроков prep", "admin_list_prep")],
    [Markup.button.callback("📋 Список уроков steam", "admin_list_steam")],
  ]);
}

function formatLessonList(section: "prep" | "steam") {
  const rows = db
    .prepare("SELECT ord, title, message_id FROM lessons WHERE section=? ORDER BY ord ASC")
    .all(section) as Array<{ ord: number; title: string; message_id: number }>;

  if (!rows.length) return `Уроков в ${section} пока нет.`;

  return rows
    .map((r) => `${r.ord}. ${r.title} (msg=${r.message_id})\n${postUrl(r.message_id)}`)
    .join("\n\n");
}

function extractForwardedChannelMessageId(ctx: any): number | null {
  const msg = ctx.message;
  // IMPORTANT: forward_from_message_id exists only for real forwards of channel posts
  const mid = Number(msg?.forward_from_message_id || 0);
  if (Number.isFinite(mid) && mid > 0) return mid;
  return null;
}

function extractForwardedChannelUsername(ctx: any): string {
  const msg = ctx.message;
  const u = msg?.forward_from_chat?.username;
  return typeof u === "string" ? u : "";
}

async function sendAddLessonInstruction(ctx: any, section: "prep" | "steam") {
  await ctx.reply(
    [
      "Команда:",
      `/add_lesson ${section} 1 | Название урока`,
      "",
      "Затем перешли пост из канала (Forward).",
      "⚠️ Важно: нужен именно форвард (чтобы у сообщения был forward_from_message_id).",
    ].join("\n"),
    adminKeyboard()
  );
}

if (BOT_TOKEN) {
  const bot = new Telegraf(BOT_TOKEN);

  bot.start(async (ctx) => {
    await ctx.reply(
      "Меню готово. Открой WebApp из кнопки или используй /admin (для админов)."
    );
  });

  bot.command("admin", async (ctx) => {
    const uid = ctx.from?.id;
    if (!isAdmin(uid)) return ctx.reply("⛔️ Нет доступа.");
    pendingByUser.set(uid!, null);
    await ctx.reply("Админ-панель.", adminKeyboard());
  });

  bot.action("admin_add_prep", async (ctx) => {
    const uid = ctx.from?.id;
    if (!isAdmin(uid)) return ctx.answerCbQuery("Нет доступа");
    pendingByUser.set(uid!, null);
    await ctx.answerCbQuery();
    await sendAddLessonInstruction(ctx, "prep");
  });

  bot.action("admin_add_steam", async (ctx) => {
    const uid = ctx.from?.id;
    if (!isAdmin(uid)) return ctx.answerCbQuery("Нет доступа");
    pendingByUser.set(uid!, null);
    await ctx.answerCbQuery();
    await sendAddLessonInstruction(ctx, "steam");
  });

  bot.action("admin_add_news", async (ctx) => {
    const uid = ctx.from?.id;
    if (!isAdmin(uid)) return ctx.answerCbQuery("Нет доступа");
    pendingByUser.set(uid!, { kind: "add_news" });
    await ctx.answerCbQuery();
    await ctx.reply(
      [
        "Ок. Теперь перешли (Forward) пост из канала, который хочешь добавить в новости.",
        "⚠️ Нужен форвард, не копия.",
      ].join("\n"),
      adminKeyboard()
    );
  });

  bot.action("admin_list_prep", async (ctx) => {
    const uid = ctx.from?.id;
    if (!isAdmin(uid)) return ctx.answerCbQuery("Нет доступа");
    await ctx.answerCbQuery();
    await ctx.reply(formatLessonList("prep"), adminKeyboard());
  });

  bot.action("admin_list_steam", async (ctx) => {
    const uid = ctx.from?.id;
    if (!isAdmin(uid)) return ctx.answerCbQuery("Нет доступа");
    await ctx.answerCbQuery();
    await ctx.reply(formatLessonList("steam"), adminKeyboard());
  });

  bot.command("add_lesson", async (ctx) => {
    const uid = ctx.from?.id;
    if (!isAdmin(uid)) return ctx.reply("⛔️ Нет доступа.");

    const text = String(ctx.message?.text || "");
    // expected: /add_lesson prep 1 | Title
    const m = text.match(/^\/add_lesson\s+(prep|steam)\s+(\d+)\s*\|\s*(.+)$/i);
    if (!m) {
      return ctx.reply(
        "Формат: /add_lesson prep 1 | Название урока\nПотом форвардни пост из канала."
      );
    }

    const section = m[1] as "prep" | "steam";
    const ord = Number(m[2]);
    const title = String(m[3] || "").trim();

    if (!Number.isFinite(ord) || ord <= 0) {
      return ctx.reply("ord должен быть > 0");
    }
    if (!title) {
      return ctx.reply("Название пустое");
    }

    pendingByUser.set(uid!, { kind: "add_lesson", section, ord, title });

    await ctx.reply(
      [
        "Ок, понял параметры.",
        `section=${section}, ord=${ord}`,
        `title=${title}`,
        "",
        "Теперь перешли (Forward) соответствующий пост из канала — я возьму message_id.",
      ].join("\n"),
      adminKeyboard()
    );
  });

  // Debug helper (shows what Telegram sends on forward)
  bot.command("debug_forward", async (ctx) => {
    const uid = ctx.from?.id;
    if (!isAdmin(uid)) return ctx.reply("⛔️ Нет доступа.");
    const mid = Number(ctx.message?.forward_from_message_id || 0);
    const fromChat = ctx.message?.forward_from_chat || null;
    await ctx.reply(
      "forward_from_message_id=" +
        mid +
        "\nforward_from_chat=" +
        JSON.stringify(fromChat, null, 2)
    );
  });

  bot.on("message", async (ctx) => {
    const uid = ctx.from?.id;
    if (!isAdmin(uid)) return;

    const pending = pendingByUser.get(uid!) || null;
    if (!pending) return;

    // We only react to forwards for pending actions
    const forwardedId = extractForwardedChannelMessageId(ctx);
    const fwdUsername = extractForwardedChannelUsername(ctx);

    if (!forwardedId) {
      // This is the key: give clear feedback instead of silence
      await ctx.reply(
        [
          "❌ Я не вижу message_id форварда (forward_from_message_id).",
          "Скорее всего ты переслал как копию или не из канала.",
          "",
          "Сделай так:",
          "1) открой нужный пост прямо в канале",
          "2) нажми Forward (Переслать), НЕ 'копировать/без подписи'",
          "3) пришли сюда",
          "",
          "Если хочешь — пришли любой форвард и выполни /debug_forward",
          "я покажу, что реально прилетает от Telegram.",
        ].join("\n"),
        adminKeyboard()
      );
      return;
    }

    // Optional: ensure it is from your channel (if set)
    if (CHANNEL_USERNAME && fwdUsername && fwdUsername !== CHANNEL_USERNAME) {
      await ctx.reply(
        [
          "❌ Форвард пришёл не из нужного канала.",
          `Ожидаю: ${CHANNEL_USERNAME}`,
          `Пришло: ${fwdUsername}`,
        ].join("\n"),
        adminKeyboard()
      );
      return;
    }

    if (pending.kind === "add_lesson") {
      const { section, ord, title } = pending;

      db.prepare(
        "INSERT OR REPLACE INTO lessons(section, ord, title, message_id) VALUES (?,?,?,?)"
      ).run(section, ord, title, forwardedId);

      pendingByUser.set(uid!, null);

      await ctx.reply(
        ["✅ Урок добавлен:", `${section} / ${ord}`, title, postUrl(forwardedId)].join("\n"),
        adminKeyboard()
      );
      return;
    }

    if (pending.kind === "add_news") {
      db.prepare("INSERT INTO news(message_id) VALUES (?)").run(forwardedId);
      pendingByUser.set(uid!, null);
      await ctx.reply(
        ["✅ Новость добавлена:", postUrl(forwardedId)].join("\n"),
        adminKeyboard()
      );
      return;
    }
  });

  bot.launch().then(() => console.log("BOT started"));
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
} else {
  console.log("BOT_TOKEN is empty -> bot not started");
}

app.listen(PORT, () => {
  console.log(`API started on port ${PORT}`);
  if (WEBAPP_URL) console.log(`WEBAPP_URL=${WEBAPP_URL}`);
  if (WEBAPP_ORIGIN) console.log(`WEBAPP_ORIGIN=${WEBAPP_ORIGIN}`);
});