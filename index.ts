import "dotenv/config";
import { Telegraf, Markup } from "telegraf";
import { db } from "./db.js";

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME || "";
const CHAT_URL = process.env.CHAT_URL || "";
const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!BOT_TOKEN || !CHANNEL_USERNAME) {
  throw new Error("Нужны BOT_TOKEN и CHANNEL_USERNAME в .env");
}

const bot = new Telegraf(BOT_TOKEN);

const PER_PAGE = 6;

type Section = "prep" | "steam";

function isAdmin(ctx: any) {
  const id = String(ctx.from?.id || "");
  return ADMIN_IDS.includes(id);
}

function postUrl(messageId: number) {
  return `https://t.me/${CHANNEL_USERNAME}/${messageId}`;
}

function sectionTitle(section: Section) {
  return section === "prep" ? "🧩 Подготовительный курс" : "🚀 Курс STEAM";
}

function mainMenu(ctx: any) {
  const rows: any[] = [
    [Markup.button.callback("▶️ Продолжить обучение", "continue")],
    [Markup.button.callback("🧩 Подготовительный курс", "sec:prep:0")],
    [Markup.button.callback("🚀 Курс STEAM", "sec:steam:0")],
    [
      Markup.button.url("💬 Чат-обсуждение", CHAT_URL || "https://t.me"),
      Markup.button.callback("🗞 Новости", "news:0"),
    ],
    [Markup.button.callback("🔗 Полезные ссылки", "links:0")],
  ];

  // скрытая админ-кнопка — только админу
  if (isAdmin(ctx)) {
    rows.push([Markup.button.callback("🛠 Админ-панель", "admin")]);
  }

  return Markup.inlineKeyboard(rows);
}

// ---------- start ----------
bot.start(async (ctx) => {
  await ctx.reply("Привет! Выбери раздел:", mainMenu(ctx));
});

// ---------- whoami ----------
bot.command("whoami", async (ctx) => {
  await ctx.reply(`Твой user id: ${ctx.from.id}`);
});

// ---------- home ----------
bot.action("home", async (ctx) => {
  await ctx.editMessageText("Выбери раздел:", mainMenu(ctx));
});

// ---------- continue ----------
bot.action("continue", async (ctx) => {
  const userId = Number(ctx.from?.id);
  const rows = db
    .prepare("SELECT section, ord FROM progress WHERE user_id=?")
    .all(userId) as Array<{ section: Section; ord: number }>;

  if (rows.length === 0) {
    await ctx.editMessageText(
      "▶️ Продолжить обучение\n\nПока нет прогресса. Он появится, когда ты отметишь урок как текущий.",
      Markup.inlineKeyboard([[Markup.button.callback("🏠 В меню", "home")]])
    );
    return;
  }

  // строим кнопки "продолжить"
  const buttons: any[] = [];
  for (const r of rows) {
    const lesson = db
      .prepare("SELECT title, message_id FROM lessons WHERE section=? AND ord=?")
      .get(r.section, r.ord) as { title: string; message_id: number } | undefined;

    // Если урока нет (контент ещё не добавлен) — показываем без ссылки
    if (!lesson) {
      buttons.push([
        Markup.button.callback(
          `${sectionTitle(r.section)} — урок ${r.ord} (ещё не добавлен)`,
          "home"
        ),
      ]);
    } else {
      buttons.push([
        Markup.button.url(
          `${sectionTitle(r.section)} — ${r.ord}. ${lesson.title}`,
          postUrl(lesson.message_id)
        ),
      ]);
    }
  }

  await ctx.editMessageText(
    "▶️ Продолжить обучение\n\nТвои текущие точки прогресса:",
    Markup.inlineKeyboard([...buttons, [Markup.button.callback("🏠 В меню", "home")]])
  );
});

// ---------- admin panel ----------
bot.action("admin", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery("Нет доступа.", { show_alert: true });

  await ctx.editMessageText(
    "🛠 Админ-панель\n\nЧто хочешь сделать?",
    Markup.inlineKeyboard([
      [Markup.button.callback("📌 Показать подсказки", "admin:help")],
      [Markup.button.callback("🏠 В меню", "home")],
    ])
  );
});

bot.action("admin:help", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery("Нет доступа.", { show_alert: true });

  await ctx.editMessageText(
    "🛠 Админ-подсказки\n\n" +
      "• Добавить урок:\n" +
      "  /add_lesson prep 1 Введение | 123\n" +
      "  /add_lesson steam 1 Модуль 1 | 456\n\n" +
      "• Добавить ссылку:\n" +
      "  /add_link 1 Полезный ресурс | https://example.com\n\n" +
      "• Новости добавляются автоматически по #news (когда бот админ канала).",
    Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "admin")]])
  );
});

// ---------- sections (prep / steam) ----------
bot.action(/^sec:(prep|steam):(\d+)$/, async (ctx) => {
  const section = ctx.match[1] as Section;
  const page = Number(ctx.match[2]);

  const total = (db
    .prepare("SELECT COUNT(*) as c FROM lessons WHERE section=?")
    .get(section) as any).c as number;

  const rows = db
    .prepare(
      "SELECT ord, title, message_id FROM lessons WHERE section=? ORDER BY ord ASC LIMIT ? OFFSET ?"
    )
    .all(section, PER_PAGE, page * PER_PAGE) as Array<{
    ord: number;
    title: string;
    message_id: number;
  }>;

  const title = sectionTitle(section);

  if (total === 0) {
    await ctx.editMessageText(
      `${title}\n\nПока нет уроков в этом разделе.`,
      Markup.inlineKeyboard([[Markup.button.callback("🏠 В меню", "home")]])
    );
    return;
  }

  // Для каждого урока: кнопка открыть + кнопка "сделать текущим"
  const lessonRows: any[] = [];
  for (const r of rows) {
    lessonRows.push([
      Markup.button.url(`${r.ord}. ${r.title}`, postUrl(r.message_id)),
      Markup.button.callback("✅ Текущий", `setcur:${section}:${r.ord}`),
    ]);
  }

  const nav: any[] = [];
  if (page > 0) nav.push(Markup.button.callback("⬅️ Назад", `sec:${section}:${page - 1}`));
  if ((page + 1) * PER_PAGE < total)
    nav.push(Markup.button.callback("➡️ Далее", `sec:${section}:${page + 1}`));

  const keyboard = Markup.inlineKeyboard([
    ...lessonRows,
    ...(nav.length ? [nav] : []),
    [Markup.button.callback("🏠 В меню", "home")],
  ]);

  await ctx.editMessageText(
    `${title}\nСтраница ${page + 1} из ${Math.ceil(total / PER_PAGE)}`,
    keyboard
  );
});

// ---------- set current lesson ----------
bot.action(/^setcur:(prep|steam):(\d+)$/, async (ctx) => {
  const section = ctx.match[1] as Section;
  const ord = Number(ctx.match[2]);
  const userId = Number(ctx.from?.id);

  db.prepare(
    "INSERT INTO progress(user_id, section, ord) VALUES (?,?,?) " +
      "ON CONFLICT(user_id, section) DO UPDATE SET ord=excluded.ord, updated_at=datetime('now')"
  ).run(userId, section, ord);

  await ctx.answerCbQuery("Сохранил прогресс ✅");
});

// ---------- links ----------
bot.action(/^links:(\d+)$/, async (ctx) => {
  const page = Number(ctx.match[1]);

  const total = (db.prepare("SELECT COUNT(*) as c FROM links").get() as any)
    .c as number;

  const rows = db
    .prepare("SELECT title, url FROM links ORDER BY ord ASC, id ASC LIMIT ? OFFSET ?")
    .all(PER_PAGE, page * PER_PAGE) as Array<{ title: string; url: string }>;

  if (total === 0) {
    await ctx.editMessageText(
      `🔗 Полезные ссылки\n\nПока пусто.`,
      Markup.inlineKeyboard([[Markup.button.callback("🏠 В меню", "home")]])
    );
    return;
  }

  const linkButtons = rows.map((r) => [Markup.button.url(r.title, r.url)]);

  const nav: any[] = [];
  if (page > 0) nav.push(Markup.button.callback("⬅️ Назад", `links:${page - 1}`));
  if ((page + 1) * PER_PAGE < total)
    nav.push(Markup.button.callback("➡️ Далее", `links:${page + 1}`));

  const keyboard = Markup.inlineKeyboard([
    ...linkButtons,
    ...(nav.length ? [nav] : []),
    [Markup.button.callback("🏠 В меню", "home")],
  ]);

  await ctx.editMessageText(
    `🔗 Полезные ссылки\nСтраница ${page + 1} из ${Math.ceil(total / PER_PAGE)}`,
    keyboard
  );
});

// ---------- news ----------
bot.action(/^news:(\d+)$/, async (ctx) => {
  const page = Number(ctx.match[1]);

  const total = (db.prepare("SELECT COUNT(*) as c FROM news").get() as any)
    .c as number;

  const rows = db
    .prepare("SELECT message_id FROM news ORDER BY id DESC LIMIT ? OFFSET ?")
    .all(PER_PAGE, page * PER_PAGE) as Array<{ message_id: number }>;

  if (total === 0) {
    await ctx.editMessageText(
      `🗞 Новости\n\nПока нет новостей. Добавляй в посты хэштег #news — и бот начнёт их собирать.`,
      Markup.inlineKeyboard([[Markup.button.callback("🏠 В меню", "home")]])
    );
    return;
  }

  const newsButtons = rows.map((r, idx) => [
    Markup.button.url(
      `Новость ${page * PER_PAGE + idx + 1}`,
      postUrl(r.message_id)
    ),
  ]);

  const nav: any[] = [];
  if (page > 0) nav.push(Markup.button.callback("⬅️ Назад", `news:${page - 1}`));
  if ((page + 1) * PER_PAGE < total)
    nav.push(Markup.button.callback("➡️ Далее", `news:${page + 1}`));

  const keyboard = Markup.inlineKeyboard([
    ...newsButtons,
    ...(nav.length ? [nav] : []),
    [Markup.button.callback("🏠 В меню", "home")],
  ]);

  await ctx.editMessageText(
    `🗞 Новости\nСтраница ${page + 1} из ${Math.ceil(total / PER_PAGE)}`,
    keyboard
  );
});

// ---------- auto-index channel posts with #news ----------
bot.on("channel_post", async (ctx) => {
  const cp: any = (ctx as any).channelPost;
  const text = cp?.text || cp?.caption || "";
  const messageId = cp?.message_id as number;

  if (messageId && /#news\b/i.test(text)) {
    db.prepare("INSERT OR IGNORE INTO news(message_id) VALUES (?)").run(messageId);
  }
});

// ---------- admin: add lesson ----------
bot.command("add_lesson", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("Нет доступа.");

  const input = ctx.message.text.replace("/add_lesson", "").trim();
  if (!input) {
    return ctx.reply(
      "Формат:\n/add_lesson prep 1 Название урока | 123\nили\n/add_lesson steam 5 Тема урока | 456"
    );
  }

  const parts = input.split("|").map((s) => s.trim());
  const left = parts[0] || "";
  const msgIdStr = parts[1] || "";

  const m = left.match(/^(prep|steam)\s+(\d+)\s+(.+)$/i);
  if (!m) {
    return ctx.reply("Пример:\n/add_lesson prep 1 Введение | 123");
  }

  const section = m[1].toLowerCase();
  const ord = Number(m[2]);
  const title = m[3].trim();
  const message_id = Number(msgIdStr);

  if (!message_id || Number.isNaN(message_id)) {
    return ctx.reply(
      "Нужен message_id после `|`.\nПример: /add_lesson prep 1 Введение | 123"
    );
  }

  try {
    db.prepare("INSERT INTO lessons(section, ord, title, message_id) VALUES (?,?,?,?)")
      .run(section, ord, title, message_id);

    return ctx.reply(
      `Ок! Добавил: [${section}] ${ord}. ${title}\n${postUrl(message_id)}`
    );
  } catch (e: any) {
    if (String(e?.message || "").includes("UNIQUE")) {
      return ctx.reply("Этот номер урока уже занят. Выбери другой ord.");
    }
    return ctx.reply("Ошибка добавления. Проверь данные.");
  }
});

// ---------- admin: add link ----------
bot.command("add_link", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("Нет доступа.");

  const input = ctx.message.text.replace("/add_link", "").trim();
  const parts = input.split("|").map((s) => s.trim());

  if (parts.length !== 2) {
    return ctx.reply("Формат:\n/add_link 1 Название ссылки | https://example.com");
  }

  const left = parts[0] || "";
  const url = parts[1] || "";

  const m = left.match(/^(\d+)\s+(.+)$/);
  if (!m) return ctx.reply("Формат:\n/add_link 1 Название | https://...");

  const ord = Number(m[1]);
  const title = m[2].trim();

  db.prepare("INSERT INTO links(title, url, ord) VALUES (?,?,?)").run(title, url, ord);
  return ctx.reply(`Ок! Добавил ссылку: ${title}`);
});

// ---------- run ----------
bot.launch();
console.log("Bot started.");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
