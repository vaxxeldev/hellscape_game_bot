export type ServiceCurrency = "cinders" | "stars";
export type ServicePricingType = "fixed" | "ladder_repeat_last" | "ladder_once" | "incremental";
export type ServiceCategory = "punishments" | "privileges" | "limits" | "stars" | "iris";

export type ServicePricingConfig = {
  prices?: number[];
  start?: number;
  step?: number;
  rewardCinders?: number;
  stages?: string[];
};

export type CatalogService = {
  slug: string;
  title: string;
  description: string;
  price: number;
  requiresApproval: boolean;
  category: ServiceCategory;
  currency: ServiceCurrency;
  pricingType: ServicePricingType;
  pricingConfig: ServicePricingConfig;
};

export const catalogServices: CatalogService[] = [
  {
    slug: "warn_inactive_remove",
    title: "Снять варн за неактив",
    description: "Заявка на снятие варна за неактив. Администрация проверит причину варна и примет решение вручную.",
    price: 70,
    requiresApproval: true,
    category: "punishments",
    currency: "cinders",
    pricingType: "ladder_repeat_last",
    pricingConfig: { prices: [70, 160, 260] },
  },
  {
    slug: "warn_behavior_remove",
    title: "Снять варн за поведение",
    description: "Заявка на снятие варна за нарушение правил поведения. Администрация проверит ситуацию и ответит по заявке.",
    price: 100,
    requiresApproval: true,
    category: "punishments",
    currency: "cinders",
    pricingType: "ladder_repeat_last",
    pricingConfig: { prices: [100, 250, 500] },
  },
  {
    slug: "warn_spam_remove",
    title: "Снять варн за спам",
    description: "Заявка на снятие варна за спам. Подходит для случаев, когда нарушение уже разобрано и нужен ручной пересмотр.",
    price: 90,
    requiresApproval: true,
    category: "punishments",
    currency: "cinders",
    pricingType: "ladder_repeat_last",
    pricingConfig: { prices: [90, 180, 300] },
  },
  {
    slug: "warn_norm_80_remove",
    title: "Снять варн за недобор от 80",
    description: "Для случаев, когда за неделю набрано от 80 до 99 сообщений из нормы 100. Администрация проверит статистику.",
    price: 100,
    requiresApproval: true,
    category: "punishments",
    currency: "cinders",
    pricingType: "ladder_repeat_last",
    pricingConfig: { prices: [100, 150, 250] },
  },
  {
    slug: "warn_norm_90_remove",
    title: "Снять варн за недобор от 90",
    description: "Для случаев, когда за неделю набрано от 90 до 99 сообщений из нормы 100. Администрация проверит статистику.",
    price: 50,
    requiresApproval: true,
    category: "punishments",
    currency: "cinders",
    pricingType: "ladder_repeat_last",
    pricingConfig: { prices: [50, 100, 150] },
  },
  {
    slug: "mute_behavior_remove",
    title: "Снять мут за поведение",
    description: "Заявка на досрочное снятие мута за поведение. Администрация проверит нарушение и решит, можно ли снять мут.",
    price: 200,
    requiresApproval: true,
    category: "punishments",
    currency: "cinders",
    pricingType: "ladder_repeat_last",
    pricingConfig: { prices: [200, 250, 400] },
  },
  {
    slug: "early_role_change",
    title: "Сменить роль раньше месяца",
    description: "Заявка на смену роли до окончания стандартного срока в один месяц. Каждая следующая покупка этой услуги дороже на 80 Угольков.",
    price: 80,
    requiresApproval: true,
    category: "privileges",
    currency: "cinders",
    pricingType: "incremental",
    pricingConfig: { start: 80, step: 80 },
  },
  {
    slug: "early_rest",
    title: "Взять рест раньше 2 недель",
    description: "Заявка на рест до окончания стандартного срока в две недели. Каждая следующая покупка этой услуги дороже на 70 Угольков.",
    price: 50,
    requiresApproval: true,
    category: "privileges",
    currency: "cinders",
    pricingType: "incremental",
    pricingConfig: { start: 50, step: 70 },
  },
  {
    slug: "buy_title",
    title: "Купить титул",
    description: "Заявка на обычный титул. После покупки администрация согласует текст и оформление.",
    price: 350,
    requiresApproval: true,
    category: "privileges",
    currency: "cinders",
    pricingType: "fixed",
    pricingConfig: {},
  },
  {
    slug: "buy_chat_prefix",
    title: "Купить особый префикс",
    description: "Заявка на особый префикс в чате. После покупки администрация согласует текст и оформление.",
    price: 400,
    requiresApproval: true,
    category: "privileges",
    currency: "cinders",
    pricingType: "fixed",
    pricingConfig: {},
  },
  {
    slug: "reduce_norm_15",
    title: "Снизить норму на 15 сообщений",
    description: "Заявка на временное снижение недельной нормы на 15 сообщений. Администрация проверит возможность снижения.",
    price: 150,
    requiresApproval: true,
    category: "limits",
    currency: "cinders",
    pricingType: "ladder_repeat_last",
    pricingConfig: { prices: [150, 300] },
  },
  {
    slug: "reduce_norm_30",
    title: "Снизить норму на 30 сообщений",
    description: "Заявка на временное снижение недельной нормы на 30 сообщений. Администрация проверит возможность снижения.",
    price: 300,
    requiresApproval: true,
    category: "limits",
    currency: "cinders",
    pricingType: "ladder_repeat_last",
    pricingConfig: { prices: [300, 600] },
  },
  {
    slug: "increase_cinder_limit",
    title: "Увеличить лимит Угольков",
    description: "Автоматически увеличивает личный лимит баланса. Новый лимит применяется сразу после покупки.",
    price: 350,
    requiresApproval: false,
    category: "limits",
    currency: "cinders",
    pricingType: "ladder_once",
    pricingConfig: {
      prices: [350, 500, 750, 900, 1200, 1500],
      stages: ["500 -> 800", "800 -> 1100", "1100 -> 1600", "1600 -> 2100", "2100 -> 2600", "2600 -> 3000"],
    },
  },
  {
    slug: "buy_cinders_100",
    title: "200 Угольков за 100 Stars",
    description: "Автоматическая покупка Угольков за Telegram Stars. Начисление проходит сразу после оплаты.",
    price: 100,
    requiresApproval: false,
    category: "stars",
    currency: "stars",
    pricingType: "fixed",
    pricingConfig: { rewardCinders: 200 },
  },
  {
    slug: "buy_cinders_250",
    title: "350 Угольков за 250 Stars",
    description: "Автоматическая покупка Угольков за Telegram Stars. Начисление проходит сразу после оплаты.",
    price: 250,
    requiresApproval: false,
    category: "stars",
    currency: "stars",
    pricingType: "fixed",
    pricingConfig: { rewardCinders: 350 },
  },
  {
    slug: "buy_cinders_500",
    title: "600 Угольков за 500 Stars",
    description: "Автоматическая покупка Угольков за Telegram Stars. Начисление проходит сразу после оплаты.",
    price: 500,
    requiresApproval: false,
    category: "stars",
    currency: "stars",
    pricingType: "fixed",
    pricingConfig: { rewardCinders: 600 },
  },
  {
    slug: "iris_reward_7d",
    title: "Iris: команда «наградить» на 7 дней",
    description: "Заявка на доступ к команде «наградить» в Iris - Чат менеджере на 7 дней. Выдачу подтверждает администрация.",
    price: 250,
    requiresApproval: true,
    category: "iris",
    currency: "cinders",
    pricingType: "fixed",
    pricingConfig: {},
  },
  {
    slug: "iris_reward_forever",
    title: "Iris: команда «наградить» навсегда",
    description: "Заявка на постоянный доступ к команде «наградить» в Iris - Чат менеджере. Выдачу подтверждает администрация.",
    price: 500,
    requiresApproval: true,
    category: "iris",
    currency: "cinders",
    pricingType: "fixed",
    pricingConfig: {},
  },
];
