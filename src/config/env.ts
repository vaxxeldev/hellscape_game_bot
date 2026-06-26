import "dotenv/config";
import dotenv from "dotenv";
import { z } from "zod";

const csvIds = z
  .string()
  .optional()
  .transform((value, ctx) =>
    (value ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const id = Number(part);
        if (!Number.isInteger(id)) {
          ctx.addIssue({ code: "custom", message: `Expected numeric Telegram ID, got "${part}"` });
          return z.NEVER;
        }
        return id;
      }),
  );

const optionalNumber = z
  .string()
  .optional()
  .transform((value, ctx) => {
    const trimmed = (value ?? "").trim();
    if (!trimmed) return undefined;
    const id = Number(trimmed);
    if (!Number.isFinite(id)) {
      ctx.addIssue({ code: "custom", message: "Expected a numeric Telegram ID" });
      return z.NEVER;
    }
    return id;
  });

const schema = z.object({
  GAME_BOT_TOKEN: z.string().optional(),
  BOT_TOKEN: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  API_TOKEN: z.string().optional(),
  OWNER_ID: z.coerce.number().int(),
  ADMIN_IDS: csvIds,
  MAIN_CHAT_ID: optionalNumber,
  DEVELOPER_ID: optionalNumber,
  DEVELOPER_USERNAME: z.string().optional().or(z.literal("")),
  DATABASE_URL: z.string().default("file:./data/game_bot.sqlite"),
  TELEGRAM_API_ROOT: z.string().url().default("https://api.telegram.org"),
  TELEGRAM_PROXY_URL: z.string().url().optional().or(z.literal("")),
  LAUNCH_RETRY_SECONDS: z.coerce.number().int().positive().default(15),
});

export type AppConfig = ReturnType<typeof loadConfig>;

let currentConfig = parseConfig();

function parseConfig() {
  const parsed = schema.parse(process.env);
  const botToken = parsed.GAME_BOT_TOKEN ?? parsed.BOT_TOKEN ?? parsed.TELEGRAM_BOT_TOKEN ?? parsed.API_TOKEN;
  if (!botToken) throw new Error("Set GAME_BOT_TOKEN or BOT_TOKEN environment variable");
  const adminIds = new Set<number>([parsed.OWNER_ID, ...parsed.ADMIN_IDS]);
  if (parsed.DEVELOPER_ID) adminIds.add(parsed.DEVELOPER_ID);

  return {
    botToken,
    ownerId: parsed.OWNER_ID,
    adminIds,
    mainChatId: parsed.MAIN_CHAT_ID,
    developerId: parsed.DEVELOPER_ID,
    developerUsername: parsed.DEVELOPER_USERNAME || undefined,
    databaseUrl: parsed.DATABASE_URL,
    telegramApiRoot: parsed.TELEGRAM_API_ROOT,
    telegramProxyUrl: parsed.TELEGRAM_PROXY_URL || undefined,
    launchRetrySeconds: parsed.LAUNCH_RETRY_SECONDS,
  };
}

export function loadConfig() {
  return currentConfig;
}

export function reloadConfig() {
  dotenv.config({ override: true });
  currentConfig = parseConfig();
  return currentConfig;
}
