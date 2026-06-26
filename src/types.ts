import type { Context } from "telegraf";

export type BotContext = Context;

export type UserRole = "user" | "admin" | "owner" | "developer";
export type UserStatus = "active" | "restricted" | "banned";
export type PurchaseStatus = "pending" | "approved" | "rejected";

export type UserRecord = {
  id: number;
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  role: UserRole;
  status: UserStatus;
  title: string | null;
  donor_title_html: string | null;
  donor_title_actions_used: number;
  donor_title_bonus_actions: number;
  balance: number;
  cinder_limit: number;
  total_received: number;
  total_spent: number;
  last_activity_at: string;
  last_inactivity_penalty_at: string | null;
  joined_at: string;
  updated_at: string;
};

export type WeeklyTopUserRecord = UserRecord & {
  weekly_score: number;
};

export type WeeklyTopRewardRecord = {
  week_key: string;
  place: number;
  user_id: number;
  score: number;
  reward: number;
  created_at: string;
};

export type ServiceRecord = {
  id: number;
  slug: string;
  title: string;
  description: string;
  price: number;
  category: string;
  currency: string;
  pricing_type: string;
  pricing_config: string;
  is_active: number;
  requires_approval: number;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type PurchaseRecord = {
  id: number;
  user_id: number;
  service_id: number;
  price: number;
  status: PurchaseStatus;
  admin_id: number | null;
  note: string | null;
  created_at: string;
  reviewed_at: string | null;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  telegram_id: number;
  service_title: string;
};

export type PromoCodeRecord = {
  id: number;
  code: string;
  reward: number;
  max_uses: number;
  used_count: number;
  single_use_per_user: number;
  expires_at: string | null;
  is_active: number;
  created_by: number | null;
  created_at: string;
  deleted_at: string | null;
};

export type TitleRecord = {
  id: number;
  name: string;
  is_active: number;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type UserPriceAdjustmentRecord = {
  user_id: number;
  amount: number;
  admin_user_id: number | null;
  created_at: string;
  updated_at: string;
};

export type StarDonationRecord = {
  id: number;
  user_id: number;
  telegram_payment_charge_id: string;
  amount: number;
  payload: string;
  created_at: string;
};

export type UserStateRecord = {
  telegram_id: number;
  flow: string;
  step: string;
  data: string;
  updated_at: string;
};
