import "dotenv/config";
import "./api.js";

import { Telegraf, Markup } from "telegraf";

const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
if (!BOT_TOKEN) throw new Error("BOT_TOKEN is required");

const WEBAPP_URL = (process.env.WEBAPP_URL || "").trim();
const CHANNEL_USERNAME = (process.env.CHANNEL_USERNAME || "").trim();
const CHAT_URL = (process.env.CHAT_URL || "").trim();
const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter(Boolean);

function isAdmin(userId?: number) {
  return !!userId && ADMIN_IDS.includes(userId);
}

const webappMain = WEBAPP_URL || "https://easypi9.github.io/steam-nav-bot/";

function webappSectionUrl(section: "prep" | "steam" | "news" | "links") {
  if (!WEBAPP_URL) return "";
  const base = WEBAPP_URL.endsWith("/") ? WEBAPP_URL : WEBAPP_URL + "/";
  return `${base}#${section}`;
}

const bot = new Telegraf(BOT_TOKEN);

bot.start(async (ctx) => {
  const userId = ctx.from?.id;

  const buttons: any[] = [];

  buttons.push(Markup.button.webApp("📱 Открыть каталог", webappMain));
  buttons.push(
    Markup.button.webApp(
      "🧩 Подготовительный курс",
      webappSectionUrl("prep") || webappMain
    )
  );
  buttons.push(
    Markup.button.webApp(
      "🚀 Курс STEAM",
      webappSectionUrl("steam") || webappMain
    )
  );
  buttons.push(
    Markup.button.webApp("🗞 Новости", webappSectionUrl("news") || webappMain)
  );
  buttons.push(
    Markup.button.webApp(
      "🔗 Полезные ссылки",
      webappSectionUrl("links") || webappMain
    )
  );

  if (CHAT_URL) buttons.push(Markup.button.url("💬 Чат-обсуждение", CHAT_URL));
  if (CHANNEL_USERNAME)
    buttons.push(
      Markup.button.url("📣 Канал", `https://t.me/${CHANNEL_USERNAME}`)
    );

  if (isAdmin(userId))
    buttons.push(Markup.button.callback("🛠 Админ-панель", "admin_stub"));

  const kb = Markup.inlineKeyboard(buttons, { columns: 2 });

  await ctx.reply("Привет! Выбери раздел:", kb);
});

bot.action("admin_stub", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply("Админ-панель: скоро добавим функции ✅");
});

bot.catch((err) => console.error("BOT ERROR:", err));

bot.launch().then(() => console.log("Bot launched ✅"));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
