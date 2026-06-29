import type { PromoCodeRecord, ServiceRecord, TitleRecord } from "../types.js";
import { premiumEmoji } from "./premiumEmoji.js";

type ButtonStyle = "danger" | "success" | "primary";

type CallbackButton = {
  text: string;
  callback_data: string;
  icon_custom_emoji_id?: string;
  style?: ButtonStyle;
};

type InlineButton = CallbackButton;

type KeyboardExtra = {
  reply_markup: {
    inline_keyboard: InlineButton[][];
  };
};

function callbackButton(
  text: string,
  callbackData: string,
  iconCustomEmojiId?: string,
  style?: ButtonStyle,
): CallbackButton {
  return {
    text,
    callback_data: callbackData,
    ...(iconCustomEmojiId ? { icon_custom_emoji_id: iconCustomEmojiId } : {}),
    ...(style ? { style } : {}),
  };
}

function inlineKeyboard(inline_keyboard: InlineButton[][]): KeyboardExtra {
  return { reply_markup: { inline_keyboard } };
}

export function mainMenuKeyboard() {
  return inlineKeyboard([
    [
      callbackButton("Услуги", "menu:services", premiumEmoji.gift, "primary"),
      callbackButton("Профиль", "menu:profile", premiumEmoji.profile, "primary"),
    ],
    [callbackButton("Топ", "top:balance:0", premiumEmoji.statsChart), callbackButton("Помощь", "menu:help", premiumEmoji.info)],
    [callbackButton("Поддержать разработчика", "menu:support", premiumEmoji.money, "success")],
  ]);
}

export function backHomeKeyboard() {
  return inlineKeyboard([[callbackButton("Назад", "menu:home", premiumEmoji.down)]]);
}

export function backAdminKeyboard() {
  return inlineKeyboard([[callbackButton("Назад", "admin:home", premiumEmoji.down)]]);
}

export function profileKeyboard(canManageDonorTitle: boolean) {
  const rows: InlineButton[][] = [];
  if (canManageDonorTitle) rows.push([callbackButton("Донатный титул", "donor_title:menu", premiumEmoji.cinder, "primary")]);
  rows.push([callbackButton("Назад", "menu:home", premiumEmoji.down)]);
  return inlineKeyboard(rows);
}

export function donorTitleKeyboard(hasTitle: boolean, actionsLeft: number) {
  const rows: InlineButton[][] = [];
  if (actionsLeft > 0) {
    rows.push([callbackButton(hasTitle ? "Изменить титул" : "Создать титул", "donor_title:set", premiumEmoji.pencil, "success")]);
  }
  if (hasTitle) rows.push([callbackButton("Удалить титул", "donor_title:remove", premiumEmoji.trash, "danger")]);
  rows.push([callbackButton("Назад к профилю", "menu:profile", premiumEmoji.down)]);
  return inlineKeyboard(rows);
}

export function servicesKeyboard(
  services: ServiceRecord[],
  options: { currency: "cinders" | "stars"; page: number; total: number; perPage: number },
) {
  const maxPage = Math.max(0, Math.ceil(options.total / options.perPage) - 1);
  const rows = services.map((service) => [callbackButton(service.title, `svc:${service.id}`, premiumEmoji.tag)]);

  if (options.total > options.perPage) {
    const nav: InlineButton[] = [];
    if (options.page > 0) nav.push(callbackButton("Назад", `svc_cat:${options.currency}:${options.page - 1}`, premiumEmoji.down));
    if (options.page < maxPage) nav.push(callbackButton("Вперед", `svc_cat:${options.currency}:${options.page + 1}`, premiumEmoji.down));
    rows.push(nav);
  }

  rows.push([callbackButton("Назад к категориям", "menu:services", premiumEmoji.down)]);
  return inlineKeyboard(rows);
}

export function serviceCategoriesKeyboard() {
  return inlineKeyboard([
    [callbackButton("Лавка за Угольки", "svc_cat:cinders", premiumEmoji.cinder, "primary")],
    [callbackButton("Купить Угольки за Stars", "svc_cat:stars", premiumEmoji.star, "success")],
    [callbackButton("Назад", "menu:home", premiumEmoji.down)],
  ]);
}

export function cindersStarsKeyboard() {
  return inlineKeyboard([
    [
      callbackButton("30 Угольков", "cinders_stars:preset:30", premiumEmoji.cinder, "primary"),
      callbackButton("75 Угольков", "cinders_stars:preset:75", premiumEmoji.cinder, "primary"),
    ],
    [
      callbackButton("150 Угольков", "cinders_stars:preset:150", premiumEmoji.cinder, "primary"),
      callbackButton("300 Угольков", "cinders_stars:preset:300", premiumEmoji.cinder, "primary"),
    ],
    [callbackButton("600 Угольков", "cinders_stars:preset:600", premiumEmoji.cinder, "success")],
    [callbackButton("Назад к категориям", "cinders_stars:cancel", premiumEmoji.down)],
  ]);
}

export function serviceKeyboard(
  serviceId: number,
  options: { available?: boolean; currency?: string; backCallback?: string } = {},
) {
  const rows: InlineButton[][] = [];
  if (options.available !== false) {
    rows.push([
      callbackButton(
        options.currency === "stars" ? "Оплатить Stars" : "Купить",
        `buy:${serviceId}`,
        options.currency === "stars" ? premiumEmoji.star : premiumEmoji.sendMoney,
        "success",
      ),
    ]);
  }
  rows.push([callbackButton("Назад к услугам", options.backCallback ?? "menu:services", premiumEmoji.down)]);
  return inlineKeyboard(rows);
}

export function topKeyboard(
  kind: "balance" | "weekly",
  page: number,
  total: number,
  perPage: number,
  mode: "menu" | "chat" = "chat",
) {
  const rows: InlineButton[][] = [];
  const maxPage = Math.max(0, Math.ceil(total / perPage) - 1);

  rows.push([
    callbackButton("Общий", "top:balance:0", premiumEmoji.wallet, kind === "balance" ? "primary" : undefined),
    callbackButton("Неделя", "top:weekly:0", premiumEmoji.gift, kind === "weekly" ? "primary" : undefined),
  ]);

  if (total > perPage) {
    const nav: InlineButton[] = [];
    if (page > 0) nav.push(callbackButton("Назад", `top:${kind}:${page - 1}`, premiumEmoji.down));
    if (page < maxPage) nav.push(callbackButton("Вперед", `top:${kind}:${page + 1}`, premiumEmoji.down));
    rows.push(nav);
  }

  rows.push([
    mode === "menu"
      ? callbackButton("Назад", "menu:home", premiumEmoji.down)
      : callbackButton("Закрыть", "msg:close", premiumEmoji.cross, "danger"),
  ]);
  return inlineKeyboard(rows);
}

export function adminKeyboard(canCompensate = false) {
  const rows: InlineButton[][] = [
    [callbackButton("Создать услугу", "admin:create_service", premiumEmoji.pencil, "success")],
    [
      callbackButton("Услуги", "admin:services", premiumEmoji.gift, "primary"),
      callbackButton("Заявки", "admin:purchases", premiumEmoji.file, "primary"),
    ],
    [
      callbackButton("Промокоды", "admin:promos", premiumEmoji.receiveMoney, "primary"),
      callbackButton("Титулы", "admin:titles", premiumEmoji.tag, "primary"),
    ],
    [callbackButton("Персональная наценка", "admin:price_adjustment", premiumEmoji.growthChart, "primary")],
    [callbackButton("Статистика", "admin:stats", premiumEmoji.statsChart), callbackButton("Рассылка", "admin:broadcast", premiumEmoji.announcement)],
  ];
  if (canCompensate) rows.push([callbackButton("Компенсация", "admin:compensation", premiumEmoji.gift, "success")]);
  return inlineKeyboard(rows);
}

export function adminServicesKeyboard(services: ServiceRecord[], options: { page: number; total: number; perPage: number }) {
  const maxPage = Math.max(0, Math.ceil(options.total / options.perPage) - 1);
  const rows = services.map((service) => [
    callbackButton(
      `${service.is_active ? "Включена" : "Выключена"}: ${service.title}`,
      `admin:service:${service.id}:${options.page}`,
      service.is_active ? premiumEmoji.check : premiumEmoji.cross,
    ),
  ]);

  if (options.total > options.perPage) {
    const nav: InlineButton[] = [];
    if (options.page > 0) nav.push(callbackButton("Назад", `admin:services:${options.page - 1}`, premiumEmoji.down));
    nav.push(callbackButton(`${options.page + 1}/${maxPage + 1}`, `admin:services:${options.page}`, premiumEmoji.file));
    if (options.page < maxPage) nav.push(callbackButton("Вперед", `admin:services:${options.page + 1}`, premiumEmoji.down));
    rows.push(nav);
  }

  rows.push([callbackButton("Назад", "admin:home", premiumEmoji.down)]);
  return inlineKeyboard(rows);
}

export function adminServiceKeyboard(service: ServiceRecord, page = 0) {
  return inlineKeyboard([
    [
      callbackButton(
        service.is_active ? "Выключить" : "Включить",
        `admin:service_toggle:${service.id}:${page}`,
        service.is_active ? premiumEmoji.cross : premiumEmoji.check,
        service.is_active ? "danger" : "success",
      ),
    ],
    [callbackButton("Удалить", `admin:service_delete:${service.id}:${page}`, premiumEmoji.trash, "danger")],
    [callbackButton("Назад к услугам", `admin:services:${page}`, premiumEmoji.down)],
  ]);
}

export function promosMenuKeyboard() {
  return inlineKeyboard([
    [callbackButton("Создать промокод", "admin:create_promo", premiumEmoji.pencil, "success")],
    [callbackButton("Список промокодов", "admin:promo_list", premiumEmoji.receiveMoney, "primary")],
    [callbackButton("Назад", "admin:home", premiumEmoji.down)],
  ]);
}

export function promoListKeyboard(promos: PromoCodeRecord[]) {
  const rows = promos.map((promo) => [
    callbackButton(
      `${promo.is_active ? "Включен" : "Выключен"}: ${promo.code}`,
      `admin:promo:${promo.id}`,
      promo.is_active ? premiumEmoji.check : premiumEmoji.cross,
    ),
  ]);
  rows.push([callbackButton("Назад", "admin:promos", premiumEmoji.down)]);
  return inlineKeyboard(rows);
}

export function promoKeyboard(promo: PromoCodeRecord) {
  return inlineKeyboard([
    [
      callbackButton(
        promo.is_active ? "Выключить" : "Включить",
        `admin:promo_toggle:${promo.id}`,
        promo.is_active ? premiumEmoji.cross : premiumEmoji.check,
        promo.is_active ? "danger" : "success",
      ),
    ],
    [callbackButton("Удалить", `admin:promo_delete:${promo.id}`, premiumEmoji.trash, "danger")],
    [callbackButton("Назад к промокодам", "admin:promo_list", premiumEmoji.down)],
  ]);
}

export function pendingPurchasesKeyboard(purchases: { id: number; service_title: string }[]) {
  const rows = purchases.map((purchase) => [
    callbackButton(`#${purchase.id} ${purchase.service_title}`, `admin:purchase:${purchase.id}`, premiumEmoji.file),
  ]);
  rows.push([callbackButton("Назад", "admin:home", premiumEmoji.down)]);
  return inlineKeyboard(rows);
}

export function purchaseReviewKeyboard(purchaseId: number) {
  return inlineKeyboard([
    [
      callbackButton("Одобрить", `admin:purchase_approve:${purchaseId}`, premiumEmoji.check, "success"),
      callbackButton("Отклонить", `admin:purchase_reject:${purchaseId}`, premiumEmoji.cross, "danger"),
    ],
    [callbackButton("Назад к заявкам", "admin:purchases", premiumEmoji.down)],
  ]);
}

export function approvalModeKeyboard() {
  return inlineKeyboard([
    [callbackButton("Ручное подтверждение", "flow:service_approval:manual", premiumEmoji.people, "primary")],
    [callbackButton("Автоматическая выдача", "flow:service_approval:auto", premiumEmoji.check, "success")],
    [callbackButton("Отмена", "flow:cancel", premiumEmoji.cross, "danger")],
  ]);
}

export function servicePricingModeKeyboard() {
  return inlineKeyboard([
    [callbackButton("Обычная цена", "flow:service_pricing:fixed", premiumEmoji.check, "success")],
    [callbackButton("Ступени, потом стоп", "flow:service_pricing:ladder_once", premiumEmoji.lockClosed, "primary")],
    [callbackButton("Ступени, потом последняя", "flow:service_pricing:ladder_repeat_last", premiumEmoji.growthChart, "primary")],
    [callbackButton("Каждый раз +шаг", "flow:service_pricing:incremental", premiumEmoji.statsChart, "primary")],
    [callbackButton("Отмена", "flow:cancel", premiumEmoji.cross, "danger")],
  ]);
}

export function confirmFlowKeyboard(flow: string) {
  return inlineKeyboard([
    [callbackButton("Создать", `flow:${flow}:confirm`, premiumEmoji.check, "success")],
    [callbackButton("Отмена", "flow:cancel", premiumEmoji.cross, "danger")],
  ]);
}

export function cancelFlowKeyboard() {
  return inlineKeyboard([[callbackButton("Отмена", "flow:cancel", premiumEmoji.cross, "danger")]]);
}

export function broadcastMediaKeyboard() {
  return inlineKeyboard([
    [callbackButton("Пропустить медиа", "bc:skip_media", premiumEmoji.download, "primary")],
    [callbackButton("Отмена", "bc:cancel", premiumEmoji.cross, "danger")],
  ]);
}

export function broadcastButtonChoiceKeyboard() {
  return inlineKeyboard([
    [callbackButton("Добавить кнопку", "bc:add_button", premiumEmoji.link, "success")],
    [callbackButton("Без кнопки", "bc:skip_button", premiumEmoji.hidden, "primary")],
    [callbackButton("Отмена", "bc:cancel", premiumEmoji.cross, "danger")],
  ]);
}

export function broadcastCancelKeyboard() {
  return inlineKeyboard([[callbackButton("Отмена", "bc:cancel", premiumEmoji.cross, "danger")]]);
}

export function broadcastConfirmKeyboard() {
  return inlineKeyboard([
    [
      callbackButton("Отправить", "bc:confirm", premiumEmoji.send, "success"),
      callbackButton("Отмена", "bc:cancel", premiumEmoji.cross, "danger"),
    ],
  ]);
}

export function compensationConfirmKeyboard() {
  return inlineKeyboard([
    [
      callbackButton("Выдать компенсацию", "flow:compensation:confirm", premiumEmoji.check, "success"),
      callbackButton("Отмена", "flow:cancel", premiumEmoji.cross, "danger"),
    ],
  ]);
}

export function supportStarsKeyboard() {
  return inlineKeyboard([
    [
      callbackButton("10 Stars", "stars:10", premiumEmoji.star, "success"),
      callbackButton("25 Stars", "stars:25", premiumEmoji.star, "success"),
    ],
    [
      callbackButton("50 Stars", "stars:50", premiumEmoji.star, "success"),
      callbackButton("100 Stars", "stars:100", premiumEmoji.star, "success"),
    ],
    [callbackButton("Назад", "menu:home", premiumEmoji.down)],
  ]);
}

export function titlesMenuKeyboard() {
  return inlineKeyboard([
    [callbackButton("Создать титул", "admin:create_title", premiumEmoji.pencil, "success")],
    [callbackButton("Титулы", "admin:title_list", premiumEmoji.tag, "primary")],
    [callbackButton("Выдать титул", "admin:assign_title", premiumEmoji.userApproved, "primary")],
    [callbackButton("Забрать титул", "admin:remove_title", premiumEmoji.userRejected, "danger")],
    [callbackButton("Назад", "admin:home", premiumEmoji.down)],
  ]);
}

export function titleListKeyboard(titles: TitleRecord[]) {
  const rows = titles.map((title) => [
    callbackButton(
      `${title.is_active ? "Включен" : "Выключен"}: ${title.name}`,
      `admin:title:${title.id}`,
      title.is_active ? premiumEmoji.check : premiumEmoji.cross,
    ),
  ]);
  rows.push([callbackButton("Назад", "admin:titles", premiumEmoji.down)]);
  return inlineKeyboard(rows);
}

export function titleKeyboard(title: TitleRecord) {
  return inlineKeyboard([
    [
      callbackButton(
        title.is_active ? "Выключить" : "Включить",
        `admin:title_toggle:${title.id}`,
        title.is_active ? premiumEmoji.cross : premiumEmoji.check,
        title.is_active ? "danger" : "success",
      ),
    ],
    [callbackButton("Удалить", `admin:title_delete:${title.id}`, premiumEmoji.trash, "danger")],
    [callbackButton("Назад к титулам", "admin:title_list", premiumEmoji.down)],
  ]);
}
