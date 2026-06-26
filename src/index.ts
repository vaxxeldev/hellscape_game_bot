import { HttpsProxyAgent } from "https-proxy-agent";
import { Telegraf } from "telegraf";
import { loadConfig } from "./config/env.js";
import { GameBotHandlers } from "./bot/handlers.js";
import { Database } from "./db/database.js";
import { Repositories } from "./db/repositories.js";
import { logger } from "./utils/logger.js";
import type { BotContext } from "./types.js";
import { catalogServices } from "./services/catalog.js";
import { startWeeklyTopRewards } from "./jobs/weeklyTopRewards.js";

const config = loadConfig();
const db = new Database(config.databaseUrl);
const repos = new Repositories(db);
repos.seedCatalogServices(catalogServices);
logger.info({ databasePath: db.filePath, databaseUrl: config.databaseUrl, stats: repos.stats() }, "database ready");
const telegramAgent = config.telegramProxyUrl ? new HttpsProxyAgent(config.telegramProxyUrl) : undefined;

const bot = new Telegraf<BotContext>(config.botToken, {
  telegram: {
    apiRoot: config.telegramApiRoot,
    agent: telegramAgent,
  },
});

bot.catch((error, ctx) => {
  logger.error({ error, updateType: ctx.updateType }, "unhandled bot error");
});

new GameBotHandlers(bot, repos, loadConfig).register();
const stopWeeklyTopRewards = startWeeklyTopRewards(bot, repos, loadConfig);

await launchWithRetry();

logger.info("Flood Games Game Bot started");

async function launchWithRetry() {
  const retryMs = loadConfig().launchRetrySeconds * 1000;
  while (true) {
    try {
      await bot.launch({ allowedUpdates: ["message", "callback_query", "pre_checkout_query"] });
      return;
    } catch (error) {
      logger.error({ error, retryInSeconds: loadConfig().launchRetrySeconds }, "failed to launch bot, retrying");
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
}

function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  stopWeeklyTopRewards();
  bot.stop(signal);
  db.close();
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
