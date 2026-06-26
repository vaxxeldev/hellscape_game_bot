import { Input } from "telegraf";
import type { Context, NarrowedContext } from "telegraf";
import type { Update } from "telegraf/types";
import type { AppConfig } from "../config/env.js";
import type { PromoCodeRecord, PurchaseRecord, ServiceRecord, TitleRecord, UserRecord, WeeklyTopUserRecord } from "../types.js";
import { escapeHtml, formatAmount, formatCinders, mentionUser, usernameOrName } from "../utils/text.js";
import { formatDate, formatDateTime } from "../utils/time.js";
import { pe, premiumEmoji } from "./premiumEmoji.js";

export const parseMode = "HTML" as const;
export const noLinkPreview = {
  link_preview_options: {
    is_disabled: true,
  },
} as const;

export type AnimationAsset = {
  key: string;
  fileId?: string;
  localPath?: string;
};

export type ServiceOfferView = {
  price: number;
  currency: "cinders" | "stars";
  available: boolean;
  purchaseNumber: number;
  rewardCinders?: number;
  stageLabel?: string;
  currentLimit?: number;
  limitTarget?: number;
};

function starsLabel() {
  return `${pe(premiumEmoji.star, "⭐️")} Stars`;
}

export function homeText(user?: UserRecord) {
  const balance = user ? `${pe(premiumEmoji.wallet, "👛")} Баланс: <b>${formatCinders(user.balance)}</b>` : null;

  return [
    `${pe(premiumEmoji.home, "🏘")} <b>Игровая лавка услуг HellScape</b>`,
    "",
    `${pe(premiumEmoji.cinder, "💎")} Здесь хранятся Угольки. Их можно тратить на услуги чата, переводить другим участникам и получать через промокоды или Stars.`,
    "",
    `${pe(premiumEmoji.bot, "🤖")} Начни с профиля или лавки услуг. Команды для общего чата собраны в разделе помощи.`,
    "",
    balance,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function profileText(user: UserRecord) {
  const titleHtml = user.donor_title_html ?? escapeHtml(user.title ?? "Нет титула");
  return [
    `${pe(premiumEmoji.profile, "👤")} <b>Профиль</b>`,
    "",
    `${pe(premiumEmoji.people, "👥")} Пользователь: ${mentionUser(user)}`,
    `${pe(premiumEmoji.settings, "⚙")} Должность: <b>${roleLabel(user.role)}</b>`,
    `${pe(premiumEmoji.tag, "🏷")} Титул: ${titleHtml}`,
    `${pe(premiumEmoji.calendar, "📅")} В базе с: <b>${formatDate(user.joined_at)}</b>`,
    "",
    `${pe(premiumEmoji.wallet, "👛")} Баланс: <b>${formatCinders(user.balance)}</b>`,
    `${pe(premiumEmoji.lockClosed, "🔒")} Лимит: <b>${formatCinders(user.cinder_limit)}</b>`,
    `${pe(premiumEmoji.receiveMoney, "🏧")} Получено всего: <b>${formatCinders(user.total_received)}</b>`,
    `${pe(premiumEmoji.sendMoney, "🪙")} Потрачено всего: <b>${formatCinders(user.total_spent)}</b>`,
  ].join("\n");
}

export function donorTitleText(input: { totalStars: number; actionsLimit: number; actionsUsed: number; titleHtml: string | null }) {
  const actionsLeft = Math.max(0, input.actionsLimit - input.actionsUsed);
  return [
    `${pe(premiumEmoji.cinder, "💎")} <b>Донатный титул</b>`,
    "",
    `${pe(premiumEmoji.money, "🪙")} Поддержано: <b>${formatAmount(input.totalStars)} ${starsLabel()}</b>`,
    `${pe(premiumEmoji.pencil, "🖋")} Смен доступно: <b>${formatAmount(actionsLeft)}</b> / <b>${formatAmount(input.actionsLimit)}</b>`,
    `${pe(premiumEmoji.tag, "🏷")} Сейчас: ${input.titleHtml ?? "не установлен"}`,
    "",
    `Лимит зависит от выбранной поддержки: 10 ${starsLabel()} = 1 смена, 25 = 2, 50 = 3, 100 = 4.`,
    "",
    "Создать или изменить титул тратит 1 смену. Удаление титула бесплатно.",
  ].join("\n");
}

export function servicesText(services: ServiceRecord[]) {
  if (!services.length) {
    return [
      `${pe(premiumEmoji.gift, "🎁")} <b>Услуги</b>`,
      "",
      `${pe(premiumEmoji.info, "ℹ")} Пока услуг нет.`,
    ].join("\n");
  }

  return [
    `${pe(premiumEmoji.gift, "🎁")} <b>Услуги</b>`,
    "",
    `${pe(premiumEmoji.tag, "🏷")} Нажми на услугу, чтобы увидеть цену, условия и способ выдачи.`,
    "",
    `${pe(premiumEmoji.cinder, "💎")} Услуги за Угольки списывают баланс сразу. Если нужна ручная проверка и админ откажет, Угольки вернутся.`,
  ].join("\n");
}

export function serviceText(service: ServiceRecord, user: UserRecord, offer: ServiceOfferView) {
  const enough = offer.currency === "stars" || user.balance >= offer.price;
  const priceLine =
    offer.currency === "stars"
      ? `${pe(premiumEmoji.money, "🪙")} Цена: <b>${formatAmount(offer.price)} ${starsLabel()}</b>`
      : `${pe(premiumEmoji.money, "🪙")} Цена: <b>${formatCinders(offer.price)}</b>`;
  const rewardLine =
    offer.currency === "stars" && offer.rewardCinders
      ? `${pe(premiumEmoji.cinder, "💎")} Начислится: <b>${formatCinders(offer.rewardCinders)}</b>`
      : null;
  const stageLine = offer.stageLabel
    ? `${pe(premiumEmoji.tag, "🏷")} Ступень: <b>${escapeHtml(offer.stageLabel)}</b>`
    : `${pe(premiumEmoji.clock, "⏰")} Покупка: <b>${formatAmount(offer.purchaseNumber)}</b>`;
  const limitLine =
    offer.limitTarget && offer.currentLimit
      ? `${pe(premiumEmoji.lockClosed, "🔒")} Лимит: <b>${formatCinders(offer.currentLimit)}</b> → <b>${formatCinders(offer.limitTarget)}</b>`
      : null;
  const pricingHint = servicePricingHint(service.pricing_type);
  const pricingLines = [priceLine, rewardLine, limitLine, stageLine, pricingHint].filter(Boolean);
  const balanceLines = [
    offer.currency === "cinders" ? `${pe(premiumEmoji.wallet, "👛")} Твой баланс: <b>${formatCinders(user.balance)}</b>` : null,
    `${pe(premiumEmoji.clock, "⏰")} Выдача: <b>${service.requires_approval ? "после подтверждения админом" : "автоматически"}</b>`,
  ].filter(Boolean);

  return [
    `${pe(premiumEmoji.tag, "🏷")} <b>${escapeHtml(service.title)}</b>`,
    "",
    escapeHtml(service.description),
    "",
    ...pricingLines,
    "",
    ...balanceLines,
    "",
    offer.available
      ? enough
        ? offer.currency === "stars"
          ? `${pe(premiumEmoji.check, "✅")} После оплаты Угольки начислятся автоматически.`
          : `${pe(premiumEmoji.check, "✅")} После покупки Угольки будут списаны сразу. При отказе админа они вернутся.`
        : `${pe(premiumEmoji.cross, "❌")} На балансе недостаточно Угольков.`
      : `${pe(premiumEmoji.cross, "❌")} Все доступные ступени этой услуги уже куплены.`,
  ]
    .join("\n");
}

export function topText(users: UserRecord[], page: number, total: number) {
  const start = page * 10;
  const lines = users.map((user, index) => {
    const place = start + index + 1;
    return `${place}. ${escapeHtml(usernameOrName(user))} — <b>${formatCinders(user.balance)}</b>`;
  });

  return [
    `${pe(premiumEmoji.statsChart, "📊")} <b>Топ по Уголькам</b>`,
    "",
    lines.length ? lines.join("\n") : `${pe(premiumEmoji.hidden, "👁")} В топе пока никого нет.`,
    "",
    `${pe(premiumEmoji.people, "👥")} Всего участников в топе: <b>${formatAmount(total)}</b>`,
  ].join("\n");
}

export function weeklyTopText(users: WeeklyTopUserRecord[], page: number, total: number, periodLabel: string) {
  const start = page * 10;
  const lines = users.map((user, index) => {
    const place = start + index + 1;
    return `${place}. ${escapeHtml(usernameOrName(user))} — <b>${formatCinders(user.weekly_score)}</b>`;
  });

  return [
    `${pe(premiumEmoji.statsChart, "📊")} <b>Недельный жар</b>`,
    "",
    `${pe(premiumEmoji.calendar, "📅")} Период: <b>${escapeHtml(periodLabel)}</b>`,
    `${pe(premiumEmoji.gift, "🎁")} Призы каждую неделю: <b>90</b> / <b>60</b> / <b>30</b> Угольков за 1-3 места.`,
    "",
    lines.length ? lines.join("\n") : `${pe(premiumEmoji.hidden, "👁")} На этой неделе в топе пока никого нет.`,
    "",
    `${pe(premiumEmoji.people, "👥")} Всего участников в недельном топе: <b>${formatAmount(total)}</b>`,
  ].join("\n");
}

export function helpText(config: AppConfig) {
  const contact = config.developerUsername
    ? `Связь с разработчиком: @${escapeHtml(config.developerUsername.replace(/^@/, ""))}`
    : "Связь с разработчиком пока не указана.";

  return [
    `${pe(premiumEmoji.info, "ℹ")} <b>Помощь</b>`,
    "",
    `${pe(premiumEmoji.send, "⬆")} ${contact}`,
    "",
    `${pe(premiumEmoji.gift, "🎁")} <b>Как пользоваться:</b>`,
    "Лавка работает в ЛС с ботом. В общем чате можно пользоваться командами через точку.",
    "",
    "Если покупка требует проверки, Угольки списываются сразу и возвращаются при отказе админа.",
    "",
    `${pe(premiumEmoji.code, "🔨")} <b>Команды для чата:</b>`,
    "<code>.подарить @username 50</code> - перевести Угольки. Лимит для участника: 10 переводов и 1000 Угольков в сутки.",
    "<code>.мои угольки</code> - посмотреть свой профиль.",
    "<code>.угольки @username</code> - посмотреть профиль участника.",
    "<code>.жар</code> - открыть недельный топ.",
    "<code>.промокод КОД</code> - активировать промокод.",
    "",
    `${pe(premiumEmoji.lockClosed, "🔒")} Лимит баланса защищает экономику: если Угольки не помещаются, сначала увеличь лимит в лавке или потрать часть баланса.`,
  ].join("\n");
}

export function supportText() {
  return [
    `${pe(premiumEmoji.money, "🪙")} <b>Поддержать разработчика</b>`,
    "",
    `${pe(premiumEmoji.cinder, "💎")} Можно поддержать разработчика через ${starsLabel()}.`,
    "",
    `${pe(premiumEmoji.info, "ℹ")} Выбери сумму ниже. Telegram откроет стандартное окно оплаты.`,
    "",
    `${pe(premiumEmoji.gift, "🎁")} Награда: <b>3 Уголька</b> за каждую ${starsLabel()}.`,
    `${pe(premiumEmoji.tag, "🏷")} После первой поддержки откроется донатный титул в профиле. Его можно оформить с premium emoji и HTML-форматированием.`,
  ].join("\n");
}

export function adminText() {
  return [
    `${pe(premiumEmoji.settings, "⚙")} <b>Админ-панель</b>`,
    "",
    `${pe(premiumEmoji.apps, "📦")} Выбери действие. Все операции с экономикой пишутся в историю транзакций.`,
    "",
    `${pe(premiumEmoji.info, "ℹ")} Для ручных начислений в чате используй <code>.разжечь</code>, для списаний - <code>.пригасить</code>.`,
  ].join("\n");
}

export function statsText(stats: ReturnType<{ stats(): unknown }["stats"]>, topReceivers: UserRecord[]) {
  const s = stats as {
    users: number;
    activeUsers: number;
    totalBalance: number;
    totalIssued: number;
    totalTaken: number;
    totalSpent: number;
    pendingPurchases: number;
    services: number;
    promos: number;
  };
  const receivers = topReceivers.length
    ? topReceivers
        .map((user, index) => `${index + 1}. ${escapeHtml(usernameOrName(user))} — ${formatCinders(user.total_received)}`)
        .join("\n")
    : "нет данных";

  return [
    `${pe(premiumEmoji.statsChart, "📊")} <b>Статистика</b>`,
    "",
    `${pe(premiumEmoji.people, "👥")} Пользователей: <b>${formatAmount(s.users)}</b>`,
    `${pe(premiumEmoji.userApproved, "👤")} Активных: <b>${formatAmount(s.activeUsers)}</b>`,
    `${pe(premiumEmoji.wallet, "👛")} Баланс в обороте: <b>${formatCinders(s.totalBalance)}</b>`,
    `${pe(premiumEmoji.receiveMoney, "🏧")} Выдано всего: <b>${formatCinders(s.totalIssued)}</b>`,
    `${pe(premiumEmoji.sendMoney, "🪙")} Изъято/потрачено: <b>${formatCinders(s.totalTaken)}</b>`,
    `${pe(premiumEmoji.money, "🪙")} Потрачено на услуги: <b>${formatCinders(s.totalSpent)}</b>`,
    `${pe(premiumEmoji.file, "📁")} Ожидают заявки: <b>${formatAmount(s.pendingPurchases)}</b>`,
    `${pe(premiumEmoji.gift, "🎁")} Услуг: <b>${formatAmount(s.services)}</b>`,
    `${pe(premiumEmoji.receiveMoney, "🏧")} Активных промокодов: <b>${formatAmount(s.promos)}</b>`,
    "",
    `${pe(premiumEmoji.growthChart, "📊")} <b>Кому выдавали чаще всего:</b>`,
    receivers,
  ].join("\n");
}

export function purchaseText(purchase: PurchaseRecord) {
  return [
    `${pe(premiumEmoji.file, "📁")} <b>Заявка #${purchase.id}</b>`,
    "",
    `${pe(premiumEmoji.profile, "👤")} Пользователь: ${escapeHtml(usernameOrName(purchase))} (<code>${purchase.telegram_id}</code>)`,
    `${pe(premiumEmoji.gift, "🎁")} Услуга: <b>${escapeHtml(purchase.service_title)}</b>`,
    `${pe(premiumEmoji.money, "🪙")} Цена: <b>${formatCinders(purchase.price)}</b>`,
    `${pe(premiumEmoji.loading, "🔄")} Статус: <b>${purchaseStatusLabel(purchase.status)}</b>`,
    `${pe(premiumEmoji.calendar, "📅")} Создана: <b>${formatDateTime(purchase.created_at)}</b>`,
  ].join("\n");
}

export function promosText() {
  return [
    `${pe(premiumEmoji.receiveMoney, "🏧")} <b>Промокоды</b>`,
    "",
    `${pe(premiumEmoji.pencil, "🖋")} Здесь можно создать промокод, посмотреть активации, выключить или удалить его.`,
    "",
    "Код должен быть коротким и понятным: буквы, цифры, _ или -, без пробелов.",
  ].join("\n");
}

export function promoText(promo: PromoCodeRecord, users: UserRecord[]) {
  const status = promo.is_active ? "включен" : "выключен";
  const activationsLeft = Math.max(0, promo.max_uses - promo.used_count);
  const lastUsers = users.length
    ? users.map((user, index) => `${index + 1}. ${escapeHtml(usernameOrName(user))}`).join("\n")
    : "активаций еще нет";

  return [
    `${pe(premiumEmoji.receiveMoney, "🏧")} <b>Промокод ${escapeHtml(promo.code)}</b>`,
    "",
    `${pe(premiumEmoji.loading, "🔄")} Статус: <b>${status}</b>`,
    `${pe(premiumEmoji.money, "🪙")} Награда: <b>${formatCinders(promo.reward)}</b>`,
    `${pe(premiumEmoji.check, "✅")} Активации: <b>${formatAmount(promo.used_count)}</b> / <b>${formatAmount(promo.max_uses)}</b>`,
    `${pe(premiumEmoji.clock, "⏰")} Осталось: <b>${formatAmount(activationsLeft)}</b>`,
    `${pe(premiumEmoji.calendar, "📅")} Создан: <b>${formatDate(promo.created_at)}</b>`,
    "",
    `${pe(premiumEmoji.people, "👥")} <b>Последние активации:</b>`,
    lastUsers,
  ].join("\n");
}

export function titlesText() {
  return [
    `${pe(premiumEmoji.tag, "🏷")} <b>Титулы</b>`,
    "",
    `${pe(premiumEmoji.pencil, "🖋")} Здесь можно создать титул, включить/выключить его, выдать участнику или забрать у него.`,
  ].join("\n");
}

export function titleText(title: TitleRecord) {
  return [
    `${pe(premiumEmoji.tag, "🏷")} <b>${escapeHtml(title.name)}</b>`,
    "",
    `${pe(premiumEmoji.loading, "🔄")} Статус: <b>${title.is_active ? "включен" : "выключен"}</b>`,
    `${pe(premiumEmoji.calendar, "📅")} Создан: <b>${formatDate(title.created_at)}</b>`,
  ].join("\n");
}

export function starsThanksText(amount: number, cindersReward = amount * 3, expectedReward = cindersReward) {
  const limitLine =
    cindersReward < expectedReward
      ? `${pe(premiumEmoji.info, "ℹ")} Часть награды не поместилась в лимит Угольков.`
      : null;
  return [
    `${pe(premiumEmoji.celebration, "🎉")} <b>Спасибо за поддержку!</b>`,
    "",
    `${pe(premiumEmoji.money, "🪙")} Получено: <b>${formatAmount(amount)} ${starsLabel()}</b>`,
    `${pe(premiumEmoji.cinder, "💎")} Начислено: <b>${formatCinders(cindersReward)}</b>`,
    limitLine,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export async function render(
  ctx: Context,
  text: string,
  extra?: Parameters<Context["reply"]>[1],
  animation?: AnimationAsset,
): Promise<string | undefined> {
  const media = animation?.fileId ?? (animation?.localPath ? Input.fromLocalFile(animation.localPath) : undefined);
  const callbackCtx = ctx as NarrowedContext<Context, Update.CallbackQueryUpdate>;
  if (callbackCtx.callbackQuery) {
    if (media) {
      try {
        const message = await callbackCtx.editMessageMedia(
          {
            type: "animation",
            media,
            caption: text,
            parse_mode: parseMode,
          } as never,
          { ...noLinkPreview, ...extra } as never,
        );
        return extractAnimationFileId(message);
      } catch {
        // Fall back to caption/text editing below. Telegram can reject media edits
        // for older message shapes or transient upload issues.
      }
    }
    try {
      await callbackCtx.editMessageCaption(text, { ...noLinkPreview, ...extra, parse_mode: parseMode } as never);
      return undefined;
    } catch {
      try {
        await callbackCtx.editMessageText(text, { ...noLinkPreview, ...extra, parse_mode: parseMode } as never);
        return undefined;
      } catch {
        await ctx.reply(text, { ...noLinkPreview, ...extra, parse_mode: parseMode } as never);
        return undefined;
      }
    }
  }
  if (media) {
    try {
      const message = await ctx.replyWithAnimation(media, {
        caption: text,
        parse_mode: parseMode,
        ...noLinkPreview,
        ...extra,
      } as never);
      return extractAnimationFileId(message);
    } catch {
      // Fall back to a regular text reply if Telegram rejects the animation upload.
    }
  }
  await ctx.reply(text, { ...noLinkPreview, ...extra, parse_mode: parseMode } as never);
  return undefined;
}

function extractAnimationFileId(message: unknown) {
  if (message && typeof message === "object" && "animation" in message) {
    const animation = (message as { animation?: { file_id?: string } }).animation;
    return animation?.file_id;
  }
  return undefined;
}

export function roleLabel(role: UserRecord["role"]) {
  if (role === "owner") return "Владелец";
  if (role === "developer") return "Разработчик";
  if (role === "admin") return "Админ";
  return "Участник";
}

function purchaseStatusLabel(status: PurchaseRecord["status"]) {
  if (status === "approved") return "Одобрена";
  if (status === "rejected") return "Отклонена";
  return "Ожидает решения";
}

function servicePricingHint(pricingType: string) {
  if (pricingType === "incremental") return `${pe(premiumEmoji.growthChart, "📊")} Повторные покупки этой услуги становятся дороже.`;
  if (pricingType === "ladder_once") return `${pe(premiumEmoji.lockClosed, "🔒")} У этой услуги ограниченное число ступеней.`;
  if (pricingType === "ladder_repeat_last") return `${pe(premiumEmoji.growthChart, "📊")} Цена идет по ступеням, затем остается на последней ступени.`;
  return null;
}
