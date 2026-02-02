import "dotenv/config";
import { Telegraf, Markup } from "telegraf";
import { db } from "./db.js";

/**
 * ВАЖНО:
 * API (express) запускается отдельным процессом через scripts/start:
 *   "start": "sh -c \"node dist/api.js & node dist/index.js\""
 * Поэтому здесь НЕ импортируем api.js, чтобы не стартовать API дважды.
 */

// ===== ENV =====
const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
if (!BOT_TOKEN) throw new Error("BOT_TOKEN is required");

const CHANNEL_USERNAME = (process.env.CHANNEL_USERNAME || "").trim();
const CHAT_URL = (process.env.CHAT_URL || "").trim();
const WEBAPP_URL = (process.env.WEBAPP_URL || "").trim();

const ADMIN_IDS = new Set<number>(
  (process.env.ADMIN_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n > 0)
);

// ===== HELPERS =====
type Section = "prep" | "steam";
type PendingAction =
  | { type: "add_lesson"; section: Section; ord: number; title: string }
  | { type: "add_news" };

const pendingByAdmin = new Map<number, PendingAction>();

function isAdmin(userId?: number) {
  if (!userId) return false;
  return ADMIN_IDS.has(userId);
}

function postUrl(messageId: number) {
  if (!CHANNEL_USERNAME) return "";
  return `https://t.me/${CHANNEL_USERNAME}/${messageId}`;
}

function normalizeSection(s: string): Section | null {
  const v = (s || "").trim().toLowerCase();
  if (v === "prep" || v === "steam") return v;
  return null;
}

function parseCommandArgs(text: string) {
  // "/cmd a b c" -> ["a","b","c"]
  return text
    .replace(/^\S+\s*/g, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Парсинг формата:
 * /add_lesson prep 1 Тестовый урок
 * или
 * /add_lesson prep 1 | Тестовый урок
 */
function parseAddLesson(text: string): { section: Section; ord: number; title: string } | null {
  const raw = text.trim();

  // Уберём "/add_lesson"
  const body = raw.replace(/^\/add_lesson(@\w+)?\s*/i, "").trim();
  if (!body) return null;

  // Поддержим разделитель "|" для заголовка
  // "prep 1 | Title ..." или "prep 1 Title ..."
  const pipeIdx = body.indexOf("|");
  let left = body;
  let title = "";

  if (pipeIdx >= 0) {
    left = body.slice(0, pipeIdx).trim();
    title = body.slice(pipeIdx + 1).trim();
  }

  const leftParts = left.split(/\s+/).filter(Boolean);
  if (leftParts.length < 2) return null;

  const section = normalizeSection(leftParts[0]);
  const ord = Number(leftParts[1]);

  if (!section || !Number.isFinite(ord) || ord <= 0) return null;

  if (!title) {
    // title = всё, что после section+ord
    title = leftParts.slice(2).join(" ").trim();
  }

  if (!title) title = `Урок ${ord}`;

  return { section, ord, title };
}

function getForwardedChannelMessageId(ctx: any): number | null {
  // В Telegraf v4 пересланные сообщения канала обычно лежат так:
  // ctx.message.forward_from_chat?.type === 'channel'
  // ctx.message.forward_from_message_id
  const msg = ctx.message as any;
  if (!msg) return null;

  const fchat = msg.forward_from_chat;
  const fmid = msg.forward_from_message_id;

  if (fchat && fchat.type === "channel" && typeof fmid === "number") return fmid;

  // Иногда бывает forward_origin в новых API Telegram, но Telegraf это не всегда мапит.
  return null;
}

// ===== DB ACTIONS =====
function upsertLesson(section: Section, ord: number, title: string, messageId: number) {
  db.prepare(
    `INSERT OR REPLACE INTO lessons(section, ord, title, message_id)
     VALUES (?, ?, ?, ?)`
  ).run(section, ord, title, messageId);
}

function deleteLesson(section: Section, ord: number) {
  db.prepare(`DELETE FROM lessons WHERE section=? AND ord=?`).run(section, ord);
}

function listLessons(section: Section) {
  return db
    .prepare(`SELECT ord, title, message_id FROM lessons WHERE section=? ORDER BY ord ASC`)
    .all(section) as Array<{ ord: number; title: string; message_id: number }>;
}

function addLink(title: string, url: string, ord: number) {
  db.prepare(`INSERT INTO links(title, url, ord) VALUES (?, ?, ?)`).run(title, url, ord);
}

function listLinks() {
  return db
    .prepare(`SELECT id, ord, title, url FROM links ORDER BY ord ASC, id ASC`)
    .all() as Array<{ id: number; ord: number; title: string; url: string }>;
}

function deleteLink(id: number) {
  db.prepare(`DELETE FROM links WHERE id=?`).run(id);
}

function addNews(messageId: number) {
  db.prepare(`INSERT OR IGNORE INTO news(message_id) VALUES (?)`).run(messageId);
}

function listNews(limit = 30) {
  return db
    .prepare(`SELECT message_id, created_at FROM news ORDER BY id DESC LIMIT ?`)
    .all(limit) as Array<{ message_id: number; created_at: string }>;
}

function deleteNews(messageId: number) {
  db.prepare(`DELETE FROM news WHERE message_id=?`).run(messageId);
}

// ===== BOT UI =====
const bot = new Telegraf(BOT_TOKEN);

function mainKeyboard() {
  const webappMain = WEBAPP_URL || "https://easypi9.github.io/steam-nav-bot/";
  const sectionUrl = (section: string) => {
    if (!WEBAPP_URL) return "";
    const u = new URL(WEBAPP_URL);
    u.searchParams.set("section", section);
    return u.toString();
  };

  return Markup.inlineKeyboard([
    [Markup.button.webApp("📱 Открыть каталог", webappMain)],
    [
      Markup.button.webApp("🧩 Подготовительный курс", sectionUrl("prep") || webappMain),
      Markup.button.webApp("🚀 Курс STEAM", sectionUrl("steam") || webappMain),
    ],
    [
      Markup.button.webApp("🗞 Новости", sectionUrl("news") || webappMain),
      Markup.button.webApp("🔗 Полезные ссылки", sectionUrl("links") || webappMain),
    ],
    ...(CHAT_URL ? [[Markup.button.url("💬 Чат-обсуждение", CHAT_URL)]] : []),
    ...(CHANNEL_USERNAME ? [[Markup.button.url("📣 Канал", `https://t.me/${CHANNEL_USERNAME}`)]] : []),
    [Markup.button.callback("🛠 Админ-панель", "admin_menu")],
  ]);
}

function adminKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("➕ Урок (prep)", "admin_addlesson_prep")],
    [Markup.button.callback("➕ Урок (steam)", "admin_addlesson_steam")],
    [Markup.button.callback("🗞 Добавить новость (пересылкой)", "admin_addnews")],
    [Markup.button.callback("📋 Список уроков prep", "admin_list_prep")],
    [Markup.button.callback("📋 Список уроков steam", "admin_list_steam")],
    [Markup.button.callback("🔗 Список ссылок", "admin_list_links")],
    [Markup.button.callback("🧾 Список новостей", "admin_list_news")],
    [Markup.button.callback("⬅️ Назад", "admin_back")],
  ]);
}

// ===== COMMANDS =====
bot.start(async (ctx) => {
  await ctx.reply(
    "Привет! Это навигационный бот.\nНажми кнопку ниже, чтобы открыть WebApp.",
    mainKeyboard()
  );
});

bot.command("admin", async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.reply("Нет доступа.");
  return ctx.reply(
    "Админ-панель.\n\nДобавление урока: /add_lesson prep 1 | Название\nДальше перешли пост из канала — бот возьмёт message_id.",
    adminKeyboard()
  );
});

/**
 * /add_lesson prep 1 | Тестовый урок
 * Затем переслать пост из канала (не ссылку, а пересылку).
 */
bot.command("add_lesson", async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.reply("Нет доступа.");

  const parsed = parseAddLesson(ctx.message.text);
  if (!parsed) {
    return ctx.reply(
      "Формат:\n/add_lesson prep 1 | Название урока\nили\n/add_lesson steam 3 Название урока\n\nПосле этого перешли пост из канала (Forward)."
    );
  }

  pendingByAdmin.set(ctx.from!.id, { type: "add_lesson", ...parsed });

  return ctx.reply(
    `Ок. Теперь перешли пост из канала.\n` +
      `Я добавлю урок:\n` +
      `• section: ${parsed.section}\n` +
      `• ord: ${parsed.ord}\n` +
      `• title: ${parsed.title}\n\n` +
      `Важно: именно ПЕРЕСЫЛКОЙ поста из канала.`,
    adminKeyboard()
  );
});

/**
 * /del_lesson prep 1
 */
bot.command("del_lesson", async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.reply("Нет доступа.");

  const args = parseCommandArgs(ctx.message.text);
  const section = normalizeSection(args[0] || "");
  const ord = Number(args[1]);

  if (!section || !Number.isFinite(ord) || ord <= 0) {
    return ctx.reply("Формат: /del_lesson prep 1");
  }

  deleteLesson(section, ord);
  return ctx.reply(`Удалил урок ${section} #${ord}.`, adminKeyboard());
});

/**
 * /list_lessons prep
 */
bot.command("list_lessons", async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.reply("Нет доступа.");

  const args = parseCommandArgs(ctx.message.text);
  const section = normalizeSection(args[0] || "");
  if (!section) return ctx.reply("Формат: /list_lessons prep");

  const rows = listLessons(section);
  if (!rows.length) return ctx.reply(`Пока пусто (${section}).`, adminKeyboard());

  const msg = rows
    .map((r) => `• ${r.ord}. ${r.title} (msg_id=${r.message_id}) ${postUrl(r.message_id)}`)
    .join("\n");

  return ctx.reply(`Уроки (${section}):\n${msg}`, adminKeyboard());
});

/**
 * /add_news
 * затем переслать пост из канала
 */
bot.command("add_news", async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.reply("Нет доступа.");
  pendingByAdmin.set(ctx.from!.id, { type: "add_news" });
  return ctx.reply(
    "Ок. Теперь перешли пост из канала — я добавлю его в новости.",
    adminKeyboard()
  );
});

/**
 * /del_news 123
 */
bot.command("del_news", async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.reply("Нет доступа.");

  const args = parseCommandArgs(ctx.message.text);
  const messageId = Number(args[0]);
  if (!Number.isFinite(messageId) || messageId <= 0) return ctx.reply("Формат: /del_news 123");

  deleteNews(messageId);
  return ctx.reply(`Удалил новость message_id=${messageId}.`, adminKeyboard());
});

/**
 * /list_news
 */
bot.command("list_news", async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.reply("Нет доступа.");

  const rows = listNews(30);
  if (!rows.length) return ctx.reply("Новостей пока нет.", adminKeyboard());

  const msg = rows
    .map((r) => `• msg_id=${r.message_id} ${postUrl(r.message_id)} (${r.created_at})`)
    .join("\n");

  return ctx.reply(`Новости (последние 30):\n${msg}`, adminKeyboard());
});

/**
 * /add_link 10 https://example.com | Название
 * или
 * /add_link 10 https://example.com Название
 */
bot.command("add_link", async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.reply("Нет доступа.");

  const raw = ctx.message.text.trim();
  const body = raw.replace(/^\/add_link(@\w+)?\s*/i, "").trim();
  if (!body) {
    return ctx.reply("Формат: /add_link 10 https://site.com | Название", adminKeyboard());
  }

  const pipeIdx = body.indexOf("|");
  let left = body;
  let title = "";

  if (pipeIdx >= 0) {
    left = body.slice(0, pipeIdx).trim();
    title = body.slice(pipeIdx + 1).trim();
  }

  const parts = left.split(/\s+/).filter(Boolean);
  const ord = Number(parts[0]);
  const url = parts[1];

  if (!Number.isFinite(ord) || ord < 0 || !url) {
    return ctx.reply("Формат: /add_link 10 https://site.com | Название", adminKeyboard());
  }

  if (!title) title = parts.slice(2).join(" ").trim();
  if (!title) title = url;

  addLink(title, url, ord);
  return ctx.reply(`Добавил ссылку: [${ord}] ${title} -> ${url}`, adminKeyboard());
});

/**
 * /list_links
 */
bot.command("list_links", async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.reply("Нет доступа.");

  const rows = listLinks();
  if (!rows.length) return ctx.reply("Ссылок пока нет.", adminKeyboard());

  const msg = rows.map((r) => `• id=${r.id} [${r.ord}] ${r.title} -> ${r.url}`).join("\n");
  return ctx.reply(`Ссылки:\n${msg}`, adminKeyboard());
});

/**
 * /del_link 5
 */
bot.command("del_link", async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.reply("Нет доступа.");

  const args = parseCommandArgs(ctx.message.text);
  const id = Number(args[0]);
  if (!Number.isFinite(id) || id <= 0) return ctx.reply("Формат: /del_link 5", adminKeyboard());

  deleteLink(id);
  return ctx.reply(`Удалил ссылку id=${id}.`, adminKeyboard());
});

/**
 * Удобная команда: /whoami
 */
bot.command("whoami", async (ctx) => {
  const id = ctx.from?.id;
  return ctx.reply(`Ваш user_id: ${id}`);
});

// ===== CALLBACKS (ADMIN MENU) =====
bot.action("admin_menu", async (ctx) => {
  if (!isAdmin(ctx.from?.id)) {
    await ctx.answerCbQuery("Нет доступа", { show_alert: true });
    return;
  }
  await ctx.answerCbQuery();
  return ctx.reply("Админ-панель:", adminKeyboard());
});

bot.action("admin_back", async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.reply("Главное меню:", mainKeyboard());
});

bot.action("admin_addlesson_prep", async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery("Нет доступа", { show_alert: true });
  await ctx.answerCbQuery();
  return ctx.reply(
    "Команда:\n/add_lesson prep 1 | Название урока\nЗатем перешли пост из канала (Forward).",
    adminKeyboard()
  );
});

bot.action("admin_addlesson_steam", async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery("Нет доступа", { show_alert: true });
  await ctx.answerCbQuery();
  return ctx.reply(
    "Команда:\n/add_lesson steam 1 | Название урока\nЗатем перешли пост из канала (Forward).",
    adminKeyboard()
  );
});

bot.action("admin_addnews", async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery("Нет доступа", { show_alert: true });
  await ctx.answerCbQuery();
  pendingByAdmin.set(ctx.from!.id, { type: "add_news" });
  return ctx.reply("Ок. Перешли пост из канала — добавлю как новость.", adminKeyboard());
});

bot.action("admin_list_prep", async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery("Нет доступа", { show_alert: true });
  await ctx.answerCbQuery();
  const rows = listLessons("prep");
  if (!rows.length) return ctx.reply("Уроки (prep) пока пусто.", adminKeyboard());
  const msg = rows
    .map((r) => `• ${r.ord}. ${r.title} (msg_id=${r.message_id}) ${postUrl(r.message_id)}`)
    .join("\n");
  return ctx.reply(`Уроки (prep):\n${msg}`, adminKeyboard());
});

bot.action("admin_list_steam", async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery("Нет доступа", { show_alert: true });
  await ctx.answerCbQuery();
  const rows = listLessons("steam");
  if (!rows.length) return ctx.reply("Уроки (steam) пока пусто.", adminKeyboard());
  const msg = rows
    .map((r) => `• ${r.ord}. ${r.title} (msg_id=${r.message_id}) ${postUrl(r.message_id)}`)
    .join("\n");
  return ctx.reply(`Уроки (steam):\n${msg}`, adminKeyboard());
});

bot.action("admin_list_links", async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery("Нет доступа", { show_alert: true });
  await ctx.answerCbQuery();
  const rows = listLinks();
  if (!rows.length) return ctx.reply("Ссылки пока пусто.", adminKeyboard());
  const msg = rows.map((r) => `• id=${r.id} [${r.ord}] ${r.title} -> ${r.url}`).join("\n");
  return ctx.reply(`Ссылки:\n${msg}`, adminKeyboard());
});

bot.action("admin_list_news", async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery("Нет доступа", { show_alert: true });
  await ctx.answerCbQuery();
  const rows = listNews(30);
  if (!rows.length) return ctx.reply("Новостей пока нет.", adminKeyboard());
  const msg = rows
    .map((r) => `• msg_id=${r.message_id} ${postUrl(r.message_id)} (${r.created_at})`)
    .join("\n");
  return ctx.reply(`Новости:\n${msg}`, adminKeyboard());
});

// ===== MESSAGE HANDLER FOR FORWARDS (ADD LESSON / ADD NEWS) =====
bot.on("message", async (ctx) => {
  const userId = ctx.from?.id;
  if (!isAdmin(userId)) return;

  const pending = pendingByAdmin.get(userId!);
  if (!pending) return;

  const forwardedMessageId = getForwardedChannelMessageId(ctx);
  if (!forwardedMessageId) {
    // Если админ в режиме ожидания пересылки, но прислал не то — подскажем.
    await ctx.reply("Я жду пересланный пост ИЗ КАНАЛА (Forward). Перешли пост ещё раз.", adminKeyboard());
    return;
  }

  try {
    if (pending.type === "add_lesson") {
      upsertLesson(pending.section, pending.ord, pending.title, forwardedMessageId);
      pendingByAdmin.delete(userId!);

      await ctx.reply(
        `✅ Урок добавлен!\n` +
          `• section: ${pending.section}\n` +
          `• ord: ${pending.ord}\n` +
          `• title: ${pending.title}\n` +
          `• message_id: ${forwardedMessageId}\n` +
          `• url: ${postUrl(forwardedMessageId)}`,
        adminKeyboard()
      );
      return;
    }

    if (pending.type === "add_news") {
      addNews(forwardedMessageId);
      pendingByAdmin.delete(userId!);

      await ctx.reply(
        `✅ Новость добавлена!\n` + `• message_id: ${forwardedMessageId}\n• url: ${postUrl(forwardedMessageId)}`,
        adminKeyboard()
      );
      return;
    }
  } catch (e: any) {
    pendingByAdmin.delete(userId!);
    await ctx.reply(`Ошибка: ${e?.message || String(e)}`, adminKeyboard());
  }
});

// ===== START =====
bot.launch().then(() => console.log("Bot started"));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
