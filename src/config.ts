import { z } from "zod";

const ConfigSchema = z.object({
  port: z.number().int().positive().default(7421),
  host: z.string().default("0.0.0.0"),
  dataDir: z.string().default("data"),
  dbFile: z.string().default("data/tpix.sqlite"),
  logLevel: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  ollamaBaseUrl: z.string().url().default("http://localhost:11434"),
  claudeCommand: z.string().default("claude"),
  telegramBotToken: z.string().optional(),
  telegramUserChatId: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export const config: Config = ConfigSchema.parse({
  port: process.env.TPIX_PORT ? Number(process.env.TPIX_PORT) : undefined,
  host: process.env.TPIX_HOST,
  dataDir: process.env.TPIX_DATA_DIR,
  dbFile: process.env.TPIX_DB_FILE,
  logLevel: process.env.TPIX_LOG_LEVEL,
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL,
  claudeCommand: process.env.CLAUDE_COMMAND,
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramUserChatId: process.env.TELEGRAM_USER_CHAT_ID,
});

export const VERSION = "0.0.1";
