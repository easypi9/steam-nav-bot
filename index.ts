import "dotenv/config";
import { Telegraf, Markup } from "telegraf";
import { db } from "./db.js";

//
// ENV
//
const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
if (!BOT_TOKEN) throw new Error("BOT_TOKEN is required");

const WEBAPP_URL = (process.env.WEBAPP_URL || "").trim();
const CHANNEL_USERNAME = (process.env.CHANNEL_USERNAME || "").trim();
const CHAT_URL = (process.env.CHAT_URL || "").trim();

const ADMIN_IDS = String(process.env.ADMIN_IDS || "")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

function isAdmin(userId?: number) {
  return !!userId && ADMIN_IDS.includes(userId);
}

function postUrl(messageId: number) {
  if (!CHANNEL_USERNAME) return "";
  return `https://t.me/${CHANNEL_USERNAME}/${messageId}`;
}

const webappMain = WEBAPP_URL || "https://easypi9.github.io/steam-nav-bot/";

function webappSectionUrl(section: "prep" | "steam" | "news" | "links") {
  const base = (WEBAPP_URL || webappMain).endsWith("/")
    ? (WEBAPP_URL || webappMain)
    : (WEBAPP_URL || webappMain) + "/";
  return `${base}#${section}`;
}

//
// BOT
//
const bot = new Telegraf(BOT_TOKEN);

type Pending =
  | { kind: "await_lesson_meta"; section: "prep" | "steam" }
  | { kind: "await_lesson_forward"; section: "prep" | "steam"; ord: number; title: string }
  | { kind: "await_news_forward" }
  | null;

const pendingByUser = new Map<number, Pending>();

//
// Keyboards
//
function startKeyboard(userId?: number) {
  const rows: any[] = [];

  // ✅ A4: Continue button
  rows.push([Markup.button.callback("▶️ Продолжить обучение", "continue")]);

  rows.push([
    Markup.button.webApp("📱 Открыть каталог", webappMain),
    Markup.button.webApp("🧩 Подготовительный", webappSectionUrl("prep")),
  ]);

  rows.push([
    Markup.button.webApp("🚀 Курс STEAM", webappSectionUrl("steam")),
    Markup.button.webApp("🗞 Новости", webappSectionUrl("news")),
  ]);

  rows.push([Markup.button.webApp("🔗 Полезные ссылки", webappSectionUrl("links"))]);

  if (CHAT_URL) rows.push([Markup.button.url("💬 Чат-обсуждение", CHAT_URL)]);
  if (CHANNEL_USERNAME)
    rows.push([Markup.button.url("📣 Канал", `https://t.me/${CHANNEL_USERNAME}`)]);

  if (isAdmin(userId)) rows.push([Markup.button.callback("🛠 Админ-панель", "admin:open")]);

  return Markup.inlineKeyboard(rows);
}

function adminKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("➕ Урок (prep)", "admin:add:prep"),
      Markup.button.callback("➕ Урок (steam)", "admin:add:steam"),
    ],
    [
      Markup.button.callback("📰 Новость (форвардом)", "admin:addnews"),
      Markup.button.callback("📋 Список (prep)", "admin:list:prep"),
    ],
    [
      Markup.button.callback("📋 Список (steam)", "admin:list:steam"),
      Markup.button.callback("❌ Отмена", "admin:cancel"),
    ],
  ]);
}

//
// Helpers
//
function extractForwardedChannelMessageId(ctx: any): number | null {
  const msg = ctx.message;
  const mid = Number(msg?.forward_from_message_id || 0);
  if (Number.isFinite(mid) && mid > 0) return mid;
  return null;
}

function extractForwardedChannelUsername(ctx: any): string {
  const msg = ctx.message;
  const u = msg?.forward_from_chat?.username;
  return typeof u === "string" ? u : "";
}

function formatLessonList(section: "prep" | "steam") {
  const rows = db
    .prepare("SELECT ord, title, message_id FROM lessons WHERE section=? ORDER BY ord ASC")
    .all(section) as Array<{ ord: number; title: string; message_id: number }>;

  if (!rows.length) return `Уроков в ${section} пока нет.`;

  return rows.map((r) => `${r.ord}. ${r.title}\n${postUrl(r.message_id)}`).join("\n\n");
}

// ✅ A4: read progress
function getProgress(userId: number) {
  return db
    .prepare("SELECT section, ord, updated_at FROM progress WHERE user_id=?")
    .all(userId) as Array<{ section: "prep" | "steam"; ord: number; updated_at: string }>;
}

// ✅ A4: continue handler
async function handleContinue(ctx: any) {
  const uid = ctx.from?.id;
  if (!uid) return;

  const progress = getProgress(uid);

  if (!progress.length) {
    await ctx.reply(
      [
        "Пока нет прогресса.",
        "Открой любой урок в WebApp — и он запомнит, где ты остановился 👌",
        "",
        "Нажми «📱 Открыть каталог» и выбери урок.",
      ].join("\n"),
      startKeyboard(uid)
    );
    return;
  }

  // For stable order: prep first, then steam
  const order: Array<"prep" | "steam"> = ["prep", "steam"];
  const sorted = [...progress].sort(
    (a, b) => order.indexOf(a.section) - order.indexOf(b.section)
  );

  const lines: string[] = [];
  const rows: any[] = [];

  for (const p of sorted) {
    const lesson = db
      .prepare("SELECT title, message_id FROM lessons WHERE section=? AND ord=?")
      .get(p.section, p.ord) as { title: string; message_id: number } | undefined;

    const sectionLabel = p.section === "prep" ? "🧩 Подготовительный" : "🚀 STEAM";

    if (!lesson) {
      lines.push(`${sectionLabel}: урок ${p.ord} (в БД уроков не найден)`);

      rows.push([
        Markup.button.webApp(
          `📱 Открыть каталог (${p.section})`,
          webappSectionUrl(p.section)
        ),
      ]);
      continue;
    }

    lines.push(`${sectionLabel}: ${p.ord}. ${lesson.title}`);

    const url = postUrl(lesson.message_id) || "https://t.me";
    rows.push([Markup.button.url(`🔎 Открыть урок (${p.section})`, url)]);
    rows.push([
      Markup.button.webApp(`📱 Открыть каталог (${p.section})`, webappSectionUrl(p.section)),
    ]);
  }

  // footer actions
  rows.push([Markup.button.webApp("📱 Открыть каталог", webappMain)]);
  rows.push([Markup.button.callback("🏠 Меню", "home")]);

  await ctx.reply(["▶️ Продолжить обучение", "", ...lines].join("\n"), Markup.inlineKeyboard(rows));
}

//
// Commands
//
bot.start(async (ctx) => {
  const uid = ctx.from?.id;
  pendingByUser.set(uid!, null);
  await ctx.reply("Привет! Выбери раздел:", startKeyboard(uid));
});

bot.command("whoami", async (ctx) => {
  await ctx.reply(`Твой user id: ${ctx.from.id}`);
});

// ✅ A4: /continue
bot.command("continue", async (ctx) => {
  await handleContinue(ctx);
});

// ✅ A4: Continue button
bot.action("continue", async (ctx) => {
  await ctx.answerCbQuery();
  await handleContinue(ctx);
});

// ✅ A4: Home button
bot.action("home", async (ctx) => {
  const uid = ctx.from?.id;
  await ctx.answerCbQuery();
  await ctx.reply("Меню:", startKeyboard(uid));
});

bot.command("admin", async (ctx) => {
  const uid = ctx.from?.id;
  if (!isAdmin(uid)) return ctx.reply("⛔️ Нет доступа.");
  pendingByUser.set(uid!, null);
  await ctx.reply("Админ-панель:", adminKeyboard());
});

//
// Admin actions
//
bot.action("admin:open", async (ctx) => {
  const uid = ctx.from?.id;
  if (!isAdmin(uid)) return ctx.answerCbQuery("Нет доступа");
  pendingByUser.set(uid!, null);
  await ctx.answerCbQuery();
  await ctx.reply("Админ-панель:", adminKeyboard());
});

bot.action("admin:cancel", async (ctx) => {
  const uid = ctx.from?.id;
  if (!isAdmin(uid)) return ctx.answerCbQuery("Нет доступа");
  pendingByUser.set(uid!, null);
  await ctx.answerCbQuery("Отменено");
  await ctx.reply("Ок, отменил. Админ-панель:", adminKeyboard());
});

bot.action(/^admin:add:(prep|steam)$/, async (ctx) => {
  const uid = ctx.from?.id;
  if (!isAdmin(uid)) return ctx.answerCbQuery("Нет доступа");
  const section = ctx.match[1] as "prep" | "steam";

  pendingByUser.set(uid!, { kind: "await_lesson_meta", section });

  await ctx.answerCbQuery();
  await ctx.reply(
    [
      `Ок. Добавляем урок в раздел: ${section}`,
      "",
      "Шаг 1/2: пришли ОДНИМ сообщением:",
      "пример: 1 | Тестовый урок 1",
      "",
      "Потом я попрошу форвард поста из канала (Forward).",
    ].join("\n"),
    adminKeyboard()
  );
});

bot.action("admin:addnews", async (ctx) => {
  const uid = ctx.from?.id;
  if (!isAdmin(uid)) return ctx.answerCbQuery("Нет доступа");

  pendingByUser.set(uid!, { kind: "await_news_forward" });

  await ctx.answerCbQuery();
  await ctx.reply(
    [
      "Ок. Шаг 1/1: перешли (Forward) пост из канала, который хочешь добавить в новости.",
      "⚠️ Нужен именно форвард (Переслать), не копия.",
    ].join("\n"),
    adminKeyboard()
  );
});

bot.action(/^admin:list:(prep|steam)$/, async (ctx) => {
  const uid = ctx.from?.id;
  if (!isAdmin(uid)) return ctx.answerCbQuery("Нет доступа");
  const section = ctx.match[1] as "prep" | "steam";
  await ctx.answerCbQuery();
  await ctx.reply(formatLessonList(section), adminKeyboard());
});

//
// Message handler for admin flows
//
bot.on("message", async (ctx) => {
  const uid = ctx.from?.id;
  if (!isAdmin(uid)) return;

  const pending = pendingByUser.get(uid!) || null;
  if (!pending) return;

  // 1) waiting for "ord | title"
  if (pending.kind === "await_lesson_meta") {
    const text = String((ctx.message as any)?.text || "").trim();

    // parse: "1 | Title"
    const m = text.match(/^(\d+)\s*\|\s*(.+)$/);
    if (!m) {
      await ctx.reply(
        ["❌ Неверный формат.", "Нужно так: 1 | Название урока", "Попробуй ещё раз."].join(
          "\n"
        ),
        adminKeyboard()
      );
      return;
    }

    const ord = Number(m[1]);
    const title = String(m[2] || "").trim();
    if (!Number.isFinite(ord) || ord <= 0 || !title) {
      await ctx.reply("❌ ord должен быть > 0 и название не пустое.", adminKeyboard());
      return;
    }

    pendingByUser.set(uid!, {
      kind: "await_lesson_forward",
      section: pending.section,
      ord,
      title,
    });

    await ctx.reply(
      [
        "Ок, понял параметры ✅",
        `section=${pending.section}, ord=${ord}`,
        `title=${title}`,
        "",
        "Шаг 2/2: теперь перешли (Forward) соответствующий пост из канала — я возьму message_id.",
        "⚠️ Важно: именно форвард (Переслать), не копия.",
      ].join("\n"),
      adminKeyboard()
    );
    return;
  }

  // 2) waiting for forward for lesson/news
  const forwardedId = extractForwardedChannelMessageId(ctx);
  const fwdUsername = extractForwardedChannelUsername(ctx);

  if (!forwardedId) {
    await ctx.reply(
      [
        "❌ Я не вижу message_id форварда (forward_from_message_id).",
        "Скорее всего ты переслал как копию или не из канала.",
        "",
        "Сделай так:",
        "1) открой нужный пост прямо в канале",
        "2) нажми «Переслать» (Forward), НЕ «копировать/без подписи»",
        "3) пришли сюда",
      ].join("\n"),
      adminKeyboard()
    );
    return;
  }

  // validate channel (если задан username)
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

  if (pending.kind === "await_lesson_forward") {
    const { section, ord, title } = pending;

    db.prepare(
      "INSERT OR REPLACE INTO lessons(section, ord, title, message_id) VALUES (?,?,?,?)"
    ).run(section, ord, title, forwardedId);

    pendingByUser.set(uid!, null);

    const openPost = postUrl(forwardedId) || "https://t.me";
    const kb = Markup.inlineKeyboard([
      [Markup.button.url("🔎 Открыть пост", openPost)],
      [Markup.button.webApp("📱 Открыть WebApp (раздел)", webappSectionUrl(section))],
      [Markup.button.callback("🛠 Админ-панель", "admin:open")],
    ]);

    await ctx.reply(["✅ Урок добавлен:", `${section} / ${ord}`, title].join("\n"), kb);
    return;
  }

  if (pending.kind === "await_news_forward") {
    db.prepare("INSERT INTO news(message_id) VALUES (?)").run(forwardedId);
    pendingByUser.set(uid!, null);

    const openPost = postUrl(forwardedId) || "https://t.me";
    const kb = Markup.inlineKeyboard([
      [Markup.button.url("🔎 Открыть пост", openPost)],
      [Markup.button.webApp("🗞 Открыть Новости (WebApp)", webappSectionUrl("news"))],
      [Markup.button.callback("🛠 Админ-панель", "admin:open")],
    ]);

    await ctx.reply("✅ Новость добавлена.", kb);
    return;
  }
});

bot.catch((err) => console.error("BOT ERROR:", err));

bot.launch().then(() => console.log("Bot launched ✅"));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
