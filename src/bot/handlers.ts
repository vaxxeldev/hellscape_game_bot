import fs from "node:fs";
import path from "node:path";
import { Input, Telegraf } from "telegraf";
import type { Message } from "telegraf/types";
import type { AppConfig } from "../config/env.js";
import type { Repositories } from "../db/repositories.js";
import type { BotContext, PromoCodeRecord, ServiceRecord, UserRecord, UserRole } from "../types.js";
import { escapeHtml, formatAmount, formatCinders, mentionUser, sanitizeDonorTitleHtml } from "../utils/text.js";
import { logger } from "../utils/logger.js";
import {
  adminKeyboard,
  adminServiceKeyboard,
  adminServicesKeyboard,
  approvalModeKeyboard,
  backAdminKeyboard,
  backHomeKeyboard,
  broadcastButtonChoiceKeyboard,
  broadcastCancelKeyboard,
  broadcastConfirmKeyboard,
  broadcastMediaKeyboard,
  cindersStarsKeyboard,
  cancelFlowKeyboard,
  compensationConfirmKeyboard,
  confirmFlowKeyboard,
  donorTitleKeyboard,
  mainMenuKeyboard,
  pendingPurchasesKeyboard,
  promoKeyboard,
  promoListKeyboard,
  profileKeyboard,
  promosMenuKeyboard,
  purchaseReviewKeyboard,
  serviceCategoriesKeyboard,
  serviceKeyboard,
  servicePricingModeKeyboard,
  servicesKeyboard,
  supportStarsKeyboard,
  titleKeyboard,
  titleListKeyboard,
  titlesMenuKeyboard,
  topKeyboard,
} from "./keyboards.js";
import {
  adminText,
  donorTitleText,
  helpText,
  homeText,
  noLinkPreview,
  parseMode,
  profileText,
  promoText,
  promosText,
  purchaseText,
  render,
  serviceText,
  servicesText,
  statsText,
  supportText,
  starsThanksText,
  topText,
  weeklyTopText,
  titleText,
  titlesText,
} from "./screens.js";
import { pe, premiumEmoji } from "./premiumEmoji.js";
import { currentYekaterinburgWeek } from "../utils/week.js";
import { freeCinderSpace, nextCinderLimitOffer } from "../services/cinderLimits.js";

type StateData = Record<string, unknown>;
type BroadcastEntity = {
  type: string;
  offset: number;
  length: number;
  custom_emoji_id?: string;
  url?: string;
  user?: unknown;
  language?: string;
};

type BroadcastMessage = {
  message_id: number;
  text?: string;
  caption?: string;
  entities?: BroadcastEntity[];
  caption_entities?: BroadcastEntity[];
  photo?: { file_id: string }[];
  video?: { file_id: string };
  animation?: { file_id: string };
};

type BroadcastData = StateData & {
  text?: string;
  entities?: BroadcastEntity[];
  photoFileId?: string | null;
  videoFileId?: string | null;
  animationFileId?: string | null;
  buttonText?: string | null;
  buttonUrl?: string | null;
  buttonEmojiId?: string | null;
  controlMessageId?: number;
  previewHeaderMessageId?: number;
  previewMessageId?: number;
  confirmMessageId?: number;
};

type CompensationData = StateData & {
  reason?: string;
  amount?: number;
};

const broadcastDelayMs = 60;
const maxEconomyAmount = 1_000_000;
const maxPromoCodeLength = 32;
const maxPromoActivations = 100_000;
const maxServiceTitleLength = 64;
const maxServiceDescriptionLength = 800;
const maxBroadcastTextLength = 4096;
const maxCompensationReasonLength = 800;
const adminServicesPerPage = 5;

const messageEffects = {
  celebration: "5046509860389126442",
  like: "5107584321108051014",
  poop: "5046589136895476101",
  fire: "5104841245755180586",
  heart: "5159385139981059251",
} as const;

type MessageEffectId = (typeof messageEffects)[keyof typeof messageEffects];

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

function starsLabel() {
  return `${pe(premiumEmoji.star, "⭐️")} Stars`;
}

export class GameBotHandlers {
  private readonly rateLimitBuckets = new Map<string, RateLimitBucket>();

  constructor(
    private readonly bot: Telegraf<BotContext>,
    private readonly repos: Repositories,
    private readonly getConfig: () => AppConfig,
  ) {}

  register() {
    this.bot.start((ctx) => this.handleStart(ctx));
    this.bot.command("admin", (ctx) => this.showAdmin(ctx));
    this.bot.on("pre_checkout_query", async (ctx) => this.handlePreCheckout(ctx));
    this.bot.on("successful_payment", async (ctx) => {
      const user = await this.ensureUser(ctx);
      const payment = ctx.message.successful_payment;
      if (payment.invoice_payload.startsWith("cinders:")) {
        await this.completeCindersStarsPurchase(ctx, user, payment);
        return;
      }

      const isNewDonation = this.repos.recordStarDonation({
        userId: user.id,
        telegramPaymentChargeId: payment.telegram_payment_charge_id,
        amount: payment.total_amount,
        payload: payment.invoice_payload,
      });
      const rewardCinders = payment.total_amount * 3;
      let creditedCinders = 0;
      if (isNewDonation) {
        creditedCinders = this.repos.adjustBalanceToLimit({
          userId: user.id,
          amount: rewardCinders,
          type: "support_reward",
          reason: `Поддержка разработчика на ${payment.total_amount} Stars`,
        }).credited;
      }
      await this.replyWithEffect(ctx, starsThanksText(payment.total_amount, creditedCinders, rewardCinders), messageEffects.heart, {
        parse_mode: parseMode,
      });
    });

    this.bot.on("callback_query", async (ctx, next) => {
      await this.ensureUser(ctx);
      if (!("data" in ctx.callbackQuery)) return next();
      await this.handleCallback(ctx, ctx.callbackQuery.data);
    });

    this.bot.on("message", async (ctx, next) => {
      const user = await this.ensureUser(ctx);
      if (await this.handleStateMessage(ctx, user)) return;
      return next();
    });

    this.bot.on("text", async (ctx) => {
      const user = await this.ensureUser(ctx);
      const text = ctx.message.text.trim();
      if (text.startsWith("/")) return;

      const stateHandled = await this.handleStateText(ctx, user, text);
      if (stateHandled) return;

      if (text.startsWith(".")) {
        await this.handleDotCommand(ctx, user, text);
      }
    });
  }

  private async handleStart(ctx: BotContext) {
    const user = await this.ensureUser(ctx);
    if (ctx.chat?.type !== "private") {
      await ctx.reply("Открой ЛС с ботом, чтобы пользоваться лавкой и профилем.");
      return;
    }

    const bannerKey = "messages_banner_gif/start_banner.mp4";
    const banner = this.resolveAsset(bannerKey);
    if (banner) {
      const message = await ctx.replyWithAnimation(this.assetMedia(bannerKey), {
        caption: homeText(user),
        parse_mode: parseMode,
        ...noLinkPreview,
        ...mainMenuKeyboard(),
      } as never);
      this.cacheAnimationFileId(bannerKey, message);
      return;
    }

    await ctx.reply(homeText(user), { parse_mode: parseMode, ...noLinkPreview, ...mainMenuKeyboard() } as never);
  }

  private async handleCallback(ctx: BotContext, data: string) {
    try {
      if (data === "msg:close") {
        await ctx.deleteMessage().catch(() => undefined);
        return;
      }
      if (data === "menu:home") return this.showHome(ctx);
      if (data === "menu:services") return this.showServices(ctx);
      if (data === "menu:profile") return this.showProfile(ctx);
      if (data === "donor_title:menu") return this.showDonorTitleMenu(ctx);
      if (data === "donor_title:set") return this.startSetDonorTitle(ctx);
      if (data === "donor_title:remove") return this.removeDonorTitle(ctx);
      if (data === "menu:help") return render(ctx, helpText(this.getConfig()), backHomeKeyboard());
      if (data === "menu:support") return this.renderWithAsset(ctx, supportText(), supportStarsKeyboard(), "messages_banner_gif/link_sending.mp4");
      if (data.startsWith("stars:")) return this.sendStarsInvoice(ctx, Number(data.split(":")[1]));
      if (data.startsWith("top:")) {
        const [, kindOrPage, pageRaw] = data.split(":");
        const kind = kindOrPage === "weekly" ? "weekly" : "balance";
        const parsedPage =
          kindOrPage === "weekly" || kindOrPage === "balance" ? Number(pageRaw ?? 0) : Number(kindOrPage ?? 0);
        const page = Number.isFinite(parsedPage) ? parsedPage : 0;
        return this.showTop(ctx, page, kind);
      }
      if (data.startsWith("svc_cat:")) {
        const [, currencyRaw, pageRaw] = data.split(":");
        if (currencyRaw === "stars") return this.startCindersStarsPurchase(ctx);
        return this.showServices(ctx, currencyRaw === "stars" ? "stars" : "cinders", Number(pageRaw ?? 0));
      }
      if (data === "cinders_stars:cancel") return this.cancelCindersStarsPurchase(ctx);
      if (data.startsWith("cinders_stars:preset:")) return this.buyCindersForStars(ctx, Number(data.split(":")[2]));
      if (data.startsWith("svc:")) return this.showService(ctx, Number(data.split(":")[1]));
      if (data.startsWith("buy:")) return this.buyService(ctx, Number(data.split(":")[1]));
      if (data === "admin:home") return this.showAdmin(ctx);
      if (data === "admin:create_service") return this.startCreateService(ctx);
      if (data === "admin:create_promo") return this.startCreatePromo(ctx);
      if (data === "admin:broadcast") return this.startBroadcast(ctx);
      if (data === "admin:compensation") return this.startCompensation(ctx);
      if (data === "admin:stats") return this.showStats(ctx);
      if (data === "admin:price_adjustment") return this.startPriceAdjustment(ctx);
      if (data === "admin:services") return this.showAdminServices(ctx);
      if (data.startsWith("admin:services:")) return this.showAdminServices(ctx, Number(data.split(":")[2]));
      if (data === "admin:purchases") return this.showPendingPurchases(ctx);
      if (data === "admin:promos") return this.showPromosMenu(ctx);
      if (data === "admin:promo_list") return this.showPromoList(ctx);
      if (data === "admin:titles") return this.showTitlesMenu(ctx);
      if (data === "admin:create_title") return this.startCreateTitle(ctx);
      if (data === "admin:title_list") return this.showTitleList(ctx);
      if (data === "admin:assign_title") return this.startAssignTitle(ctx);
      if (data === "admin:remove_title") return this.startRemoveTitle(ctx);
      if (data.startsWith("admin:service_toggle:")) return this.toggleService(ctx, Number(data.split(":")[2]), Number(data.split(":")[3] ?? 0));
      if (data.startsWith("admin:service_delete:")) return this.deleteService(ctx, Number(data.split(":")[2]), Number(data.split(":")[3] ?? 0));
      if (data.startsWith("admin:service:")) return this.showAdminService(ctx, Number(data.split(":")[2]), Number(data.split(":")[3] ?? 0));
      if (data.startsWith("admin:promo_toggle:")) return this.togglePromo(ctx, Number(data.split(":")[2]));
      if (data.startsWith("admin:promo_delete:")) return this.deletePromo(ctx, Number(data.split(":")[2]));
      if (data.startsWith("admin:promo:")) return this.showPromo(ctx, Number(data.split(":")[2]));
      if (data.startsWith("admin:title_toggle:")) return this.toggleTitle(ctx, Number(data.split(":")[2]));
      if (data.startsWith("admin:title_delete:")) return this.deleteTitle(ctx, Number(data.split(":")[2]));
      if (data.startsWith("admin:title:")) return this.showTitle(ctx, Number(data.split(":")[2]));
      if (data.startsWith("admin:purchase_approve:")) return this.reviewPurchase(ctx, Number(data.split(":")[2]), "approved");
      if (data.startsWith("admin:purchase_reject:")) return this.reviewPurchase(ctx, Number(data.split(":")[2]), "rejected");
      if (data.startsWith("admin:purchase:")) return this.showPurchase(ctx, Number(data.split(":")[2]));
      if (data === "flow:cancel") return this.cancelFlow(ctx);
      if (data.startsWith("flow:service_approval:")) return this.setServiceApproval(ctx, data.endsWith(":manual"));
      if (data.startsWith("flow:service_pricing:")) return this.setServicePricingMode(ctx, data.split(":")[2]);
      if (data === "flow:service:confirm") return this.confirmService(ctx);
      if (data === "flow:promo:confirm") return this.confirmPromo(ctx);
      if (data === "flow:compensation:confirm") return this.confirmCompensation(ctx);
      if (data === "bc:skip_media") return this.skipBroadcastMedia(ctx);
      if (data === "bc:add_button") return this.startBroadcastButton(ctx);
      if (data === "bc:skip_button") return this.skipBroadcastButton(ctx);
      if (data === "bc:confirm") return this.confirmBroadcast(ctx);
      if (data === "bc:cancel") return this.cancelBroadcast(ctx);

      await ctx.answerCbQuery("Неизвестное действие").catch(() => undefined);
    } catch (error) {
      logger.error({ error, data }, "callback failed");
      await ctx.answerCbQuery(error instanceof Error ? error.message : "Ошибка").catch(() => undefined);
    }
  }

  private async showHome(ctx: BotContext) {
    const user = await this.ensureUser(ctx);
    await this.renderWithAsset(ctx, homeText(user), mainMenuKeyboard(), "messages_banner_gif/start_banner.mp4");
  }

  private async showServices(ctx: BotContext, currency?: "cinders" | "stars", page = 0) {
    if (!currency) {
      await this.renderWithAsset(
        ctx,
        [
          "<b>Услуги</b>",
          "",
          "Выбери категорию услуг.",
          "",
          `Обычные услуги покупаются за Угольки, отдельная категория покупается за ${starsLabel()}.`,
        ].join("\n"),
        serviceCategoriesKeyboard(),
        "messages_banner_gif/rules.mp4",
      );
      return;
    }

    const perPage = currency === "cinders" ? 6 : 6;
    const services = this.repos.listActiveServices().filter((service) => service.currency === currency);
    const safePage = Math.max(0, Math.min(page, Math.max(0, Math.ceil(services.length / perPage) - 1)));
    const pageServices = services.slice(safePage * perPage, safePage * perPage + perPage);
    await this.renderWithAsset(
      ctx,
      servicesText(pageServices),
      servicesKeyboard(pageServices, { currency, page: safePage, total: services.length, perPage }),
      "messages_banner_gif/rules.mp4",
    );
  }

  private async startCindersStarsPurchase(ctx: BotContext) {
    const user = await this.ensureUser(ctx);
    if (!ctx.from) return;
    if (ctx.chat?.type !== "private") {
      await ctx.answerCbQuery("Покупка за Stars доступна только в ЛС").catch(() => undefined);
      return;
    }

    this.repos.setState(ctx.from.id, "buy_cinders_stars", "amount", {});
    await render(
      ctx,
      [
        `<b>Угольки за ${starsLabel()}</b>`,
        "",
        `Курс: <b>1 ${starsLabel()} = ${formatCinders(3)}</b>`,
        "",
        "Выбери готовую сумму кнопкой ниже или напиши свою.",
        "",
        "Можно написать количество Угольков: <code>150</code>.",
        `Можно написать количество ${starsLabel()}: <code>50 stars</code> или <code>50 звезд</code>.`,
        "",
        "Если сумма Угольков не делится на 3, я предложу ближайший удобный вариант.",
        "",
        `Твой баланс: <b>${formatCinders(user.balance)}</b>`,
        `Свободно по лимиту: <b>${formatCinders(freeCinderSpace(user.balance, user.cinder_limit))}</b>`,
      ].join("\n"),
      cindersStarsKeyboard(),
    );
    await ctx.answerCbQuery().catch(() => undefined);
  }

  private async cancelCindersStarsPurchase(ctx: BotContext) {
    if (ctx.from) this.repos.clearState(ctx.from.id);
    await this.showServices(ctx);
    await ctx.answerCbQuery().catch(() => undefined);
  }

  private async showService(ctx: BotContext, serviceId: number) {
    const user = await this.ensureUser(ctx);
    const service = this.repos.getServiceById(serviceId);
    if (!service || !service.is_active) {
      await ctx.answerCbQuery("Услуга недоступна").catch(() => undefined);
      return this.showServices(ctx);
    }
    const offer = this.serviceOffer(service, user);
    await render(ctx, serviceText(service, user, offer), serviceKeyboard(service.id, { ...offer, backCallback: `svc_cat:${offer.currency}:0` }));
  }

  private async buyService(ctx: BotContext, serviceId: number) {
    const user = await this.ensureUser(ctx);
    const service = this.repos.getServiceById(serviceId);
    if (!service || !service.is_active) throw new Error("Услуга недоступна");
    const offer = this.serviceOffer(service, user);
    if (!offer.available) throw new Error("Все доступные ступени этой услуги уже куплены");
    if (!Number.isInteger(offer.price) || offer.price < 0 || offer.price > maxEconomyAmount) {
      throw new Error("Цена услуги сейчас некорректна. Напиши администратору.");
    }
    if (offer.currency === "stars") return this.sendServiceStarsInvoice(ctx, user, service, offer);
    if (user.balance < offer.price) throw new Error("Недостаточно Угольков");

    if (service.slug === "increase_cinder_limit") {
      if (!offer.limitTarget) throw new Error("Следующая ступень лимита не найдена");
      this.repos.createCinderLimitUpgradePurchase(user, service, offer.price, offer.limitTarget);
      await ctx.answerCbQuery("Лимит увеличен").catch(() => undefined);
      await render(
        ctx,
        [
          "<b>Лимит Угольков увеличен</b>",
          "",
          `Новый лимит: <b>${formatCinders(offer.limitTarget)}</b>`,
          `Списано: <b>${formatCinders(offer.price)}</b>`,
        ].join("\n"),
        backHomeKeyboard(),
      );
      return;
    }

    const purchase = this.repos.createPurchase(user, service, offer.price);
    await ctx.answerCbQuery(service.requires_approval ? "Заявка создана" : "Покупка выполнена").catch(() => undefined);

    if (service.requires_approval) {
      await this.notifyAdminsAboutPurchase(purchase.id);
    }

    const text = service.requires_approval
      ? `Заявка #${purchase.id} создана.\n\nУгольки списаны и будут возвращены, если админ отклонит покупку.`
      : `Покупка выполнена: ${escapeHtml(service.title)}.`;
    await render(ctx, text, backHomeKeyboard());
  }

  private async showProfile(ctx: BotContext) {
    const user = await this.ensureUser(ctx);
    const canManageDonorTitle = ctx.chat?.type === "private" && this.repos.donorStarsTotal(user.id) > 0;
    await this.renderWithAsset(ctx, profileText(user), profileKeyboard(canManageDonorTitle), "messages_banner_gif/other.mp4");
  }

  private async showDonorTitleMenu(ctx: BotContext) {
    const user = await this.ensureUser(ctx);
    if (ctx.chat?.type !== "private") {
      await ctx.answerCbQuery("Доступно только в ЛС с ботом").catch(() => undefined);
      return;
    }
    const totalStars = this.repos.donorStarsTotal(user.id);
    if (totalStars <= 0) {
      await ctx.answerCbQuery("Сначала поддержи разработчика Stars").catch(() => undefined);
      return;
    }
    const actionsLimit = this.repos.donorTitleActionsLimit(user.id);
    const actionsLeft = this.repos.donorTitleActionsLeft(user);
    await render(
      ctx,
      donorTitleText({
        totalStars,
        actionsLimit,
        actionsUsed: user.donor_title_actions_used,
        titleHtml: user.donor_title_html,
      }),
      donorTitleKeyboard(Boolean(user.donor_title_html), actionsLeft),
    );
  }

  private async showTop(ctx: BotContext, page: number, kind: "balance" | "weekly" = "balance") {
    const perPage = 10;
    const period = currentYekaterinburgWeek();
    const excludedTelegramIds = this.topExcludedTelegramIds();
    const total =
      kind === "weekly"
        ? this.repos.countWeeklyTopUsers(period.startIso, period.endIso, excludedTelegramIds)
        : this.repos.countTopUsers(excludedTelegramIds);
    const safePage = Math.max(0, Math.min(page, Math.max(0, Math.ceil(total / perPage) - 1)));
    const mode = ctx.chat?.type === "private" ? "menu" : "chat";
    const text =
      kind === "weekly"
        ? weeklyTopText(
            this.repos.weeklyTopUsers(period.startIso, period.endIso, perPage, safePage * perPage, excludedTelegramIds),
            safePage,
            total,
            period.label,
          )
        : topText(this.repos.topUsers(perPage, safePage * perPage, excludedTelegramIds), safePage, total);
    await this.renderWithAsset(ctx, text, topKeyboard(kind, safePage, total, perPage, mode), "messages_banner_gif/other2.mp4");
  }

  private async showAdmin(ctx: BotContext) {
    const user = await this.ensureUser(ctx);
    if (!this.isAdmin(user)) {
      await ctx.reply("Эта команда доступна только админам.");
      return;
    }
    if (ctx.chat?.type !== "private") {
      await ctx.reply("Админ-панель доступна только в ЛС с ботом.");
      return;
    }
    await this.renderWithAsset(ctx, adminText(), this.adminKeyboardFor(user), "messages_banner_gif/under_consideration.mp4");
  }

  private async showStats(ctx: BotContext) {
    const admin = await this.requireAdmin(ctx);
    if (!admin) return;
    await render(ctx, statsText(this.repos.stats(), this.repos.topReceivers(5, this.topExcludedTelegramIds())), backAdminKeyboard());
  }

  private async showAdminServices(ctx: BotContext, page = 0) {
    const admin = await this.requireAdmin(ctx);
    if (!admin) return;
    const services = this.repos.listServices();
    const safePage = this.safePage(page, services.length, adminServicesPerPage);
    const pageServices = services.slice(safePage * adminServicesPerPage, safePage * adminServicesPerPage + adminServicesPerPage);
    const totalPages = Math.max(1, Math.ceil(services.length / adminServicesPerPage));

    await render(
      ctx,
      [
        "<b>Услуги</b>",
        "",
        "Нажми услугу, чтобы посмотреть цену, режим выдачи и статус.",
        "",
        services.length
          ? `Страница: <b>${formatAmount(safePage + 1)}</b> / <b>${formatAmount(totalPages)}</b>. Всего услуг: <b>${formatAmount(services.length)}</b>.`
          : "Услуг пока нет.",
        "",
        "Удаление мягкое: услуга скрывается из лавки, история покупок остается.",
      ].join("\n"),
      adminServicesKeyboard(pageServices, { page: safePage, total: services.length, perPage: adminServicesPerPage }),
    );
  }

  private async showAdminService(ctx: BotContext, serviceId: number, page = 0) {
    const admin = await this.requireAdmin(ctx);
    if (!admin) return;
    const service = this.repos.getServiceById(serviceId);
    if (!service) throw new Error("Услуга не найдена");
    await render(
      ctx,
      [
        `<b>${escapeHtml(service.title)}</b>`,
        "",
        `Базовая цена: <b>${service.currency === "stars" ? `${formatAmount(service.price)} ${starsLabel()}` : formatCinders(service.price)}</b>`,
        `Валюта: <b>${service.currency === "stars" ? starsLabel() : "Угольки"}</b>`,
        `Тип цены: <b>${this.servicePricingLabel(service.pricing_type, this.parsePricingConfig(service.pricing_config))}</b>`,
        "",
        `Статус: <b>${service.is_active ? "включена" : "выключена"}</b>`,
        `Выдача: <b>${service.requires_approval ? "ручная проверка" : "автоматически"}</b>`,
        "",
        escapeHtml(service.description),
      ].join("\n"),
      adminServiceKeyboard(service, Number.isInteger(page) ? page : 0),
    );
  }

  private async toggleService(ctx: BotContext, serviceId: number, page = 0) {
    const admin = await this.requireAdmin(ctx);
    if (!admin) return;
    const service = this.repos.toggleService(serviceId);
    await ctx.answerCbQuery(service.is_active ? "Услуга включена" : "Услуга выключена").catch(() => undefined);
    await this.showAdminService(ctx, serviceId, page);
  }

  private async deleteService(ctx: BotContext, serviceId: number, page = 0) {
    const admin = await this.requireAdmin(ctx);
    if (!admin) return;
    this.repos.deleteService(serviceId);
    await ctx.answerCbQuery("Услуга удалена").catch(() => undefined);
    await this.showAdminServices(ctx, page);
  }

  private async showPromosMenu(ctx: BotContext) {
    const admin = await this.requireAdmin(ctx);
    if (!admin) return;
    await render(ctx, promosText(), promosMenuKeyboard());
  }

  private async showPromoList(ctx: BotContext) {
    const admin = await this.requireAdmin(ctx);
    if (!admin) return;
    const promos = this.repos.listPromos();
    await render(ctx, promos.length ? "Промокоды:" : "Промокодов пока нет.", promoListKeyboard(promos));
  }

  private async showPromo(ctx: BotContext, promoId: number) {
    const admin = await this.requireAdmin(ctx);
    if (!admin) return;
    const promo = this.repos.getPromoById(promoId);
    if (!promo || promo.deleted_at) throw new Error("Промокод не найден");
    await render(ctx, promoText(promo, this.repos.promoRedemptionUsers(promo.id)), promoKeyboard(promo));
  }

  private async sendStarsInvoice(ctx: BotContext, amount: number) {
    if (!ctx.from) return;
    if (![10, 25, 50, 100].includes(amount)) throw new Error("Некорректная сумма Stars");
    if (this.isRateLimited(ctx.from.id, "support_invoice", 6, 60_000)) {
      await ctx.answerCbQuery("Слишком много попыток оплаты. Попробуй чуть позже.", { show_alert: true }).catch(() => undefined);
      return;
    }

    await ctx.answerCbQuery("Открываю оплату").catch(() => undefined);
    await this.bot.telegram.sendInvoice(ctx.from.id, {
      title: "Поддержка разработчика",
      description: `Поддержать разработчика на ${amount} Stars`,
      payload: `support:${ctx.from.id}:${amount}:${Date.now()}`,
      currency: "XTR",
      prices: [{ label: "Telegram Stars", amount }],
    } as never);
  }

  private async continueCindersStarsPurchase(ctx: BotContext, user: UserRecord, text: string) {
    if (!ctx.from) return;
    if (ctx.chat?.type !== "private") {
      this.repos.clearState(user.telegram_id);
      await ctx.reply("Покупка за Stars доступна только в ЛС с ботом.");
      return;
    }

    const parsed = this.parseCindersStarsInput(text);
    if (!parsed) {
      await ctx.reply("Напиши число Угольков или Stars. Например: 150 или 50 stars.", cindersStarsKeyboard());
      return;
    }

    const cinders = parsed.cinders;
    if (!Number.isInteger(cinders) || cinders <= 0) {
      await ctx.reply("Введи положительное целое число. Например: 75", cindersStarsKeyboard());
      return;
    }
    if (cinders % 3 !== 0) {
      const lower = Math.max(3, Math.floor(cinders / 3) * 3);
      const higher = Math.ceil(cinders / 3) * 3;
      await ctx.reply(
        [
          `Эта сумма не делится на 3, поэтому ${starsLabel()} не получится посчитать ровно.`,
          "",
          `Ближайшие варианты: <b>${formatCinders(lower)}</b> или <b>${formatCinders(higher)}</b>.`,
          `Можно также написать <code>${Math.ceil(cinders / 3)} stars</code>, тогда получится <b>${formatCinders(higher)}</b>.`,
        ].join("\n"),
        { parse_mode: parseMode, ...cindersStarsKeyboard() } as never,
      );
      return;
    }
    if (!this.hasCinderSpace(user, cinders)) {
      await ctx.reply(this.cinderLimitErrorText(user, cinders), { parse_mode: parseMode, ...cindersStarsKeyboard() } as never);
      return;
    }
    if (this.isRateLimited(user.telegram_id, "cinders_invoice", 5, 10 * 60_000)) {
      await ctx.reply("Слишком много попыток покупки. Попробуй снова через несколько минут.", cindersStarsKeyboard());
      return;
    }

    this.repos.clearState(user.telegram_id);
    await this.sendCindersStarsInvoice(ctx, user, cinders);
  }

  private async buyCindersForStars(ctx: BotContext, cinders: number) {
    const user = await this.ensureUser(ctx);
    if (!ctx.from) return;
    if (ctx.chat?.type !== "private") {
      await ctx.answerCbQuery("Покупка за Stars доступна только в ЛС").catch(() => undefined);
      return;
    }
    if (!Number.isInteger(cinders) || cinders <= 0 || cinders % 3 !== 0) throw new Error("Некорректная сумма Угольков");
    if (!this.hasCinderSpace(user, cinders)) {
      await ctx.answerCbQuery("Не хватает места в лимите Угольков", { show_alert: true }).catch(() => undefined);
      await render(ctx, this.cinderLimitErrorText(user, cinders), cindersStarsKeyboard());
      return;
    }
    if (this.isRateLimited(user.telegram_id, "cinders_invoice", 5, 10 * 60_000)) {
      await ctx.answerCbQuery("Слишком много попыток покупки. Попробуй позже.", { show_alert: true }).catch(() => undefined);
      return;
    }
    this.repos.clearState(ctx.from.id);
    await ctx.answerCbQuery("Открываю оплату").catch(() => undefined);
    await this.sendCindersStarsInvoice(ctx, user, cinders);
  }

  private async handlePreCheckout(ctx: BotContext) {
    const user = await this.ensureUser(ctx);
    const query = ctx.preCheckoutQuery;
    if (!query) return;
    const validation = this.validatePreCheckoutPayload(user, query.invoice_payload, query.total_amount);
    if (!validation.ok) {
      await ctx.answerPreCheckoutQuery(false, validation.message);
      return;
    }
    await ctx.answerPreCheckoutQuery(true);
  }

  private validatePreCheckoutPayload(user: UserRecord, payload: string, totalAmount: number) {
    const parts = payload.split(":");

    if (parts[0] === "support") {
      const telegramId = Number(parts[1]);
      const stars = Number(parts[2]);
      if (telegramId !== user.telegram_id || !Number.isInteger(stars) || stars !== totalAmount || ![10, 25, 50, 100].includes(stars)) {
        return { ok: false as const, message: "Данные платежа устарели. Открой оплату заново." };
      }
      return { ok: true as const };
    }

    if (parts[0] !== "cinders") {
      return { ok: false as const, message: "Неизвестный тип платежа. Открой оплату заново." };
    }

    const isCustom = parts[1] === "custom";
    const payloadUserId = Number(isCustom ? parts[2] : parts[1]);
    const stars = Number(isCustom ? parts[3] : parts[3]);
    const cinders = Number(isCustom ? parts[4] : parts[4]);

    if (payloadUserId !== user.id || !Number.isInteger(stars) || !Number.isInteger(cinders) || stars <= 0 || cinders <= 0) {
      return { ok: false as const, message: "Данные платежа повреждены. Открой оплату заново." };
    }
    if (totalAmount !== stars) {
      return { ok: false as const, message: "Сумма платежа не совпадает. Открой оплату заново." };
    }
    if (isCustom && cinders !== stars * 3) {
      return { ok: false as const, message: "Курс платежа не совпадает. Открой оплату заново." };
    }
    if (!this.hasCinderSpace(user, cinders)) {
      return { ok: false as const, message: "Не хватает места в лимите Угольков. Увеличь лимит или потрать часть баланса." };
    }

    return { ok: true as const };
  }

  private async sendCindersStarsInvoice(ctx: BotContext, user: UserRecord, cinders: number) {
    if (!ctx.from) return;
    const stars = cinders / 3;
    await this.bot.telegram.sendInvoice(ctx.from.id, {
      title: "Угольки за Stars",
      description: `Покупка ${formatAmount(cinders)} Угольков за ${formatAmount(stars)} Stars`,
      payload: `cinders:custom:${user.id}:${stars}:${cinders}:${Date.now()}`,
      currency: "XTR",
      prices: [{ label: "Telegram Stars", amount: stars }],
    } as never);
  }

  private parseCindersStarsInput(text: string) {
    const normalized = text.trim().toLowerCase().replace(",", ".");
    const match = normalized.match(/^(\d+)(?:\s*(stars?|старс|зв(?:е|ё)зд(?:а|ы)?|зв))?$/iu);
    if (!match) return null;
    const amount = Number(match[1]);
    if (!Number.isInteger(amount) || amount <= 0) return null;
    const unit = match[2] ?? "";
    const isStars = /stars?|старс|зв/u.test(unit);
    return { cinders: isStars ? amount * 3 : amount };
  }

  private serviceOffer(service: ServiceRecord, user: UserRecord) {
    const purchaseCount = this.repos.countUserServicePurchases(user.id, service.id);
    const config = this.parsePricingConfig(service.pricing_config);
    const currency: "stars" | "cinders" = service.currency === "stars" ? "stars" : "cinders";
    const purchaseNumber = purchaseCount + 1;
    const priceAdjustment = currency === "cinders" ? this.repos.getUserPriceAdjustment(user.id) : 0;
    const applyPriceAdjustment = (price: number) => price + priceAdjustment;

    if (service.slug === "increase_cinder_limit") {
      const nextLimit = nextCinderLimitOffer(user.cinder_limit);
      return {
        price: applyPriceAdjustment(nextLimit?.price ?? service.price),
        currency,
        available: Boolean(nextLimit),
        purchaseNumber,
        stageLabel: nextLimit?.stageLabel,
        currentLimit: user.cinder_limit,
        limitTarget: nextLimit?.target,
        priceAdjustment,
      };
    }

    if (service.pricing_type === "incremental") {
      const start = Number.isInteger(config.start) ? config.start! : service.price;
      const step = Number.isInteger(config.step) ? config.step! : 0;
      return { price: applyPriceAdjustment(start + purchaseCount * step), currency, available: true, purchaseNumber, priceAdjustment };
    }

    if (service.pricing_type === "ladder_once" || service.pricing_type === "ladder_repeat_last") {
      const prices = config.prices?.filter((price) => Number.isInteger(price) && price >= 0) ?? [service.price];
      const available = service.pricing_type !== "ladder_once" || purchaseCount < prices.length;
      const index = Math.min(purchaseCount, Math.max(0, prices.length - 1));
      return {
        price: applyPriceAdjustment(prices[index] ?? service.price),
        currency,
        available,
        purchaseNumber,
        stageLabel: config.stages?.[index],
        priceAdjustment,
      };
    }

    return {
      price: applyPriceAdjustment(service.price),
      currency,
      available: true,
      purchaseNumber,
      rewardCinders: config.rewardCinders,
      priceAdjustment,
    };
  }

  private parsePricingConfig(raw: string) {
    try {
      const parsed = JSON.parse(raw) as {
        prices?: number[];
        start?: number;
        step?: number;
        rewardCinders?: number;
        stages?: string[];
      };
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  private parsePriceList(text: string) {
    const parts = text
      .split(/[,\s]+/)
      .map((part) => part.trim())
      .filter(Boolean);
    if (!parts.length) return null;

    const prices = parts.map((part) => Number(part));
    if (prices.some((value) => !Number.isInteger(value) || value < 0)) return null;
    return prices;
  }

  private servicePricingLabel(
    pricingType: string,
    pricingConfig: { prices?: number[]; start?: number; step?: number },
  ) {
    if (pricingType === "ladder_once") {
      const prices = pricingConfig.prices ?? [];
      return prices.length ? `ступени до конца: ${prices.map((price) => formatCinders(price)).join(" → ")}` : "ступени до конца";
    }
    if (pricingType === "ladder_repeat_last") {
      const prices = pricingConfig.prices ?? [];
      return prices.length ? `ступени, потом последняя: ${prices.map((price) => formatCinders(price)).join(" → ")}` : "ступени, потом последняя";
    }
    if (pricingType === "incremental") {
      return `каждый раз +${formatCinders(Number(pricingConfig.step ?? 0))}`;
    }
    return "обычная фиксированная";
  }

  private hasCinderSpace(user: UserRecord, amount: number) {
    return freeCinderSpace(user.balance, user.cinder_limit) >= amount;
  }

  private safePage(page: number, total: number, perPage: number) {
    const requestedPage = Number.isInteger(page) ? page : 0;
    const maxPage = Math.max(0, Math.ceil(total / perPage) - 1);
    return Math.max(0, Math.min(requestedPage, maxPage));
  }

  private promoUnavailableText(user: UserRecord, code: string, promo: PromoCodeRecord | undefined) {
    const codeLine = `Код: <code>${escapeHtml(code.trim())}</code>`;
    if (!promo) {
      return [
        `${pe(premiumEmoji.cross, "❌")} <b>Промокод не найден</b>`,
        "",
        codeLine,
        "",
        "Проверь код и попробуй еще раз.",
      ].join("\n");
    }

    if (!promo.is_active) {
      return [
        `${pe(premiumEmoji.cross, "❌")} <b>Промокод выключен</b>`,
        "",
        codeLine,
        "",
        "Этот промокод больше нельзя активировать.",
      ].join("\n");
    }

    if (promo.expires_at && this.parseDbDate(promo.expires_at).getTime() <= Date.now()) {
      return [
        `${pe(premiumEmoji.clock, "⏰")} <b>Промокод истек</b>`,
        "",
        codeLine,
        "",
        "Срок действия этого промокода уже закончился.",
      ].join("\n");
    }

    if (promo.used_count >= promo.max_uses) {
      return [
        `${pe(premiumEmoji.cross, "❌")} <b>У промокода закончились активации</b>`,
        "",
        codeLine,
        "",
        `Использовано: <b>${formatAmount(promo.used_count)}</b> / <b>${formatAmount(promo.max_uses)}</b>.`,
      ].join("\n");
    }

    if (promo.single_use_per_user && this.repos.hasRedeemedPromo(promo.id, user.id)) {
      return [
        `${pe(premiumEmoji.info, "ℹ")} <b>Промокод уже активирован</b>`,
        "",
        codeLine,
        "",
        "Ты уже использовал этот промокод.",
      ].join("\n");
    }

    if (!this.hasCinderSpace(user, promo.reward)) {
      return this.cinderLimitErrorText(user, promo.reward);
    }

    return null;
  }

  private cinderLimitErrorText(user: UserRecord, amount: number) {
    const freeSpace = freeCinderSpace(user.balance, user.cinder_limit);
    return [
      `${pe(premiumEmoji.lockClosed, "🔒")} <b>Не хватает места в лимите Угольков</b>`,
      "",
      `Нужно получить: <b>${formatCinders(amount)}</b>`,
      `Свободно сейчас: <b>${formatCinders(freeSpace)}</b>`,
      `Твой лимит: <b>${formatCinders(user.cinder_limit)}</b>`,
      "",
      "Увеличить лимит можно в услугах за Угольки.",
    ].join("\n");
  }

  private cinderLimitRecipientErrorText(user: UserRecord, amount: number, action: "gift" | "grant") {
    const freeSpace = freeCinderSpace(user.balance, user.cinder_limit);
    const intro = action === "gift" ? "Подарок не отправлен." : "Начисление не выполнено.";
    const advice =
      action === "gift"
        ? "Получатель может увеличить лимит в лавке или потратить часть баланса."
        : "Сначала увеличь лимит пользователю через услугу лимита или спиши часть баланса.";

    return [
      `${pe(premiumEmoji.lockClosed, "🔒")} <b>Не хватает места в лимите Угольков</b>`,
      "",
      `${intro} У ${mentionUser(user)} недостаточно свободного места для этой суммы.`,
      "",
      `Сумма: <b>${formatCinders(amount)}</b>`,
      `Баланс получателя: <b>${formatCinders(user.balance)}</b>`,
      `Свободно сейчас: <b>${formatCinders(freeSpace)}</b>`,
      `Лимит получателя: <b>${formatCinders(user.cinder_limit)}</b>`,
      "",
      advice,
    ].join("\n");
  }

  private async sendServiceStarsInvoice(
    ctx: BotContext,
    user: UserRecord,
    service: ServiceRecord,
    offer: ReturnType<GameBotHandlers["serviceOffer"]>,
  ) {
    if (!ctx.from) return;
    const rewardCinders = offer.rewardCinders;
    if (!rewardCinders || rewardCinders <= 0) throw new Error("Награда услуги не настроена");
    if (this.isRateLimited(user.telegram_id, "stars_service_invoice", 5, 10 * 60_000)) {
      await ctx.answerCbQuery("Слишком много попыток оплаты. Попробуй позже.", { show_alert: true }).catch(() => undefined);
      return;
    }
    if (!this.hasCinderSpace(user, rewardCinders)) {
      await ctx.answerCbQuery("Не хватает места в лимите Угольков", { show_alert: true }).catch(() => undefined);
      await render(ctx, this.cinderLimitErrorText(user, rewardCinders), backHomeKeyboard());
      return;
    }

    await ctx.answerCbQuery("Открываю оплату").catch(() => undefined);
    await this.bot.telegram.sendInvoice(ctx.from.id, {
      title: service.title,
      description: `Покупка ${formatAmount(rewardCinders)} Угольков за ${formatAmount(offer.price)} Stars`,
      payload: `cinders:${user.id}:${service.id}:${offer.price}:${rewardCinders}:${Date.now()}`,
      currency: "XTR",
      prices: [{ label: "Telegram Stars", amount: offer.price }],
    } as never);
  }

  private async completeCindersStarsPurchase(
    ctx: BotContext,
    user: UserRecord,
    payment: {
      invoice_payload: string;
      telegram_payment_charge_id: string;
      total_amount: number;
    },
  ) {
    if (payment.invoice_payload.startsWith("cinders:custom:")) {
      await this.completeCustomCindersStarsPurchase(ctx, user, payment);
      return;
    }

    const [, userIdRaw, serviceIdRaw, starsRaw, cindersRaw] = payment.invoice_payload.split(":");
    const payloadUserId = Number(userIdRaw);
    const serviceId = Number(serviceIdRaw);
    const stars = Number(starsRaw);
    const cinders = Number(cindersRaw);
    if (payloadUserId !== user.id || !Number.isInteger(serviceId) || !Number.isInteger(stars) || !Number.isInteger(cinders)) {
      await ctx.reply("Оплата прошла, но payload услуги поврежден. Напиши разработчику.");
      return;
    }
    if (payment.total_amount !== stars) {
      await ctx.reply("Оплата прошла, но сумма не совпала с услугой. Напиши разработчику.");
      return;
    }

    const result = this.repos.recordStarServicePurchase({
      userId: user.id,
      serviceId,
      telegramPaymentChargeId: payment.telegram_payment_charge_id,
      stars,
      cinders,
      payload: payment.invoice_payload,
    });
    if (!result.created) return;

    await this.replyWithEffect(
      ctx,
      [
        "<b>Угольки начислены</b>",
        "",
        `Оплачено: <b>${formatAmount(stars)} ${starsLabel()}</b>`,
        `Получено: <b>${formatCinders(result.credited)}</b>`,
        result.credited < cinders ? "Часть покупки не поместилась в текущий лимит Угольков." : null,
      ]
        .filter(Boolean)
        .join("\n"),
      messageEffects.fire,
      { parse_mode: parseMode },
    );
  }

  private async completeCustomCindersStarsPurchase(
    ctx: BotContext,
    user: UserRecord,
    payment: {
      invoice_payload: string;
      telegram_payment_charge_id: string;
      total_amount: number;
    },
  ) {
    const [, , userIdRaw, starsRaw, cindersRaw] = payment.invoice_payload.split(":");
    const payloadUserId = Number(userIdRaw);
    const stars = Number(starsRaw);
    const cinders = Number(cindersRaw);
    if (payloadUserId !== user.id || !Number.isInteger(stars) || !Number.isInteger(cinders)) {
      await ctx.reply("Оплата прошла, но payload покупки поврежден. Напиши разработчику.");
      return;
    }
    if (payment.total_amount !== stars || cinders !== stars * 3) {
      await ctx.reply("Оплата прошла, но сумма не совпала с покупкой. Напиши разработчику.");
      return;
    }

    const result = this.repos.recordStarCinderPurchase({
      userId: user.id,
      telegramPaymentChargeId: payment.telegram_payment_charge_id,
      stars,
      cinders,
      payload: payment.invoice_payload,
    });
    if (!result.created) return;

    await this.replyWithEffect(
      ctx,
      [
        "<b>Угольки начислены</b>",
        "",
        `Оплачено: <b>${formatAmount(stars)} ${starsLabel()}</b>`,
        `Получено: <b>${formatCinders(result.credited)}</b>`,
        result.credited < cinders ? "Часть покупки не поместилась в текущий лимит Угольков." : null,
      ]
        .filter(Boolean)
        .join("\n"),
      messageEffects.fire,
      { parse_mode: parseMode },
    );
  }

  private async showTitlesMenu(ctx: BotContext) {
    const admin = await this.requireAdmin(ctx);
    if (!admin) return;
    await render(ctx, titlesText(), titlesMenuKeyboard());
  }

  private async showTitleList(ctx: BotContext) {
    const admin = await this.requireAdmin(ctx);
    if (!admin) return;
    const titles = this.repos.listTitles();
    await render(ctx, titles.length ? "Титулы:" : "Титулов пока нет.", titleListKeyboard(titles));
  }

  private async showTitle(ctx: BotContext, titleId: number) {
    const admin = await this.requireAdmin(ctx);
    if (!admin) return;
    const title = this.repos.getTitleById(titleId);
    if (!title || title.deleted_at) throw new Error("Титул не найден");
    await render(ctx, titleText(title), titleKeyboard(title));
  }

  private async toggleTitle(ctx: BotContext, titleId: number) {
    const admin = await this.requireAdmin(ctx);
    if (!admin) return;
    const title = this.repos.toggleTitle(titleId);
    await ctx.answerCbQuery(title.is_active ? "Титул включен" : "Титул выключен").catch(() => undefined);
    await this.showTitle(ctx, titleId);
  }

  private async deleteTitle(ctx: BotContext, titleId: number) {
    const admin = await this.requireAdmin(ctx);
    if (!admin) return;
    this.repos.deleteTitle(titleId);
    await ctx.answerCbQuery("Титул удален").catch(() => undefined);
    await this.showTitleList(ctx);
  }

  private async togglePromo(ctx: BotContext, promoId: number) {
    const admin = await this.requireAdmin(ctx);
    if (!admin) return;
    const promo = this.repos.togglePromo(promoId);
    await ctx.answerCbQuery(promo.is_active ? "Промокод включен" : "Промокод выключен").catch(() => undefined);
    await this.showPromo(ctx, promoId);
  }

  private async deletePromo(ctx: BotContext, promoId: number) {
    const admin = await this.requireAdmin(ctx);
    if (!admin) return;
    this.repos.deletePromo(promoId);
    await ctx.answerCbQuery("Промокод удален").catch(() => undefined);
    await this.showPromoList(ctx);
  }

  private async showPendingPurchases(ctx: BotContext) {
    const admin = await this.requireAdmin(ctx);
    if (!admin) return;
    const purchases = this.repos.listPendingPurchases(10);
    await render(
      ctx,
      purchases.length ? "Заявки на услуги:" : "Ожидающих заявок нет.",
      pendingPurchasesKeyboard(purchases),
    );
  }

  private async showPurchase(ctx: BotContext, purchaseId: number) {
    const admin = await this.requireAdmin(ctx);
    if (!admin) return;
    const purchase = this.repos.getPurchaseById(purchaseId);
    if (!purchase) throw new Error("Заявка не найдена");
    await render(ctx, purchaseText(purchase), purchaseReviewKeyboard(purchase.id));
  }

  private async reviewPurchase(ctx: BotContext, purchaseId: number, status: "approved" | "rejected") {
    const admin = await this.requireAdmin(ctx);
    if (!admin) return;
    const purchase = this.repos.reviewPurchase(purchaseId, status, admin.id);
    await ctx.answerCbQuery(status === "approved" ? "Заявка одобрена" : "Заявка отклонена").catch(() => undefined);
    await render(ctx, purchaseText(purchase), backAdminKeyboard());
    await this.bot.telegram
      .sendMessage(
        purchase.telegram_id,
        status === "approved"
          ? `Твоя заявка #${purchase.id} одобрена: ${purchase.service_title}.`
          : `Твоя заявка #${purchase.id} отклонена. Угольки возвращены на баланс.`,
      )
      .catch(() => undefined);
  }

  private async notifyAdminsAboutPurchase(purchaseId: number) {
    const purchase = this.repos.getPurchaseById(purchaseId);
    if (!purchase) return;

    const text = [
      "Новая заявка на услугу.",
      "",
      purchaseText(purchase),
    ].join("\n");

    for (const adminId of this.notificationAdminIds()) {
      try {
        await this.bot.telegram.sendMessage(adminId, text, {
          parse_mode: parseMode,
          ...noLinkPreview,
          ...purchaseReviewKeyboard(purchase.id),
        } as never);
      } catch (error) {
        logger.warn({ error, adminId, purchaseId }, "failed to notify admin about purchase");
      }
    }
  }

  private notificationAdminIds() {
    const config = this.getConfig();
    return [...config.adminIds].filter((adminId) => adminId !== config.developerId);
  }

  private async startCreateService(ctx: BotContext) {
    const admin = await this.requireAdmin(ctx);
    if (!admin || !ctx.from) return;
    this.repos.setState(ctx.from.id, "create_service", "title", {});
    await render(
      ctx,
      [
        "<b>Новая услуга</b>",
        "",
        `Шаг 1: введи название услуги. До ${formatAmount(maxServiceTitleLength)} символов.`,
        "",
        "Пример: <code>Снять варн за активность</code>",
      ].join("\n"),
      cancelFlowKeyboard(),
    );
  }

  private async startCreatePromo(ctx: BotContext) {
    const admin = await this.requireAdmin(ctx);
    if (!admin || !ctx.from) return;
    this.repos.setState(ctx.from.id, "create_promo", "code", {});
    await render(
      ctx,
      [
        "<b>Новый промокод</b>",
        "",
        `Шаг 1: введи код от 3 до ${formatAmount(maxPromoCodeLength)} символов.`,
        "",
        "Можно использовать буквы, цифры, _ и -. Пробелы не допускаются.",
        "",
        "Пример: <code>LETO2026</code>",
      ].join("\n"),
      cancelFlowKeyboard(),
    );
  }

  private async startCreateTitle(ctx: BotContext) {
    const admin = await this.requireAdmin(ctx);
    if (!admin || !ctx.from) return;
    this.repos.setState(ctx.from.id, "create_title", "name", {});
    await render(
      ctx,
      [
        "Введи название титула.",
        "",
        "Максимум 48 символов.",
      ].join("\n"),
      cancelFlowKeyboard(),
    );
  }

  private async startAssignTitle(ctx: BotContext) {
    const admin = await this.requireAdmin(ctx);
    if (!admin || !ctx.from) return;
    this.repos.setState(ctx.from.id, "assign_title", "input", {});
    await render(
      ctx,
      [
        "Введи пользователя и титул через <code>|</code>.",
        "",
        "Пример: <code>@username | Лучший угольщик</code>",
        "",
        "Пользователь уже должен быть в базе бота.",
      ].join("\n"),
      cancelFlowKeyboard(),
    );
  }

  private async startRemoveTitle(ctx: BotContext) {
    const admin = await this.requireAdmin(ctx);
    if (!admin || !ctx.from) return;
    this.repos.setState(ctx.from.id, "remove_title", "input", {});
    await render(
      ctx,
      [
        "Введи пользователя, у которого нужно забрать титул.",
        "",
        "Пример: <code>@username</code>",
      ].join("\n"),
      cancelFlowKeyboard(),
    );
  }

  private async startPriceAdjustment(ctx: BotContext) {
    const admin = await this.requireAdmin(ctx);
    if (!admin || !ctx.from) return;
    this.repos.setState(ctx.from.id, "price_adjustment", "user", {});
    await render(
      ctx,
      [
        "<b>Персональная наценка</b>",
        "",
        "Введи пользователя, которому нужно повысить цены на услуги.",
        "",
        "Пример: <code>@username</code> или Telegram ID.",
        "Пользователь уже должен быть в базе бота.",
      ].join("\n"),
      cancelFlowKeyboard(),
    );
  }

  private async startSetDonorTitle(ctx: BotContext) {
    const user = await this.ensureUser(ctx);
    if (!ctx.from || ctx.chat?.type !== "private") return;
    if (this.repos.donorTitleActionsLeft(user) <= 0) {
      await ctx.answerCbQuery("Не осталось действий с титулом").catch(() => undefined);
      return;
    }
    this.repos.setState(ctx.from.id, "donor_title", "set", {});
    await render(
      ctx,
      [
        "Отправь новый донатный титул.",
        "",
        "Можно использовать: <b>жирный</b>, <i>курсив</i>, <u>подчеркнутый</u>, <s>зачеркнутый</s>, <code>код</code>, <tg-spoiler>спойлер</tg-spoiler>.",
        "",
        'Premium emoji тоже можно: <tg-emoji emoji-id="5314763033682143911">💎</tg-emoji>.',
        "",
        "Максимум 256 символов вместе с HTML-тегами.",
      ].join("\n"),
      cancelFlowKeyboard(),
    );
  }

  private async removeDonorTitle(ctx: BotContext) {
    const user = await this.ensureUser(ctx);
    if (ctx.chat?.type !== "private") return;
    if (!user.donor_title_html) {
      await ctx.answerCbQuery("Титул не установлен").catch(() => undefined);
      return;
    }
    this.repos.setDonorTitle(user.id, null, false);
    await ctx.answerCbQuery("Титул удален").catch(() => undefined);
    await this.showDonorTitleMenu(ctx);
  }

  private async startBroadcast(ctx: BotContext) {
    const admin = await this.requireAdmin(ctx);
    if (!admin || !ctx.from) return;
    const data: BroadcastData = { controlMessageId: this.callbackMessageId(ctx) };
    this.repos.setState(ctx.from.id, "broadcast", "text", data);
    await render(
      ctx,
      [
        "<b>Рассылка</b>",
        "",
        `Шаг 1: отправь текст рассылки. Максимум ${formatAmount(maxBroadcastTextLength)} символов.`,
        "",
        "Можно отправить текст или медиа с подписью. Форматирование, ссылки и premium emoji сохранятся.",
        "",
        "Перед отправкой всем пользователям бот покажет предпросмотр.",
      ].join("\n"),
      broadcastCancelKeyboard(),
    );
    return;
  }

  private async startCompensation(ctx: BotContext) {
    const developer = await this.requireDeveloper(ctx);
    if (!developer || !ctx.from) return;
    if (ctx.chat?.type !== "private") {
      await ctx.reply("Компенсацию можно оформить только в ЛС с ботом.");
      return;
    }

    this.repos.setState(ctx.from.id, "compensation", "reason", {});
    await render(
      ctx,
      [
        `${pe(premiumEmoji.gift, "🎁")} <b>Компенсация</b>`,
        "",
        `Шаг 1: напиши причину компенсации. До ${formatAmount(maxCompensationReasonLength)} символов.`,
        "",
        "Эта причина будет отправлена участникам вместе с уведомлением о начислении.",
      ].join("\n"),
      cancelFlowKeyboard(),
    );
  }

  private async handleStateMessage(ctx: BotContext, user: UserRecord) {
    const state = this.repos.getState(user.telegram_id);
    if (!state || state.flow !== "broadcast") return false;
    if (!this.isAdmin(user)) {
      this.repos.clearState(user.telegram_id);
      return false;
    }
    if (!ctx.chat) return true;

    const message = ctx.message as BroadcastMessage | undefined;
    if (!message) return true;
    if (message.text?.trim().startsWith("/")) return false;

    const data = this.parseStateData(state.data) as BroadcastData;
    if (!data.controlMessageId) data.controlMessageId = this.callbackMessageId(ctx);

    if (state.step === "text") {
      await this.receiveBroadcastText(ctx, user, data, message);
      return true;
    }
    if (state.step === "media") {
      await this.receiveBroadcastMedia(ctx, user, data, message);
      return true;
    }
    if (state.step === "button_text") {
      await this.receiveBroadcastButtonText(ctx, user, data, message);
      return true;
    }
    if (state.step === "button_url") {
      await this.receiveBroadcastButtonUrl(ctx, user, data, message);
      return true;
    }
    return true;
  }

  private async receiveBroadcastText(ctx: BotContext, user: UserRecord, data: BroadcastData, message: BroadcastMessage) {
    const text = (message.text ?? message.caption ?? "").trim();
    if (!text) {
      await ctx.reply("Отправь текст рассылки или медиа с подписью.", broadcastCancelKeyboard());
      return;
    }
    if (text.length > maxBroadcastTextLength) {
      await ctx.reply(`Текст рассылки слишком длинный. Максимум ${formatAmount(maxBroadcastTextLength)} символов.`, broadcastCancelKeyboard());
      return;
    }

    const nextData: BroadcastData = {
      ...data,
      text,
      entities: message.entities ?? message.caption_entities ?? [],
      ...this.broadcastMediaFromMessage(message),
    };
    this.repos.setState(user.telegram_id, "broadcast", "media", nextData);
    await this.deleteUserMessage(ctx, message.message_id);

    if (nextData.photoFileId || nextData.videoFileId || nextData.animationFileId) {
      await this.askBroadcastButton(ctx, user, nextData);
      return;
    }

    await this.editBroadcastControl(
      ctx,
      nextData,
      [
        "<b>Рассылка</b>",
        "",
        "Шаг 2: отправь фото, видео или GIF для рассылки.",
        "",
        "Если медиа не нужно, нажми кнопку ниже.",
      ].join("\n"),
      broadcastMediaKeyboard(),
    );
  }

  private async receiveBroadcastMedia(ctx: BotContext, user: UserRecord, data: BroadcastData, message: BroadcastMessage) {
    const media = this.broadcastMediaFromMessage(message);
    if (!media.photoFileId && !media.videoFileId && !media.animationFileId) {
      await ctx.reply("Можно прикрепить фото, видео или GIF. Либо нажми «Пропустить медиа».", broadcastMediaKeyboard());
      return;
    }

    const nextData: BroadcastData = { ...data, ...media };
    this.repos.setState(user.telegram_id, "broadcast", "button_choice", nextData);
    await this.deleteUserMessage(ctx, message.message_id);
    await this.askBroadcastButton(ctx, user, nextData);
  }

  private async receiveBroadcastButtonText(ctx: BotContext, user: UserRecord, data: BroadcastData, message: BroadcastMessage) {
    const parsed = this.parseBroadcastButtonText(message);
    if (!parsed.text && !parsed.emojiId) {
      await ctx.reply("Текст кнопки не может быть пустым.", broadcastCancelKeyboard());
      return;
    }

    const nextData: BroadcastData = {
      ...data,
      buttonText: parsed.text || "·",
      buttonEmojiId: parsed.emojiId ?? null,
    };
    this.repos.setState(user.telegram_id, "broadcast", "button_url", nextData);
    await this.deleteUserMessage(ctx, message.message_id);
    await this.editBroadcastControl(
      ctx,
      nextData,
      [
        "<b>Рассылка</b>",
        "",
        "Шаг 4: отправь ссылку для кнопки.",
        "",
        "Поддерживаются ссылки, начинающиеся с http:// или https://.",
      ].join("\n"),
      broadcastCancelKeyboard(),
    );
  }

  private async receiveBroadcastButtonUrl(ctx: BotContext, user: UserRecord, data: BroadcastData, message: BroadcastMessage) {
    const url = (message.text ?? "").trim();
    if (!this.isValidBroadcastUrl(url)) {
      await ctx.reply("Ссылка должна начинаться с http:// или https://.", broadcastCancelKeyboard());
      return;
    }

    const nextData: BroadcastData = { ...data, buttonUrl: url };
    await this.deleteUserMessage(ctx, message.message_id);
    await this.showBroadcastPreview(ctx, user, nextData);
  }

  private async skipBroadcastMedia(ctx: BotContext) {
    const admin = await this.requireAdmin(ctx);
    if (!admin || !ctx.from) return;
    const data = this.getBroadcastDataOrThrow(ctx.from.id, "media");
    await this.askBroadcastButton(ctx, admin, {
      ...data,
      photoFileId: null,
      videoFileId: null,
      animationFileId: null,
      controlMessageId: data.controlMessageId ?? this.callbackMessageId(ctx),
    });
    await ctx.answerCbQuery().catch(() => undefined);
  }

  private async askBroadcastButton(ctx: BotContext, user: UserRecord, data: BroadcastData) {
    const nextData: BroadcastData = { ...data, controlMessageId: data.controlMessageId ?? this.callbackMessageId(ctx) };
    this.repos.setState(user.telegram_id, "broadcast", "button_choice", nextData);
    await this.editBroadcastControl(
      ctx,
      nextData,
      ["<b>Рассылка</b>", "", "Шаг 3: добавить кнопку со ссылкой?"].join("\n"),
      broadcastButtonChoiceKeyboard(),
    );
  }

  private async startBroadcastButton(ctx: BotContext) {
    const admin = await this.requireAdmin(ctx);
    if (!admin || !ctx.from) return;
    const data = this.getBroadcastDataOrThrow(ctx.from.id, "button_choice");
    const nextData: BroadcastData = { ...data, controlMessageId: data.controlMessageId ?? this.callbackMessageId(ctx) };
    this.repos.setState(ctx.from.id, "broadcast", "button_text", nextData);
    await this.editBroadcastControl(
      ctx,
      nextData,
      [
        "<b>Рассылка</b>",
        "",
        "Шаг 4: отправь текст кнопки.",
        "",
        "Premium emoji в тексте кнопки будет использован как иконка кнопки.",
      ].join("\n"),
      broadcastCancelKeyboard(),
    );
    await ctx.answerCbQuery().catch(() => undefined);
  }

  private async skipBroadcastButton(ctx: BotContext) {
    const admin = await this.requireAdmin(ctx);
    if (!admin || !ctx.from) return;
    const data = this.getBroadcastDataOrThrow(ctx.from.id, "button_choice");
    await this.showBroadcastPreview(ctx, admin, {
      ...data,
      buttonText: null,
      buttonUrl: null,
      buttonEmojiId: null,
      controlMessageId: data.controlMessageId ?? this.callbackMessageId(ctx),
    });
    await ctx.answerCbQuery().catch(() => undefined);
  }

  private async handleStateText(ctx: BotContext, user: UserRecord, text: string) {
    const state = this.repos.getState(user.telegram_id);
    if (!state) return false;
    const data = this.parseStateData(state.data);
    if (state.flow === "buy_cinders_stars") {
      await this.continueCindersStarsPurchase(ctx, user, text);
      return true;
    }
    if (state.flow === "donor_title") {
      if (ctx.chat?.type !== "private") {
        this.repos.clearState(user.telegram_id);
        await ctx.reply("Донатный титул можно настроить только в ЛС с ботом.");
        return true;
      }
      await this.continueDonorTitleFlow(ctx, user, this.textWithCustomEmojiHtml(ctx, text));
      return true;
    }
    if (state.flow === "compensation") {
      if (!this.isDeveloper(user)) {
        this.repos.clearState(user.telegram_id);
        return false;
      }
      await this.continueCompensationFlow(ctx, user, state.step, data, text);
      return true;
    }
    if (!this.isAdmin(user)) {
      this.repos.clearState(user.telegram_id);
      return false;
    }

    if (state.flow === "create_service") {
      await this.continueServiceFlow(ctx, user, state.step, data, text);
      return true;
    }
    if (state.flow === "create_promo") {
      await this.continuePromoFlow(ctx, user, state.step, data, text);
      return true;
    }
    if (state.flow === "create_title") {
      await this.continueCreateTitleFlow(ctx, user, text);
      return true;
    }
    if (state.flow === "assign_title") {
      await this.continueAssignTitleFlow(ctx, user, text);
      return true;
    }
    if (state.flow === "remove_title") {
      await this.continueRemoveTitleFlow(ctx, user, text);
      return true;
    }
    if (state.flow === "price_adjustment") {
      await this.continuePriceAdjustmentFlow(ctx, user, state.step, data, text);
      return true;
    }
    if (state.flow === "broadcast") {
      if (text.length > maxBroadcastTextLength) {
        await ctx.reply(`Текст рассылки слишком длинный. Максимум ${formatAmount(maxBroadcastTextLength)} символов.`);
        return true;
      }
      this.repos.setState(user.telegram_id, "broadcast", "confirm", { text });
      await ctx.reply(
        [
          "<b>Предпросмотр рассылки:</b>",
          "",
          text,
        ].join("\n"),
        { parse_mode: parseMode, ...noLinkPreview, ...confirmFlowKeyboard("broadcast") } as never,
      );
      return true;
    }
    return false;
  }

  private async continueServiceFlow(ctx: BotContext, user: UserRecord, step: string, data: StateData, text: string) {
    if (step === "title") {
      const title = text.trim();
      if (!title || title.length > maxServiceTitleLength) {
        await ctx.reply(`Название услуги должно быть от 1 до ${maxServiceTitleLength} символов.`);
        return;
      }
      this.repos.setState(user.telegram_id, "create_service", "price", { title });
      await ctx.reply(
        [
          `Цена должна быть целым числом от 0 до ${formatAmount(maxEconomyAmount)}.`,
          "",
          "Пример: <code>150</code>",
        ].join("\n"),
        { parse_mode: parseMode, ...cancelFlowKeyboard() } as never,
      );
      return;
    }
    if (step === "price") {
      const price = Number(text.replace(/\s+/g, ""));
      if (!Number.isInteger(price) || price < 0 || price > maxEconomyAmount) {
        await ctx.reply(`Цена должна быть целым числом от 0 до ${formatAmount(maxEconomyAmount)}.`);
        return;
      }
      this.repos.setState(user.telegram_id, "create_service", "description", { ...data, price });
      await ctx.reply(
        [
          "Теперь введи описание услуги.",
          "",
          `До ${formatAmount(maxServiceDescriptionLength)} символов. Лучше написать, что получает участник и кто подтверждает выдачу.`,
        ].join("\n"),
        cancelFlowKeyboard(),
      );
      return;
    }
    if (step === "description") {
      const description = text.trim();
      if (!description || description.length > maxServiceDescriptionLength) {
        await ctx.reply(`Описание услуги должно быть от 1 до ${maxServiceDescriptionLength} символов.`);
        return;
      }
      this.repos.setState(user.telegram_id, "create_service", "approval", { ...data, description });
      await ctx.reply("Как выдавать услугу?", approvalModeKeyboard());
      return;
    }
    if (step === "pricing_values") {
      const prices = this.parsePriceList(text);
      if (!prices) {
        await ctx.reply("Введи только целые числа через пробел или запятую. Пример: 70 160 260");
        return;
      }
      if (prices.length < 2) {
        await ctx.reply("Нужно минимум две цены. Пример: 70 160 260");
        return;
      }
      if (prices.some((price) => price > maxEconomyAmount)) {
        await ctx.reply(`Каждая цена должна быть не больше ${formatAmount(maxEconomyAmount)}.`);
        return;
      }
      await this.previewService(ctx, user.telegram_id, {
        ...data,
        pricingConfig: { prices },
      });
      return;
    }
    if (step === "pricing_step") {
      const stepValue = Number(text.replace(/\s+/g, ""));
      if (!Number.isInteger(stepValue) || stepValue <= 0 || stepValue > maxEconomyAmount) {
        await ctx.reply(`Шаг должен быть положительным целым числом до ${formatAmount(maxEconomyAmount)}. Например: 80`);
        return;
      }
      await this.previewService(ctx, user.telegram_id, {
        ...data,
        pricingConfig: { start: Number(data.price), step: stepValue },
      });
    }
  }

  private async setServiceApproval(ctx: BotContext, requiresApproval: boolean) {
    const admin = await this.requireAdmin(ctx);
    if (!admin || !ctx.from) return;
    const state = this.repos.getState(ctx.from.id);
    if (!state || state.flow !== "create_service") throw new Error("Сценарий создания услуги не найден");
    const data: StateData = { ...this.parseStateData(state.data), requiresApproval };
    this.repos.setState(ctx.from.id, "create_service", "pricing_mode", data);
    await render(
      ctx,
      [
        "<b>Динамическая цена</b>",
        "",
        "Можно оставить обычную фиксированную цену.",
        "",
        "Если цена должна дорожать после покупок, выбери один из режимов ниже.",
        "",
        "Ступени, потом последняя: 70 -> 160 -> 260 -> 260...",
        "",
        "Ступени, потом стоп: 70 -> 160 -> 260, затем покупка закрыта.",
        "",
        "Каждый раз +шаг: 80 -> 160 -> 240...",
      ].join("\n"),
      servicePricingModeKeyboard(),
    );
  }

  private async setServicePricingMode(ctx: BotContext, mode: string) {
    const admin = await this.requireAdmin(ctx);
    if (!admin || !ctx.from) return;
    const state = this.repos.getState(ctx.from.id);
    if (!state || state.flow !== "create_service") throw new Error("Сценарий создания услуги не найден");
    const data: StateData = { ...this.parseStateData(state.data), pricingType: mode };

    if (mode === "fixed") {
      await this.previewService(ctx, ctx.from.id, { ...data, pricingConfig: {} });
      return;
    }
    if (mode === "ladder_once" || mode === "ladder_repeat_last") {
      this.repos.setState(ctx.from.id, "create_service", "pricing_values", data);
      await render(
        ctx,
        [
          "<b>Ступени цены</b>",
          "",
          "Введи цены через пробел или запятую.",
          "",
          `Минимум две цены. Каждая цена от 0 до ${formatAmount(maxEconomyAmount)}.`,
          "",
          "Первая цена станет ценой первой покупки.",
          "",
          "Пример: <code>70 160 260</code>",
        ].join("\n"),
        cancelFlowKeyboard(),
      );
      return;
    }
    if (mode === "incremental") {
      this.repos.setState(ctx.from.id, "create_service", "pricing_step", data);
      await render(
        ctx,
        [
          "<b>Постоянное увеличение</b>",
          "",
          `Базовая цена: <b>${formatCinders(Number(data.price))}</b>`,
          "",
          `Введи, на сколько Угольков цена будет увеличиваться после каждой покупки. Максимум ${formatAmount(maxEconomyAmount)}.`,
          "",
          "Пример: <code>80</code>",
        ].join("\n"),
        cancelFlowKeyboard(),
      );
      return;
    }
    throw new Error("Неизвестный режим цены");
  }

  private async previewService(ctx: BotContext, telegramId: number, data: StateData) {
    const pricingType = String(data.pricingType ?? "fixed");
    const pricingConfig = (data.pricingConfig ?? {}) as { prices?: number[]; start?: number; step?: number };
    this.repos.setState(telegramId, "create_service", "confirm", { ...data, pricingType, pricingConfig });
    await render(
      ctx,
      [
        "<b>Проверь услугу:</b>",
        "",
        `Название: <b>${escapeHtml(String(data.title))}</b>`,
        `Базовая цена: <b>${formatCinders(Number(data.price))}</b>`,
        `Выдача: <b>${data.requiresApproval ? "ручная" : "автоматическая"}</b>`,
        `Тип цены: <b>${this.servicePricingLabel(pricingType, pricingConfig)}</b>`,
        "",
        "<b>Описание:</b>",
        escapeHtml(String(data.description)),
      ].join("\n"),
      confirmFlowKeyboard("service"),
    );
  }

  private async confirmService(ctx: BotContext) {
    const admin = await this.requireAdmin(ctx);
    if (!admin || !ctx.from) return;
    const state = this.repos.getState(ctx.from.id);
    if (!state || state.flow !== "create_service") throw new Error("Сценарий создания услуги не найден");
    const data = this.parseStateData(state.data);
    const pricingConfig = (data.pricingConfig ?? {}) as { prices?: number[] };
    const servicePrice = pricingConfig.prices?.[0] ?? Number(data.price);
    const service = this.repos.createService({
      title: String(data.title),
      price: servicePrice,
      description: String(data.description),
      requiresApproval: Boolean(data.requiresApproval),
      category: "general",
      currency: "cinders",
      pricingType: String(data.pricingType ?? "fixed"),
      pricingConfig: data.pricingConfig ?? {},
      createdBy: admin.id,
    });
    this.repos.clearState(ctx.from.id);
    await render(ctx, `Услуга создана: <b>${escapeHtml(service.title)}</b>.`, this.adminKeyboardFor(admin));
  }

  private async continuePromoFlow(ctx: BotContext, user: UserRecord, step: string, data: StateData, text: string) {
    if (step === "code") {
      const code = text.trim().toUpperCase();
      if (!/^[\p{L}\p{N}_-]{3,32}$/u.test(code) || code.length > maxPromoCodeLength) {
        await ctx.reply("Промокод должен быть от 3 до 32 символов: буквы, цифры, _ или -.");
        return;
      }
      this.repos.setState(user.telegram_id, "create_promo", "reward", { code });
      await ctx.reply(
        [
          "Сколько Угольков выдавать за промокод?",
          "",
          `Введи число от 1 до ${formatAmount(maxEconomyAmount)}.`,
        ].join("\n"),
        cancelFlowKeyboard(),
      );
      return;
    }
    if (step === "reward") {
      const reward = Number(text.replace(/\s+/g, ""));
      if (!Number.isInteger(reward) || reward <= 0 || reward > maxEconomyAmount) {
        await ctx.reply(`Награда должна быть положительным целым числом до ${formatAmount(maxEconomyAmount)}.`);
        return;
      }
      this.repos.setState(user.telegram_id, "create_promo", "max_uses", { ...data, reward });
      await ctx.reply(
        [
          "Сколько всего активаций разрешить?",
          "",
          `Введи число от 1 до ${formatAmount(maxPromoActivations)}.`,
        ].join("\n"),
        cancelFlowKeyboard(),
      );
      return;
    }
    if (step === "max_uses") {
      const maxUses = Number(text.replace(/\s+/g, ""));
      if (!Number.isInteger(maxUses) || maxUses <= 0 || maxUses > maxPromoActivations) {
        await ctx.reply(`Количество активаций должно быть положительным целым числом до ${formatAmount(maxPromoActivations)}.`);
        return;
      }
      const nextData: StateData = { ...data, maxUses };
      this.repos.setState(user.telegram_id, "create_promo", "confirm", nextData);
      await ctx.reply(
        [
          "<b>Проверь промокод:</b>",
          "",
          `Код: <b>${escapeHtml(String(nextData.code))}</b>`,
          `Награда: <b>${formatCinders(Number(nextData.reward))}</b>`,
          "",
          `Активаций: <b>${formatAmount(maxUses)}</b>`,
        ].join("\n"),
        { parse_mode: parseMode, ...confirmFlowKeyboard("promo") },
      );
    }
  }

  private async continueCompensationFlow(
    ctx: BotContext,
    developer: UserRecord,
    step: string,
    data: StateData,
    text: string,
  ) {
    if (ctx.chat?.type !== "private") {
      this.repos.clearState(developer.telegram_id);
      await ctx.reply("Компенсацию можно оформить только в ЛС с ботом.");
      return;
    }

    if (step === "reason") {
      const reason = text.trim();
      if (!reason || reason.length > maxCompensationReasonLength) {
        await ctx.reply(`Причина должна быть от 1 до ${formatAmount(maxCompensationReasonLength)} символов.`, cancelFlowKeyboard());
        return;
      }

      this.repos.setState(developer.telegram_id, "compensation", "amount", { reason });
      await ctx.reply(
        [
          `${pe(premiumEmoji.gift, "🎁")} <b>Компенсация</b>`,
          "",
          "Шаг 2: введи количество Угольков для каждого участника.",
          "",
          `Целое число от 1 до ${formatAmount(maxEconomyAmount)}.`,
        ].join("\n"),
        { parse_mode: parseMode, ...cancelFlowKeyboard() } as never,
      );
      return;
    }

    if (step === "amount") {
      const reason = String(data.reason ?? "").trim();
      const amount = Number(text.replace(/\s+/g, ""));
      if (!reason) {
        this.repos.clearState(developer.telegram_id);
        await ctx.reply("Причина компенсации потеряна. Начни заново.");
        return;
      }
      if (!Number.isInteger(amount) || amount <= 0 || amount > maxEconomyAmount) {
        await ctx.reply(`Количество должно быть целым числом от 1 до ${formatAmount(maxEconomyAmount)}.`);
        return;
      }

      const preview = this.repos.previewCompensation(amount, this.compensationExcludedTelegramIds());
      if (preview.recipients.length === 0) {
        await ctx.reply("Нет подходящих получателей: developer, owner и админы исключены.", this.adminKeyboardFor(developer));
        this.repos.clearState(developer.telegram_id);
        return;
      }
      if (preview.blocked.length > 0) {
        await ctx.reply(this.compensationBlockedText(amount, preview.blocked), {
          parse_mode: parseMode,
          ...noLinkPreview,
          ...cancelFlowKeyboard(),
        } as never);
        return;
      }

      this.repos.setState(developer.telegram_id, "compensation", "confirm", { reason, amount });
      await ctx.reply(this.compensationPreviewText(reason, amount, preview.recipients.length, preview.excludedCount), {
        parse_mode: parseMode,
        ...noLinkPreview,
        ...compensationConfirmKeyboard(),
      } as never);
    }
  }

  private async confirmCompensation(ctx: BotContext) {
    const developer = await this.requireDeveloper(ctx);
    if (!developer || !ctx.from || !ctx.chat) return;
    const state = this.repos.getState(ctx.from.id);
    if (!state || state.flow !== "compensation" || state.step !== "confirm") {
      throw new Error("Сценарий компенсации не найден");
    }

    const data = this.parseStateData(state.data) as CompensationData;
    const reason = String(data.reason ?? "").trim();
    const amount = Number(data.amount);
    if (!reason || !Number.isInteger(amount) || amount <= 0 || amount > maxEconomyAmount) {
      throw new Error("Данные компенсации некорректны");
    }

    const result = this.repos.applyCompensation({
      amount,
      reason,
      developerUserId: developer.id,
      excludedTelegramIds: this.compensationExcludedTelegramIds(),
    });
    this.repos.clearState(ctx.from.id);
    await ctx.answerCbQuery("Компенсация начислена").catch(() => undefined);

    const statusMessage = await ctx.reply("<b>Компенсация начислена. Отправляю уведомления...</b>", { parse_mode: parseMode });
    let notified = 0;
    let failed = 0;
    for (const recipient of result.recipients) {
      try {
        await ctx.telegram.sendMessage(recipient.telegram_id, this.compensationNotificationText(reason, amount), {
          parse_mode: parseMode,
          ...noLinkPreview,
        } as never);
        notified += 1;
        await new Promise((resolve) => setTimeout(resolve, broadcastDelayMs));
      } catch (error) {
        failed += 1;
        logger.warn({ error, telegramId: recipient.telegram_id }, "compensation notification failed");
      }
    }

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      undefined,
      [
        `${pe(premiumEmoji.check, "✅")} <b>Компенсация завершена</b>`,
        "",
        `Начислено участникам: <b>${formatAmount(result.recipients.length)}</b>`,
        `Сумма каждому: <b>${formatCinders(amount)}</b>`,
        `Исключено: <b>${formatAmount(result.excludedCount)}</b>`,
        "",
        `Уведомлено: <b>${formatAmount(notified)}</b>`,
        `Ошибок доставки: <b>${formatAmount(failed)}</b>`,
      ].join("\n"),
      { parse_mode: parseMode, ...this.adminKeyboardFor(developer) } as never,
    );
  }

  private compensationPreviewText(reason: string, amount: number, recipientsCount: number, excludedCount: number) {
    return [
      `${pe(premiumEmoji.gift, "🎁")} <b>Подтверждение компенсации</b>`,
      "",
      `${pe(premiumEmoji.info, "ℹ")} Причина:`,
      escapeHtml(reason),
      "",
      `${pe(premiumEmoji.cinder, "💎")} Каждому участнику: <b>${formatCinders(amount)}</b>`,
      `${pe(premiumEmoji.people, "👥")} Получателей: <b>${formatAmount(recipientsCount)}</b>`,
      `${pe(premiumEmoji.lockClosed, "🔒")} Исключено: <b>${formatAmount(excludedCount)}</b>`,
      "",
      "Developer, owner и админы не получат компенсацию. Если подтвердить, начисление пройдет одной транзакцией.",
    ].join("\n");
  }

  private compensationBlockedText(amount: number, blocked: { user: UserRecord; freeSpace: number }[]) {
    const examples = blocked
      .slice(0, 10)
      .map((item, index) => `${index + 1}. ${mentionUser(item.user)} - свободно ${formatCinders(item.freeSpace)}`)
      .join("\n");
    const rest = blocked.length > 10 ? `\n...и еще ${formatAmount(blocked.length - 10)}.` : "";

    return [
      `${pe(premiumEmoji.cross, "❌")} <b>Компенсация не начата</b>`,
      "",
      `Для полной компенсации нужно место под <b>${formatCinders(amount)}</b> у каждого получателя.`,
      `Не хватает лимита у: <b>${formatAmount(blocked.length)}</b> участников.`,
      "",
      examples + rest,
      "",
      "Начисление не выполнено никому. Укажи меньшую сумму или сначала освободи/увеличь лимиты.",
    ].join("\n");
  }

  private compensationNotificationText(reason: string, amount: number) {
    return [
      `${pe(premiumEmoji.gift, "🎁")} <b>Компенсация</b>`,
      "",
      `${pe(premiumEmoji.info, "ℹ")} Причина:`,
      escapeHtml(reason),
      "",
      `${pe(premiumEmoji.cinder, "💎")} Начислено: <b>${formatCinders(amount)}</b>`,
    ].join("\n");
  }

  private async confirmPromo(ctx: BotContext) {
    const admin = await this.requireAdmin(ctx);
    if (!admin || !ctx.from) return;
    const state = this.repos.getState(ctx.from.id);
    if (!state || state.flow !== "create_promo") throw new Error("Сценарий создания промокода не найден");
    const data = this.parseStateData(state.data);
    const promo = this.repos.createPromo({
      code: String(data.code),
      reward: Number(data.reward),
      maxUses: Number(data.maxUses),
      createdBy: admin.id,
    });
    this.repos.clearState(ctx.from.id);
    await render(ctx, `Промокод создан: <b>${escapeHtml(promo.code)}</b>.`, this.adminKeyboardFor(admin));
  }

  private async continueCreateTitleFlow(ctx: BotContext, admin: UserRecord, text: string) {
    const name = text.trim();
    if (!name || name.length > 48) {
      await ctx.reply("Название титула должно быть от 1 до 48 символов.");
      return;
    }
    if (this.repos.getTitleByName(name)) {
      await ctx.reply("Такой титул уже существует.");
      return;
    }
    const title = this.repos.createTitle({ name, createdBy: admin.id });
    this.repos.clearState(admin.telegram_id);
    await render(ctx, `Титул создан: <b>${escapeHtml(title.name)}</b>.`, titlesMenuKeyboard());
  }

  private async continueAssignTitleFlow(ctx: BotContext, admin: UserRecord, text: string) {
    const [userPart, titlePart] = text.split("|").map((part) => part.trim());
    if (!userPart || !titlePart) {
      await ctx.reply("Пример: @username | Лучший угольщик");
      return;
    }
    const target = this.repos.getUserByUsername(userPart);
    if (!target) {
      await ctx.reply("Пользователь не найден в базе.");
      return;
    }
    const title = this.repos.getTitleByName(titlePart);
    if (!title || !title.is_active) {
      await ctx.reply("Титул не найден или выключен.");
      return;
    }
    this.repos.assignTitle(target.id, title.name);
    this.repos.clearState(admin.telegram_id);
    await render(ctx, `Титул <b>${escapeHtml(title.name)}</b> выдан ${mentionUser(target)}.`, titlesMenuKeyboard());
  }

  private async continueRemoveTitleFlow(ctx: BotContext, admin: UserRecord, text: string) {
    const target = this.repos.getUserByUsername(text.trim());
    if (!target) {
      await ctx.reply("Пользователь не найден в базе.");
      return;
    }
    this.repos.assignTitle(target.id, null);
    this.repos.clearState(admin.telegram_id);
    await render(ctx, `Титул снят с ${mentionUser(target)}.`, titlesMenuKeyboard());
  }

  private async continuePriceAdjustmentFlow(
    ctx: BotContext,
    admin: UserRecord,
    step: string,
    data: StateData,
    text: string,
  ) {
    if (step === "user") {
      const target = this.findUserByAdminInput(text);
      if (!target) {
        await ctx.reply("Пользователь не найден в базе бота. Он должен сначала написать боту /start.");
        return;
      }
      const currentAdjustment = this.repos.getUserPriceAdjustment(target.id);
      this.repos.setState(admin.telegram_id, "price_adjustment", "amount", { targetUserId: target.id });
      await ctx.reply(
        [
          `<b>${mentionUser(target)}</b>`,
          "",
          `Текущая персональная наценка: <b>${formatCinders(currentAdjustment)}</b>.`,
          "",
          `Введи сумму наценки от 0 до ${formatCinders(maxEconomyAmount)}.`,
          "0 снимет персональную наценку.",
        ].join("\n"),
        { parse_mode: parseMode, ...cancelFlowKeyboard() } as never,
      );
      return;
    }

    if (step === "amount") {
      const targetUserId = Number(data.targetUserId);
      const target = Number.isInteger(targetUserId) ? this.repos.getUserById(targetUserId) : undefined;
      if (!target) {
        this.repos.clearState(admin.telegram_id);
        await ctx.reply("Пользователь больше не найден в базе. Настройка отменена.");
        return;
      }

      const amount = Number(text.replace(/\s+/g, ""));
      if (!Number.isInteger(amount) || amount < 0 || amount > maxEconomyAmount) {
        await ctx.reply(`Введи целое число от 0 до ${formatAmount(maxEconomyAmount)}.`);
        return;
      }

      this.repos.setUserPriceAdjustment(target.id, amount, admin.id);
      this.repos.clearState(admin.telegram_id);
      const message =
        amount > 0
          ? `Для ${mentionUser(target)} установлена персональная наценка <b>+${formatCinders(amount)}</b> ко всем услугам за Угольки.`
          : `Персональная наценка для ${mentionUser(target)} снята.`;
      await render(ctx, message, this.adminKeyboardFor(admin));
    }
  }

  private async continueDonorTitleFlow(ctx: BotContext, user: UserRecord, text: string) {
    if (this.repos.donorTitleActionsLeft(user) <= 0) {
      this.repos.clearState(user.telegram_id);
      await ctx.reply("Не осталось действий с донатным титулом.");
      return;
    }
    let titleHtml: string;
    try {
      titleHtml = sanitizeDonorTitleHtml(text);
    } catch (error) {
      await ctx.reply(error instanceof Error ? error.message : "Не удалось сохранить титул.");
      return;
    }

    this.repos.setDonorTitle(user.id, titleHtml);
    this.repos.clearState(user.telegram_id);
    await render(ctx, `Донатный титул сохранен:\n\n${titleHtml}`, donorTitleKeyboard(true, this.repos.donorTitleActionsLeft(this.repos.getUserByTelegramId(user.telegram_id)!)));
  }

  private async confirmBroadcast(ctx: BotContext) {
    const admin = await this.requireAdmin(ctx);
    if (!admin || !ctx.from) return;
    const state = this.repos.getState(ctx.from.id);
    if (state?.flow === "broadcast") {
      const broadcastData = this.parseStateData(state.data) as BroadcastData;
      if (state.step !== "confirm") throw new Error("Сначала проверь предпросмотр рассылки");
      if (!String(broadcastData.text ?? "").trim()) throw new Error("Текст рассылки не найден");
      this.repos.clearState(ctx.from.id);
      await this.cleanupBroadcastPreview(ctx, broadcastData);

      const statusMessage = await ctx.reply("<b>Рассылка начата...</b>", { parse_mode: parseMode });
      let broadcastSent = 0;
      let broadcastFailed = 0;
      const recipients = this.repos.listBroadcastUsers();
      for (const user of recipients) {
        try {
          await this.sendBroadcastPayload(user.telegram_id, broadcastData);
          broadcastSent += 1;
          await new Promise((resolve) => setTimeout(resolve, broadcastDelayMs));
        } catch (error) {
          broadcastFailed += 1;
          logger.warn({ error, telegramId: user.telegram_id }, "broadcast delivery failed");
        }
      }

      await this.bot.telegram.editMessageText(
        ctx.chat!.id,
        statusMessage.message_id,
        undefined,
        [
          "<b>Рассылка завершена</b>",
          "",
          `Получателей: <b>${formatAmount(recipients.length)}</b>`,
          `Успешно: <b>${formatAmount(broadcastSent)}</b>`,
          `Ошибок: <b>${formatAmount(broadcastFailed)}</b>`,
        ].join("\n"),
        { parse_mode: parseMode, ...this.adminKeyboardFor(admin) } as never,
      );
      await ctx.answerCbQuery().catch(() => undefined);
      return;
    }
    if (!state || state.flow !== "broadcast") throw new Error("Сценарий рассылки не найден");

  }

  private async cancelFlow(ctx: BotContext) {
    if (!ctx.from) return;
    const user = await this.ensureUser(ctx);
    const state = this.repos.getState(ctx.from.id);
    this.repos.clearState(ctx.from.id);
    await ctx.answerCbQuery?.().catch(() => undefined);
    if (state?.flow === "donor_title") {
      await render(ctx, "Настройка титула отменена.", profileKeyboard(this.repos.donorStarsTotal(user.id) > 0));
      return;
    }
    await render(ctx, "Действие отменено.", this.isAdmin(user) ? this.adminKeyboardFor(user) : backHomeKeyboard());
  }

  private async cancelBroadcast(ctx: BotContext) {
    if (!ctx.from) return;
    const state = this.repos.getState(ctx.from.id);
    const data = state?.flow === "broadcast" ? (this.parseStateData(state.data) as BroadcastData) : {};
    this.repos.clearState(ctx.from.id);
    await this.cleanupBroadcastPreview(ctx, data);
    const user = await this.ensureUser(ctx);
    await render(ctx, "Рассылка отменена.", this.adminKeyboardFor(user));
    await ctx.answerCbQuery().catch(() => undefined);
  }

  private async handleDotCommand(ctx: BotContext, user: UserRecord, text: string) {
    const [command, ...rest] = text.slice(1).split(/\s+/);
    const lower = command.toLowerCase();

    try {
      if (lower === "админ") return this.showAdmin(ctx);
      if (lower === "жар") return this.showTop(ctx, 0, "weekly");
      if (lower === "подарить") return this.commandGift(ctx, user, rest);
      if (lower === "угольки") return this.commandBalance(ctx, rest);
      if (lower === "мои" && rest[0]?.toLowerCase() === "угольки") return this.replyProfile(ctx, user);
      if (lower === "промокод") return this.commandPromo(ctx, user, rest);
      if (lower === "компенсация") return this.startCompensationFromCommand(ctx, user);
      if (lower === "разжечь" || lower === "выдать") return this.commandGrant(ctx, user, rest);
      if (lower === "пригасить") return this.commandTake(ctx, user, rest);
    } catch (error) {
      await ctx.reply(error instanceof Error ? error.message : "Не удалось выполнить команду.");
      return;
    }
  }

  private async commandGift(ctx: BotContext, from: UserRecord, args: string[]) {
    const target = this.resolveTargetUser(ctx, args[0]);
    const amountText = target.usedReply ? args[0] : args[1];
    const amount = Number(amountText);
    if (!target.user) throw new Error("Пользователь не найден в базе. Он должен сначала написать боту /start.");
    if (!Number.isInteger(amount) || amount <= 0) throw new Error("Пример: .подарить @username 50");
    if (!this.hasCinderSpace(target.user, amount)) {
      await ctx.reply(this.cinderLimitRecipientErrorText(target.user, amount, "gift"), {
        parse_mode: parseMode,
        ...noLinkPreview,
      } as never);
      return;
    }
    if (this.isRateLimited(from.telegram_id, "gift", 4, 60_000)) {
      throw new Error("Слишком много переводов подряд. Попробуй через минуту.");
    }

    if (!this.isAdmin(from)) {
      const stats = this.repos.transferStatsSince(from.id, this.sqliteDateTime(Date.now() - 24 * 60 * 60 * 1000));
      if (stats.count >= 10) throw new Error("Лимит переводов на сегодня исчерпан. Можно сделать до 10 переводов в сутки.");
      if (stats.total + amount > 1000) throw new Error("Суточный лимит переводов: 1000 Угольков.");
    }

    this.repos.transfer(from.id, target.user.id, amount);
    await this.replyWithEffect(
      ctx,
      `${mentionUser(from)} подарил ${mentionUser(target.user)} <b>${formatCinders(amount)}</b>.`,
      messageEffects.heart,
      { parse_mode: parseMode, ...noLinkPreview } as never,
    );
  }

  private async commandBalance(ctx: BotContext, args: string[]) {
    const username = args[0];
    if (!username) throw new Error("Пример: .угольки @username");
    const user = this.repos.getUserByUsername(username);
    if (!user) throw new Error("Пользователь не найден в базе.");
    await this.replyProfile(ctx, user);
  }

  private async commandPromo(ctx: BotContext, user: UserRecord, args: string[]) {
    const code = args.join(" ").trim();
    if (!code) throw new Error("Пример: .промокод ЛЕТО2026");
    const promoPreview = this.repos.getPromoByCode(code);
    const unavailableText = this.promoUnavailableText(user, code, promoPreview);
    if (unavailableText) {
      await ctx.reply(unavailableText, { parse_mode: parseMode, ...noLinkPreview } as never);
      return;
    }

    if (this.isRateLimited(user.telegram_id, "promo", 5, 10 * 60_000)) {
      throw new Error("Слишком много попыток активации промокода. Попробуй позже.");
    }
    const latest = this.repos.latestPromoRedemption(user.id);
    if (latest && Date.now() - this.parseDbDate(latest.created_at).getTime() < 60_000) {
      throw new Error("Промокоды можно активировать не чаще одного раза в минуту.");
    }

    const promo = this.repos.redeemPromo(user, code);
    await this.replyWithEffect(
      ctx,
      `Промокод активирован. Начислено <b>${formatCinders(promo.reward)}</b>.`,
      messageEffects.celebration,
      {
        parse_mode: parseMode,
        ...noLinkPreview,
      } as never,
    );
  }

  private async commandGrant(ctx: BotContext, admin: UserRecord, args: string[]) {
    if (!this.isAdmin(admin)) throw new Error("Команда доступна только админам.");
    const target = this.resolveTargetUser(ctx, args[0]);
    const amountText = target.usedReply ? args[0] : args[1];
    const amount = Number(amountText);
    if (!target.user) {
      throw new Error("Пользователь не найден в базе бота. Он должен сначала написать боту /start.");
    }
    if (!Number.isInteger(amount) || amount <= 0) throw new Error("Пример: .разжечь @username 100 или .выдать @username 100");
    if (amount > maxEconomyAmount) throw new Error(`Максимальное разовое начисление: ${formatAmount(maxEconomyAmount)} Угольков.`);
    if (!this.hasCinderSpace(target.user, amount)) {
      await ctx.reply(this.cinderLimitRecipientErrorText(target.user, amount, "grant"), {
        parse_mode: parseMode,
        ...noLinkPreview,
      } as never);
      return;
    }
    this.repos.adjustBalance({
      userId: target.user.id,
      amount,
      type: "grant",
      adminUserId: admin.id,
      reason: "Админское начисление",
    });
    await this.replyWithEffect(
      ctx,
      `${mentionUser(target.user)} получил <b>${formatCinders(amount)}</b>.`,
      messageEffects.like,
      {
        parse_mode: parseMode,
        ...noLinkPreview,
      } as never,
    );
  }

  private async commandTake(ctx: BotContext, admin: UserRecord, args: string[]) {
    if (!this.isAdmin(admin)) throw new Error("Команда доступна только админам.");
    const target = this.resolveTargetUser(ctx, args[0]);
    const amount = Number(args[1]);
    if (!target.user || !Number.isInteger(amount) || amount <= 0) throw new Error("Пример: .пригасить @username 50");
    if (amount > maxEconomyAmount) throw new Error(`Максимальное разовое списание: ${formatAmount(maxEconomyAmount)} Угольков.`);
    this.repos.adjustBalance({
      userId: target.user.id,
      amount: -amount,
      type: "deduct",
      adminUserId: admin.id,
      reason: "Админское списание",
    });
    await ctx.reply(`У ${mentionUser(target.user)} списано <b>${formatCinders(amount)}</b>.`, {
      parse_mode: parseMode,
      ...noLinkPreview,
    } as never);
  }

  private async startCompensationFromCommand(ctx: BotContext, user: UserRecord) {
    if (!this.isDeveloper(user)) throw new Error("Команда доступна только разработчику.");
    if (ctx.chat?.type !== "private") {
      await ctx.reply("Компенсацию можно оформить только в ЛС с ботом.");
      return;
    }
    await this.startCompensation(ctx);
  }

  private async replyWithEffect(
    ctx: BotContext,
    text: string,
    effectId: MessageEffectId,
    extra?: Parameters<BotContext["reply"]>[1],
  ) {
    try {
      await ctx.reply(text, { ...(extra ?? {}), message_effect_id: effectId } as never);
    } catch {
      await ctx.reply(text, extra as never);
    }
  }

  private async replyProfile(ctx: BotContext, user: UserRecord) {
    await ctx.reply(profileText(user), { parse_mode: parseMode, ...noLinkPreview } as never);
  }

  private resolveTargetUser(ctx: BotContext, arg?: string): { user?: UserRecord; usedReply: boolean } {
    const message = ctx.message as Message.TextMessage | undefined;
    const replyUser = message?.reply_to_message?.from;
    if (replyUser && (!arg || /^\d+$/.test(arg))) {
      return { user: this.repos.getUserByTelegramId(replyUser.id), usedReply: true };
    }
    if (!arg) return { usedReply: false };
    return { user: this.repos.getUserByUsername(arg), usedReply: false };
  }

  private findUserByAdminInput(input: string) {
    const value = input.trim();
    if (!value) return undefined;
    if (/^\d+$/.test(value)) return this.repos.getUserByTelegramId(Number(value));
    return this.repos.getUserByUsername(value);
  }

  private getBroadcastDataOrThrow(telegramId: number, expectedStep?: string) {
    const state = this.repos.getState(telegramId);
    if (!state || state.flow !== "broadcast") throw new Error("Сценарий рассылки не найден");
    if (expectedStep && state.step !== expectedStep) throw new Error("Этот шаг рассылки уже неактуален");
    return this.parseStateData(state.data) as BroadcastData;
  }

  private broadcastMediaFromMessage(message: BroadcastMessage) {
    const photoFileId = message.photo?.at(-1)?.file_id ?? null;
    return {
      photoFileId,
      videoFileId: message.video?.file_id ?? null,
      animationFileId: message.animation?.file_id ?? null,
    };
  }

  private parseBroadcastButtonText(message: BroadcastMessage) {
    const text = (message.text ?? "").trim();
    const customEmoji = message.entities?.find(
      (entity) => entity.type === "custom_emoji" && typeof entity.custom_emoji_id === "string",
    );
    if (!customEmoji) return { text, emojiId: null };

    const start = this.utf16IndexToStringIndex(text, customEmoji.offset);
    const end = this.utf16IndexToStringIndex(text, customEmoji.offset + customEmoji.length);
    const cleanedText = `${text.slice(0, start)}${text.slice(end)}`.trim();
    return { text: cleanedText, emojiId: customEmoji.custom_emoji_id ?? null };
  }

  private isValidBroadcastUrl(value: string) {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }

  private broadcastReplyMarkup(data: BroadcastData) {
    if (!data.buttonText || !data.buttonUrl) return undefined;
    return {
      inline_keyboard: [
        [
          {
            text: data.buttonText,
            url: data.buttonUrl,
            ...(data.buttonEmojiId ? { icon_custom_emoji_id: data.buttonEmojiId } : {}),
          },
        ],
      ],
    };
  }

  private async showBroadcastPreview(ctx: BotContext, user: UserRecord, data: BroadcastData) {
    const nextData: BroadcastData = { ...data, controlMessageId: data.controlMessageId ?? this.callbackMessageId(ctx) };
    await this.cleanupBroadcastPreview(ctx, nextData);
    await this.editBroadcastControl(
      ctx,
      nextData,
      [
        "<b>Рассылка</b>",
        "",
        "Предпросмотр готов.",
        "",
        "Проверь сообщение ниже и подтверди отправку.",
      ].join("\n"),
      broadcastCancelKeyboard(),
    );

    const header = await ctx.reply("<b>Предпросмотр рассылки:</b>", { parse_mode: parseMode });
    const preview = await this.sendBroadcastPayload(ctx.chat!.id, nextData);
    const confirm = await ctx.reply("<b>Отправить эту рассылку?</b>", { parse_mode: parseMode, ...broadcastConfirmKeyboard() } as never);

    this.repos.setState(user.telegram_id, "broadcast", "confirm", {
      ...nextData,
      previewHeaderMessageId: header.message_id,
      previewMessageId: preview.message_id,
      confirmMessageId: confirm.message_id,
    });
  }

  private async sendBroadcastPayload(chatId: number, data: BroadcastData) {
    const text = String(data.text ?? "");
    const reply_markup = this.broadcastReplyMarkup(data);
    const entities = (data.entities ?? []) as never;

    if (data.photoFileId) {
      return this.bot.telegram.sendPhoto(chatId, data.photoFileId, {
        caption: text,
        caption_entities: entities,
        reply_markup,
      } as never);
    }
    if (data.videoFileId) {
      return this.bot.telegram.sendVideo(chatId, data.videoFileId, {
        caption: text,
        caption_entities: entities,
        reply_markup,
      } as never);
    }
    if (data.animationFileId) {
      return this.bot.telegram.sendAnimation(chatId, data.animationFileId, {
        caption: text,
        caption_entities: entities,
        reply_markup,
      } as never);
    }
    return this.bot.telegram.sendMessage(chatId, text, {
      entities,
      reply_markup,
      ...noLinkPreview,
    } as never);
  }

  private async cleanupBroadcastPreview(ctx: BotContext, data: BroadcastData) {
    if (!ctx.chat) return;
    const messageIds = [data.previewHeaderMessageId, data.previewMessageId, data.confirmMessageId].filter(
      (id): id is number => typeof id === "number",
    );
    for (const messageId of messageIds) {
      await this.bot.telegram.deleteMessage(ctx.chat.id, messageId).catch(() => undefined);
    }
  }

  private async editBroadcastControl(ctx: BotContext, data: BroadcastData, text: string, extra: Parameters<typeof render>[2]) {
    if (!ctx.chat) return;
    if (data.controlMessageId) {
      await this.bot.telegram
        .editMessageText(ctx.chat.id, data.controlMessageId, undefined, text, { parse_mode: parseMode, ...noLinkPreview, ...extra } as never)
        .catch(async () => {
          const message = await ctx.reply(text, { parse_mode: parseMode, ...noLinkPreview, ...extra } as never);
          data.controlMessageId = message.message_id;
        });
      return;
    }
    const message = await ctx.reply(text, { parse_mode: parseMode, ...noLinkPreview, ...extra } as never);
    data.controlMessageId = message.message_id;
  }

  private callbackMessageId(ctx: BotContext) {
    const callbackQuery = ctx.callbackQuery as { message?: { message_id?: number } } | undefined;
    return callbackQuery?.message?.message_id;
  }

  private async deleteUserMessage(ctx: BotContext, messageId: number) {
    if (!ctx.chat) return;
    await this.bot.telegram.deleteMessage(ctx.chat.id, messageId).catch(() => undefined);
  }

  private async requireAdmin(ctx: BotContext) {
    const user = await this.ensureUser(ctx);
    if (!this.isAdmin(user)) {
      await ctx.answerCbQuery?.("Доступно только админам").catch(() => undefined);
      if (!("callback_query" in ctx.update)) await ctx.reply("Доступно только админам.");
      return null;
    }
    return user;
  }

  private async requireDeveloper(ctx: BotContext) {
    const user = await this.ensureUser(ctx);
    if (!this.isDeveloper(user)) {
      await ctx.answerCbQuery?.("Доступно только разработчику").catch(() => undefined);
      if (!("callback_query" in ctx.update)) await ctx.reply("Команда доступна только разработчику.");
      return null;
    }
    return user;
  }

  private isAdmin(user: UserRecord) {
    return user.role === "owner" || user.role === "admin" || user.role === "developer" || this.getConfig().adminIds.has(user.telegram_id);
  }

  private isDeveloper(user: UserRecord) {
    return user.role === "developer" || user.telegram_id === this.getConfig().developerId;
  }

  private adminKeyboardFor(user: UserRecord) {
    return adminKeyboard(this.isDeveloper(user));
  }

  private topExcludedTelegramIds() {
    const developerId = this.getConfig().developerId;
    return typeof developerId === "number" && Number.isInteger(developerId) ? [developerId] : [];
  }

  private compensationExcludedTelegramIds() {
    const config = this.getConfig();
    return [...config.adminIds, config.ownerId, config.developerId].filter(
      (id): id is number => typeof id === "number" && Number.isInteger(id),
    );
  }

  private async ensureUser(ctx: BotContext) {
    if (!ctx.from) throw new Error("Telegram user is missing");
    const config = this.getConfig();
    let role: UserRole = "user";
    if (ctx.from.id === config.ownerId) role = "owner";
    else if (ctx.from.id === config.developerId) role = "developer";
    else if (config.adminIds.has(ctx.from.id)) role = "admin";
    return this.repos.upsertUser({
      telegramId: ctx.from.id,
      username: ctx.from.username ?? null,
      firstName: ctx.from.first_name ?? null,
      lastName: ctx.from.last_name ?? null,
      role,
    });
  }

  private parseStateData(raw: string): StateData {
    try {
      const parsed = JSON.parse(raw) as StateData;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  private isRateLimited(telegramId: number, action: string, limit: number, windowMs: number) {
    const now = Date.now();
    const key = `${telegramId}:${action}`;
    const current = this.rateLimitBuckets.get(key);
    if (!current || current.resetAt <= now) {
      this.rateLimitBuckets.set(key, { count: 1, resetAt: now + windowMs });
      this.pruneRateLimits(now);
      return false;
    }
    current.count += 1;
    return current.count > limit;
  }

  private pruneRateLimits(now: number) {
    if (this.rateLimitBuckets.size < 1000) return;
    for (const [key, bucket] of this.rateLimitBuckets) {
      if (bucket.resetAt <= now) this.rateLimitBuckets.delete(key);
    }
  }

  private sqliteDateTime(timestampMs: number) {
    return new Date(timestampMs).toISOString().replace("T", " ").slice(0, 19);
  }

  private parseDbDate(value: string) {
    return new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  }

  private async renderWithAsset(
    ctx: BotContext,
    text: string,
    extra: Parameters<typeof render>[2],
    assetKey: string,
  ) {
    const fileId = await render(ctx, text, extra, {
      key: assetKey,
      fileId: this.repos.getAssetFileId(assetKey),
      localPath: this.resolveAsset(assetKey),
    });
    if (fileId) this.repos.setAssetFileId(assetKey, fileId);
  }

  private assetMedia(assetKey: string) {
    const fileId = this.repos.getAssetFileId(assetKey);
    if (fileId) return fileId;

    const localPath = this.resolveAsset(assetKey);
    if (!localPath) throw new Error(`Asset not found: ${assetKey}`);
    return Input.fromLocalFile(localPath);
  }

  private cacheAnimationFileId(assetKey: string, message: unknown) {
    if (message && typeof message === "object" && "animation" in message) {
      const fileId = (message as { animation?: { file_id?: string } }).animation?.file_id;
      if (fileId) this.repos.setAssetFileId(assetKey, fileId);
    }
  }

  private textWithCustomEmojiHtml(ctx: BotContext, text: string) {
    const message = ctx.message as Message.TextMessage | undefined;
    const entities = (message?.entities ?? [])
      .filter((entity) => entity.type === "custom_emoji" && "custom_emoji_id" in entity)
      .sort((a, b) => b.offset - a.offset);

    let result = text;
    for (const entity of entities) {
      const customEmojiId = (entity as { custom_emoji_id?: string }).custom_emoji_id;
      if (!customEmojiId) continue;

      const start = this.utf16IndexToStringIndex(result, entity.offset);
      const end = this.utf16IndexToStringIndex(result, entity.offset + entity.length);
      const fallback = result.slice(start, end);
      result = `${result.slice(0, start)}<tg-emoji emoji-id="${customEmojiId}">${fallback}</tg-emoji>${result.slice(end)}`;
    }
    return result;
  }

  private utf16IndexToStringIndex(value: string, utf16Index: number) {
    let codeUnits = 0;
    let stringIndex = 0;
    for (const char of value) {
      if (codeUnits >= utf16Index) break;
      codeUnits += char.length;
      stringIndex += char.length;
    }
    return stringIndex;
  }

  private resolveAsset(relativePath: string) {
    const candidates = [path.resolve(process.cwd(), relativePath), path.resolve(process.cwd(), "game_bot", relativePath)];
    return candidates.find((file) => fs.existsSync(file));
  }
}
