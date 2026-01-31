import "dotenv/config";
import { Telegraf, Markup } from "telegraf";

const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN is required in .env");
}

const WEBAPP_URL_RAW = (process.env.WEBAPP_URL || "").trim(); // например: https://easypi9.github.io/steam-nav-bot/
const CHANNEL_USERNAME = (process.env.CHANNEL_USERNAME || "").trim(); // например: steamself
const CHAT_URL = (process.env.CHAT_URL || "").trim(); // например: https://t.me/chat_steamself

function normalizeWebappUrl(u: string) {
  if (!u) return "";
  // GitHub Pages обычно требует trailing slash
  return u.endsWith("/") ? u : `${u}/`;
}

const WEBAPP_URL = normalizeWebappUrl(WEBAPP_URL_RAW);

function webappSectionUrl(section: "prep" | "steam" | "news" | "links") {
  if (!WEBAPP_URL) return "";
  // В твоём webapp используется location.hash (как раньше), поэтому просто добавляем #section
  return `${WEBAPP_URL}#${section}`;
}

const bot = new Telegraf(BOT_TOKEN);

// --- UI helpers ---
function startMenuKeyboard() {
  const webappMain = WEBAPP_URL || "https://easypi9.github.io/steam-nav-bot/";

  return Markup.inlineKeyboard(
    [
      // Главная кнопка WebApp
      [Markup.button.webApp("📱 Открыть каталог", webappMain)],

      // Быстрый старт по разделам
      [
        Markup.button.webApp("🧩 Подготовительный курс", webappSectionUrl("prep") || webappMain),
        Markup.button.webApp("🚀 Курс STEAM", webappSectionUrl("steam") || webappMain),
      ],
      [
        Markup.button.webApp("🗞 Новости", webappSectionUrl("news") || webappMain),
        Markup.button.webApp("🔗 Полезные ссылки", webappSectionUrl("links") || webappMain),
      ],

      // Внешние ссылки
      ...(CHAT_URL
        ? [[Markup.button.url("💬 Чат-обсуждение", CHAT_URL)]]
        : []),

      ...(CHANNEL_USERNAME
        ? [[Markup.button.url("📣 Канал", `https://t.me/${CHANNEL_USERNAME}`)]]
        : []),

      // Админ (пока заглушка)
      [Markup.button.callback("🛠 Админ-панель", "admin_stub")],
    ],
    { columns: 2 }
  );
}

// --- Commands ---
bot.start(async (ctx) => {
  const text =
    "Привет! Выбери раздел:\n\n" +
    "📱 «Открыть каталог» — откроет WebApp внутри Telegram.\n" +
    "🧩/🚀/🗞/🔗 — откроют WebApp сразу на нужном разделе.";

  await ctx.reply(text, startMenuKeyboard());
});

bot.command("menu", async (ctx) => {
  await ctx.reply("Меню:", startMenuKeyboard());
});

// --- Callbacks ---
bot.action("admin_stub", async (ctx) => {
  try {
    await ctx.answerCbQuery("Админ-режим подключим позже 🙂", { show_alert: false });
  } catch {}
  await ctx.reply(
    "🛠 Админ-панель пока в разработке.\n" +
      "Дальше сделаем: добавление уроков/новостей/ссылок и выгрузку в SQLite + API."
  );
});

// --- Basic health / debug ---
bot.command("ping", async (ctx) => ctx.reply("pong ✅"));

bot.catch((err) => {
  console.error("BOT ERROR:", err);
});

// --- Launch ---
async function launch() {
  // Если хочешь вебхук на Railway: задай WEBHOOK_DOMAIN (https://....up.railway.app) и WEBHOOK_PATH (например /telegraf)
  const WEBHOOK_DOMAIN = (process.env.WEBHOOK_DOMAIN || "").trim(); // например: https://steam-nav-bot-production.up.railway.app
  const WEBHOOK_PATH = (process.env.WEBHOOK_PATH || "/telegraf").trim();
  const PORT = Number(process.env.PORT || 3000);

  if (WEBHOOK_DOMAIN) {
    // Вебхук-режим (подходит для Railway)
    await bot.launch({
      webhook: {
        domain: WEBHOOK_DOMAIN,
        hookPath: WEBHOOK_PATH,
        port: PORT,
      },
    });
    console.log(`Bot started (webhook): ${WEBHOOK_DOMAIN}${WEBHOOK_PATH}`);
  } else {
    // Поллинг (локально)
    await bot.launch();
    console.log("Bot started (polling)");
  }

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

launch().catch((e) => {
  console.error("Failed to launch bot:", e);
  process.exit(1);
});
