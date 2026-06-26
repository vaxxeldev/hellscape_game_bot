import type { Telegraf } from "telegraf";
import type { AppConfig } from "../config/env.js";
import type { Repositories } from "../db/repositories.js";
import type { BotContext, UserRecord } from "../types.js";
import { noLinkPreview, parseMode } from "../bot/screens.js";
import { pe, premiumEmoji } from "../bot/premiumEmoji.js";
import { formatCinders } from "../utils/text.js";
import { logger } from "../utils/logger.js";

const inactivityDays = 3;
const penaltyPercent = 0.15;
const checkIntervalMs = 30 * 60 * 1000;
const firstRunDelayMs = 15 * 1000;

export function startInactivityPenalty(
  bot: Telegraf<BotContext>,
  repos: Repositories,
  getConfig: () => AppConfig,
) {
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;

    try {
      const cutoffIso = new Date(Date.now() - inactivityDays * 24 * 60 * 60 * 1000).toISOString();
      const excludedIds = getExcludedIds(getConfig());
      const candidates = repos
        .listUsersForInactivityPenalty(cutoffIso)
        .filter((user) => !excludedIds.has(user.telegram_id));

      for (const user of candidates) {
        const result = repos.applyInactivityPenalty(
          user.id,
          penaltyPercent,
          `Списание за неактивность ${inactivityDays} дня`,
        );
        if (!result.user || result.deducted <= 0) continue;
        await notifyUser(bot, result.user, result.deducted).catch((error) =>
          logger.warn({ error, telegramId: user.telegram_id }, "failed to notify inactive user about penalty"),
        );
      }
    } catch (error) {
      logger.error({ error }, "failed to process inactivity penalties");
    } finally {
      running = false;
    }
  };

  const firstRun = setTimeout(() => void run(), firstRunDelayMs);
  const interval = setInterval(() => void run(), checkIntervalMs);

  return () => {
    clearTimeout(firstRun);
    clearInterval(interval);
  };
}

function getExcludedIds(config: AppConfig) {
  const ids = new Set<number>(config.adminIds);
  ids.add(config.ownerId);
  if (config.developerId) ids.add(config.developerId);
  return ids;
}

async function notifyUser(bot: Telegraf<BotContext>, user: UserRecord, deducted: number) {
  await bot.telegram.sendMessage(
    user.telegram_id,
    [
      `${pe(premiumEmoji.clock, "⏰")} <b>Списание за неактивность</b>`,
      "",
      `Ты не проявлял активность в боте ${inactivityDays} дня.`,
      `Списано: <b>${formatCinders(deducted)}</b>`,
      `Текущий баланс: <b>${formatCinders(user.balance)}</b>`,
      "",
      "Чтобы избежать следующего списания, периодически открывай профиль, лавку или используй команды бота.",
    ].join("\n"),
    { parse_mode: parseMode, ...noLinkPreview } as never,
  );
}
