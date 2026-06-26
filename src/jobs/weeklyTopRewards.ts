import type { Telegraf } from "telegraf";
import type { AppConfig } from "../config/env.js";
import type { Repositories } from "../db/repositories.js";
import type { BotContext, WeeklyTopUserRecord } from "../types.js";
import { escapeHtml, formatCinders, usernameOrName } from "../utils/text.js";
import { logger } from "../utils/logger.js";
import { previousYekaterinburgWeek, type WeekPeriod } from "../utils/week.js";
import { pe, premiumEmoji } from "../bot/premiumEmoji.js";
import { noLinkPreview, parseMode } from "../bot/screens.js";

const weeklyRewards = [90, 60, 30];
const checkIntervalMs = 10 * 60 * 1000;

export function startWeeklyTopRewards(
  bot: Telegraf<BotContext>,
  repos: Repositories,
  getConfig: () => AppConfig,
) {
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;
    const period = previousYekaterinburgWeek();

    try {
      const result = repos.payWeeklyTopRewards({
        weekKey: period.weekKey,
        startIso: period.startIso,
        endIso: period.endIso,
        rewards: weeklyRewards,
      });

      const payouts = "payouts" in result ? (result.payouts ?? []) : [];
      if (result.paid && payouts.length > 0) {
        await notifyWeeklyWinners(bot, getConfig(), period, payouts);
      }
    } catch (error) {
      logger.error({ error, weekKey: period.weekKey }, "failed to process weekly top rewards");
    } finally {
      running = false;
    }
  };

  const firstRun = setTimeout(() => void run(), 5000);
  const interval = setInterval(() => void run(), checkIntervalMs);

  return () => {
    clearTimeout(firstRun);
    clearInterval(interval);
  };
}

async function notifyWeeklyWinners(
  bot: Telegraf<BotContext>,
  config: AppConfig,
  period: WeekPeriod,
  payouts: { winner: WeeklyTopUserRecord; place: number; reward: number; credited: number }[],
) {
  if (!payouts.length) return;

  const announcement = weeklyAnnouncementText(period, payouts);
  if (config.mainChatId) {
    await bot.telegram
      .sendMessage(config.mainChatId, announcement, { parse_mode: parseMode, ...noLinkPreview } as never)
      .catch((error) => logger.warn({ error, chatId: config.mainChatId }, "failed to announce weekly top rewards"));
  }

  for (const payout of payouts) {
    const { winner, place, reward, credited } = payout;
    await bot.telegram
      .sendMessage(
        winner.telegram_id,
        [
          `${pe(premiumEmoji.gift, "🎁")} <b>Награда недельного топа</b>`,
          "",
          `Ты занял <b>${place} место</b> за неделю <b>${escapeHtml(period.label)}</b>.`,
          `Результат: <b>${formatCinders(winner.weekly_score)}</b>`,
          `Начислено: <b>${formatCinders(credited)}</b>`,
          credited < reward ? `${pe(premiumEmoji.info, "ℹ")} Часть награды не поместилась в твой лимит.` : null,
        ].join("\n"),
        { parse_mode: parseMode, ...noLinkPreview } as never,
      )
      .catch((error) => logger.warn({ error, telegramId: winner.telegram_id }, "failed to notify weekly top winner"));
  }
}

function weeklyAnnouncementText(
  period: WeekPeriod,
  payouts: { winner: WeeklyTopUserRecord; place: number; reward: number; credited: number }[],
) {
  const lines = payouts.map(({ winner, place, reward, credited }) => {
    const limitNote = credited < reward ? " (уперся в лимит)" : "";
    return `${place}. ${escapeHtml(usernameOrName(winner))} - <b>${formatCinders(credited)}</b>${limitNote} за результат <b>${formatCinders(winner.weekly_score)}</b>`;
  });

  return [
    `${pe(premiumEmoji.gift, "🎁")} <b>Награды недельного топа начислены</b>`,
    "",
    `${pe(premiumEmoji.calendar, "📅")} Неделя: <b>${escapeHtml(period.label)}</b>`,
    "",
    ...lines,
  ].join("\n");
}
