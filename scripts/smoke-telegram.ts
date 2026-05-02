import { Bot } from "grammy";
import { config } from "../src/config.ts";

async function main() {
  if (!config.telegramBotToken || !config.telegramUserChatId) {
    console.error("FAIL: TELEGRAM_BOT_TOKEN or TELEGRAM_USER_CHAT_ID not set in env");
    process.exit(1);
  }
  const bot = new Bot(config.telegramBotToken);
  const me = await bot.api.getMe();
  console.log("bot:", me.username, `(${me.id})`);
  const sent = await bot.api.sendMessage(
    Number(config.telegramUserChatId),
    "🤖 TPIX online — Phase 6 smoke test from your Mac.\n" +
      "Reply /start in chat to see the command list.",
  );
  console.log("message sent:", sent.message_id);
  console.log("PASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
