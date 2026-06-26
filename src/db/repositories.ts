import type {
  PromoCodeRecord,
  PurchaseRecord,
  PurchaseStatus,
  ServiceRecord,
  TitleRecord,
  UserPriceAdjustmentRecord,
  UserRecord,
  UserRole,
  UserStateRecord,
  WeeklyTopRewardRecord,
  WeeklyTopUserRecord,
} from "../types.js";
import { nowIso } from "../utils/time.js";
import { cleanUsername, slugify } from "../utils/text.js";
import type { Database } from "./database.js";
import type { CatalogService } from "../services/catalog.js";
import { freeCinderSpace } from "../services/cinderLimits.js";

export class Repositories {
  constructor(private readonly db: Database) {}

  upsertUser(input: {
    telegramId: number;
    username?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    role?: UserRole;
  }) {
    this.db.run(
      `
      INSERT INTO users (telegram_id, username, first_name, last_name, role, last_activity_at, updated_at)
      VALUES (:telegramId, :username, :firstName, :lastName, :role, :updatedAt, :updatedAt)
      ON CONFLICT(telegram_id) DO UPDATE SET
        username = excluded.username,
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        last_activity_at = excluded.last_activity_at,
        role = CASE
          WHEN users.role = 'owner' THEN users.role
          WHEN excluded.role IN ('owner', 'admin', 'developer') THEN excluded.role
          ELSE users.role
        END,
        updated_at = excluded.updated_at
      `,
      {
        telegramId: input.telegramId,
        username: input.username ?? null,
        firstName: input.firstName ?? null,
        lastName: input.lastName ?? null,
        role: input.role ?? "user",
        updatedAt: nowIso(),
      },
    );
    return this.getUserByTelegramId(input.telegramId)!;
  }

  getUserByTelegramId(telegramId: number) {
    return this.db.get<UserRecord>("SELECT * FROM users WHERE telegram_id = :telegramId", { telegramId });
  }

  getUserByUsername(username: string) {
    return this.db.get<UserRecord>(
      "SELECT * FROM users WHERE username = :username COLLATE NOCASE ORDER BY updated_at DESC LIMIT 1",
      { username: cleanUsername(username) },
    );
  }

  getUserPriceAdjustment(userId: number) {
    return (
      this.db.get<UserPriceAdjustmentRecord>(
        "SELECT * FROM user_price_adjustments WHERE user_id = :userId",
        { userId },
      )?.amount ?? 0
    );
  }

  setUserPriceAdjustment(userId: number, amount: number, adminUserId?: number | null) {
    if (!Number.isInteger(amount) || amount < 0) throw new Error("Price adjustment must be a non-negative integer");

    if (amount === 0) {
      this.db.run("DELETE FROM user_price_adjustments WHERE user_id = :userId", { userId });
      return this.getUserById(userId);
    }

    this.db.run(
      `
      INSERT INTO user_price_adjustments (user_id, amount, admin_user_id, updated_at)
      VALUES (:userId, :amount, :adminUserId, :now)
      ON CONFLICT(user_id) DO UPDATE SET
        amount = excluded.amount,
        admin_user_id = excluded.admin_user_id,
        updated_at = excluded.updated_at
      `,
      { userId, amount, adminUserId: adminUserId ?? null, now: nowIso() },
    );
    return this.getUserById(userId);
  }

  getUserById(id: number) {
    return this.db.get<UserRecord>("SELECT * FROM users WHERE id = :id", { id });
  }

  listUsers(limit = 50) {
    return this.db.query<UserRecord>("SELECT * FROM users ORDER BY joined_at DESC LIMIT :limit", { limit });
  }

  listBroadcastUsers(limit = 100000) {
    return this.db.query<UserRecord>(
      "SELECT * FROM users WHERE status != 'banned' ORDER BY joined_at DESC LIMIT :limit",
      { limit },
    );
  }

  topUsers(limit: number, offset: number) {
    return this.db.query<UserRecord>(
      "SELECT * FROM users WHERE balance > 0 ORDER BY balance DESC, total_received DESC, id ASC LIMIT :limit OFFSET :offset",
      { limit, offset },
    );
  }

  countTopUsers() {
    return this.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM users WHERE balance > 0")?.count ?? 0;
  }

  weeklyTopUsers(startIso: string, endIso: string, limit: number, offset: number) {
    return this.db.query<WeeklyTopUserRecord>(
      `
      SELECT u.*, SUM(t.amount) AS weekly_score
      FROM transactions t
      JOIN users u ON u.id = t.user_id
      WHERE t.created_at >= :startIso
        AND t.created_at < :endIso
        AND t.amount > 0
        AND t.type IN ('grant', 'promo', 'stars_purchase', 'support_reward')
      GROUP BY u.id
      HAVING weekly_score > 0
      ORDER BY weekly_score DESC, u.balance DESC, u.id ASC
      LIMIT :limit OFFSET :offset
      `,
      { startIso, endIso, limit, offset },
    );
  }

  countWeeklyTopUsers(startIso: string, endIso: string) {
    return (
      this.db.get<{ count: number }>(
        `
        SELECT COUNT(*) AS count
        FROM (
          SELECT user_id
          FROM transactions
          WHERE created_at >= :startIso
            AND created_at < :endIso
            AND amount > 0
            AND type IN ('grant', 'promo', 'stars_purchase', 'support_reward')
          GROUP BY user_id
          HAVING SUM(amount) > 0
        )
        `,
        { startIso, endIso },
      )?.count ?? 0
    );
  }

  weeklyRewardProcessed(weekKey: string) {
    return (
      (this.db.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM weekly_top_runs WHERE week_key = :weekKey",
        { weekKey },
      )?.count ?? 0) > 0
    );
  }

  weeklyRewards(weekKey: string) {
    return this.db.query<WeeklyTopRewardRecord>(
      "SELECT * FROM weekly_top_rewards WHERE week_key = :weekKey ORDER BY place ASC",
      { weekKey },
    );
  }

  payWeeklyTopRewards(input: {
    weekKey: string;
    startIso: string;
    endIso: string;
    rewards: number[];
  }) {
    return this.db.transaction(() => {
      if (this.weeklyRewardProcessed(input.weekKey)) {
        return { paid: false, winners: this.weeklyTopUsers(input.startIso, input.endIso, input.rewards.length, 0) };
      }

      const winners = this.weeklyTopUsers(input.startIso, input.endIso, input.rewards.length, 0);
      this.db.run(
        `
        INSERT INTO weekly_top_runs (week_key, start_iso, end_iso, winners_count)
        VALUES (:weekKey, :startIso, :endIso, :winnersCount)
        `,
        {
          weekKey: input.weekKey,
          startIso: input.startIso,
          endIso: input.endIso,
          winnersCount: winners.length,
        },
      );

      const payouts: { winner: WeeklyTopUserRecord; place: number; reward: number; credited: number }[] = [];
      winners.forEach((winner, index) => {
        const place = index + 1;
        const reward = input.rewards[index];
        if (!reward) return;

        const { credited } = this.adjustBalanceToLimit({
          userId: winner.id,
          amount: reward,
          type: "weekly_top_reward",
          reason: `Награда за недельный топ #${place}`,
        });
        payouts.push({ winner, place, reward, credited });
        if (credited <= 0) return;

        this.db.run(
          `
          INSERT INTO weekly_top_rewards (week_key, place, user_id, score, reward)
          VALUES (:weekKey, :place, :userId, :score, :reward)
          `,
          {
            weekKey: input.weekKey,
            place,
            userId: winner.id,
            score: winner.weekly_score,
            reward: credited,
          },
        );
      });

      return { paid: winners.length > 0, winners, payouts };
    });
  }

  adjustBalance(input: {
    userId: number;
    amount: number;
    type: string;
    reason?: string | null;
    adminUserId?: number | null;
    counterpartyUserId?: number | null;
    purchaseId?: number | null;
    promoCodeId?: number | null;
  }) {
    if (!Number.isInteger(input.amount) || input.amount === 0) throw new Error("Amount must be a non-zero integer");

    return this.db.transaction(() => {
      const user = this.db.get<UserRecord>("SELECT * FROM users WHERE id = :id", { id: input.userId });
      if (!user) throw new Error("User not found");

      const nextBalance = user.balance + input.amount;
      if (nextBalance < 0) throw new Error("Недостаточно Угольков");
      if (input.amount > 0 && input.type !== "refund" && nextBalance > user.cinder_limit) {
        const freeSpace = freeCinderSpace(user.balance, user.cinder_limit);
        throw new Error(`Лимит Угольков не позволяет получить эту сумму. Свободно: ${freeSpace}`);
      }

      this.db.run(
        `
        UPDATE users
        SET balance = :balance,
            total_received = total_received + :receivedDelta,
            updated_at = :updatedAt
        WHERE id = :id
        `,
        {
          id: input.userId,
          balance: nextBalance,
          receivedDelta: input.amount > 0 && input.type !== "refund" ? input.amount : 0,
          updatedAt: nowIso(),
        },
      );

      this.db.run(
        `
        INSERT INTO transactions (
          user_id, amount, type, balance_after, counterparty_user_id,
          admin_user_id, purchase_id, promo_code_id, reason
        )
        VALUES (
          :userId, :amount, :type, :balanceAfter, :counterpartyUserId,
          :adminUserId, :purchaseId, :promoCodeId, :reason
        )
        `,
        {
          userId: input.userId,
          amount: input.amount,
          type: input.type,
          balanceAfter: nextBalance,
          counterpartyUserId: input.counterpartyUserId ?? null,
          adminUserId: input.adminUserId ?? null,
          purchaseId: input.purchaseId ?? null,
          promoCodeId: input.promoCodeId ?? null,
          reason: input.reason ?? null,
        },
      );

      return this.getUserByTelegramId(user.telegram_id)!;
    });
  }

  adjustBalanceToLimit(input: {
    userId: number;
    amount: number;
    type: string;
    reason?: string | null;
    adminUserId?: number | null;
    counterpartyUserId?: number | null;
    purchaseId?: number | null;
    promoCodeId?: number | null;
  }) {
    if (!Number.isInteger(input.amount) || input.amount <= 0) throw new Error("Amount must be a positive integer");
    const user = this.db.get<UserRecord>("SELECT * FROM users WHERE id = :id", { id: input.userId });
    if (!user) throw new Error("User not found");

    const credited = Math.min(input.amount, freeCinderSpace(user.balance, user.cinder_limit));
    if (credited <= 0) return { credited: 0, user };

    const updatedUser = this.adjustBalance({ ...input, amount: credited });
    return { credited, user: updatedUser };
  }

  listUsersForInactivityPenalty(cutoffIso: string, limit = 200) {
    return this.db.query<UserRecord>(
      `
      SELECT *
      FROM users
      WHERE balance > 0
        AND status = 'active'
        AND role NOT IN ('owner', 'admin', 'developer')
        AND last_activity_at <= :cutoffIso
        AND (
          last_inactivity_penalty_at IS NULL
          OR last_inactivity_penalty_at < last_activity_at
        )
      ORDER BY last_activity_at ASC
      LIMIT :limit
      `,
      { cutoffIso, limit },
    );
  }

  applyInactivityPenalty(userId: number, percent: number, reason: string) {
    if (!Number.isFinite(percent) || percent <= 0 || percent >= 1) throw new Error("Penalty percent must be between 0 and 1");

    return this.db.transaction(() => {
      const user = this.getUserById(userId);
      if (!user || user.balance <= 0) return { user, deducted: 0 };

      const deducted = Math.min(user.balance, Math.max(1, Math.ceil(user.balance * percent)));
      const nextBalance = user.balance - deducted;
      const now = nowIso();

      this.db.run(
        `
        UPDATE users
        SET balance = :balance,
            last_inactivity_penalty_at = :now,
            updated_at = :now
        WHERE id = :userId
        `,
        { userId, balance: nextBalance, now },
      );

      this.db.run(
        `
        INSERT INTO transactions (user_id, amount, type, balance_after, reason)
        VALUES (:userId, :amount, :type, :balanceAfter, :reason)
        `,
        {
          userId,
          amount: -deducted,
          type: "inactivity_penalty",
          balanceAfter: nextBalance,
          reason,
        },
      );

      return { user: this.getUserById(userId)!, deducted };
    });
  }

  transfer(fromUserId: number, toUserId: number, amount: number) {
    if (!Number.isInteger(amount) || amount <= 0) throw new Error("Количество должно быть положительным числом");
    if (fromUserId === toUserId) throw new Error("Нельзя подарить Угольки самому себе");

    return this.db.transaction(() => {
      this.adjustBalance({
        userId: fromUserId,
        amount: -amount,
        type: "transfer_out",
        counterpartyUserId: toUserId,
        reason: "Подарок",
      });
      this.adjustBalance({
        userId: toUserId,
        amount,
        type: "transfer_in",
        counterpartyUserId: fromUserId,
        reason: "Подарок",
      });
    });
  }

  transferStatsSince(userId: number, sinceIso: string) {
    return (
      this.db.get<{ count: number; total: number }>(
        `
        SELECT COUNT(*) AS count, COALESCE(SUM(ABS(amount)), 0) AS total
        FROM transactions
        WHERE user_id = :userId
          AND type = 'transfer_out'
          AND created_at >= :sinceIso
        `,
        { userId, sinceIso },
      ) ?? { count: 0, total: 0 }
    );
  }

  latestPromoRedemption(userId: number) {
    return this.db.get<{ created_at: string }>(
      `
      SELECT created_at
      FROM promo_redemptions
      WHERE user_id = :userId
      ORDER BY created_at DESC
      LIMIT 1
      `,
      { userId },
    );
  }

  createService(input: {
    title: string;
    description: string;
    price: number;
    requiresApproval: boolean;
    category?: string;
    currency?: string;
    pricingType?: string;
    pricingConfig?: unknown;
    createdBy?: number | null;
  }) {
    const baseSlug = slugify(input.title);
    let slug = baseSlug;
    let suffix = 1;
    while (this.getServiceBySlug(slug)) {
      suffix += 1;
      slug = `${baseSlug}_${suffix}`;
    }

    const result = this.db.run(
      `
      INSERT INTO services (
        slug, title, description, price, requires_approval, created_by,
        category, currency, pricing_type, pricing_config
      )
      VALUES (
        :slug, :title, :description, :price, :requiresApproval, :createdBy,
        :category, :currency, :pricingType, :pricingConfig
      )
      `,
      {
        slug,
        title: input.title.trim(),
        description: input.description.trim(),
        price: input.price,
        requiresApproval: input.requiresApproval ? 1 : 0,
        createdBy: input.createdBy ?? null,
        category: input.category ?? "general",
        currency: input.currency ?? "cinders",
        pricingType: input.pricingType ?? "fixed",
        pricingConfig: JSON.stringify(input.pricingConfig ?? {}),
      },
    );
    return this.getServiceById(Number(result.lastInsertRowid))!;
  }

  seedCatalogServices(services: CatalogService[]) {
    for (const service of services) {
      const existing = this.db.get<ServiceRecord>("SELECT * FROM services WHERE slug = :slug", { slug: service.slug });
      if (existing?.deleted_at) continue;

      if (existing) {
        this.db.run(
          `
          UPDATE services
          SET title = :title,
              description = :description,
              price = :price,
              requires_approval = :requiresApproval,
              category = :category,
              currency = :currency,
              pricing_type = :pricingType,
              pricing_config = :pricingConfig,
              updated_at = :now
          WHERE slug = :slug AND deleted_at IS NULL
          `,
          {
            slug: service.slug,
            title: service.title,
            description: service.description,
            price: service.price,
            requiresApproval: service.requiresApproval ? 1 : 0,
            category: service.category,
            currency: service.currency,
            pricingType: service.pricingType,
            pricingConfig: JSON.stringify(service.pricingConfig),
            now: nowIso(),
          },
        );
        continue;
      }

      this.db.run(
        `
        INSERT INTO services (
          slug, title, description, price, requires_approval,
          category, currency, pricing_type, pricing_config
        )
        VALUES (
          :slug, :title, :description, :price, :requiresApproval,
          :category, :currency, :pricingType, :pricingConfig
        )
        `,
        {
          slug: service.slug,
          title: service.title,
          description: service.description,
          price: service.price,
          requiresApproval: service.requiresApproval ? 1 : 0,
          category: service.category,
          currency: service.currency,
          pricingType: service.pricingType,
          pricingConfig: JSON.stringify(service.pricingConfig),
        },
      );
    }
  }

  listActiveServices() {
    return this.db.query<ServiceRecord>(
      "SELECT * FROM services WHERE is_active = 1 AND deleted_at IS NULL ORDER BY category ASC, currency ASC, price ASC, id ASC",
    );
  }

  listServices() {
    return this.db.query<ServiceRecord>(
      "SELECT * FROM services WHERE deleted_at IS NULL ORDER BY is_active DESC, id DESC",
    );
  }

  getServiceById(id: number) {
    return this.db.get<ServiceRecord>("SELECT * FROM services WHERE id = :id", { id });
  }

  getServiceBySlug(slug: string) {
    return this.db.get<ServiceRecord>("SELECT * FROM services WHERE slug = :slug AND deleted_at IS NULL", { slug });
  }

  toggleService(id: number) {
    this.db.run(
      `
      UPDATE services
      SET is_active = CASE is_active WHEN 1 THEN 0 ELSE 1 END,
          updated_at = :now
      WHERE id = :id AND deleted_at IS NULL
      `,
      { id, now: nowIso() },
    );
    return this.getServiceById(id)!;
  }

  deleteService(id: number) {
    this.db.run(
      `
      UPDATE services
      SET slug = slug || '_deleted_' || id,
          is_active = 0,
          deleted_at = :now,
          updated_at = :now
      WHERE id = :id AND deleted_at IS NULL
      `,
      { id, now: nowIso() },
    );
  }

  countUserServicePurchases(userId: number, serviceId: number) {
    return (
      this.db.get<{ count: number }>(
        `
        SELECT COUNT(*) AS count
        FROM purchases
        WHERE user_id = :userId
          AND service_id = :serviceId
          AND status IN ('pending', 'approved')
        `,
        { userId, serviceId },
      )?.count ?? 0
    );
  }

  createPurchase(user: UserRecord, service: ServiceRecord, price = service.price) {
    return this.db.transaction(() => {
      const result = this.db.run(
        `
        INSERT INTO purchases (user_id, service_id, price, status)
        VALUES (:userId, :serviceId, :price, :status)
        `,
        {
          userId: user.id,
          serviceId: service.id,
          price,
          status: service.requires_approval ? "pending" : "approved",
        },
      );
      const purchaseId = Number(result.lastInsertRowid);
      this.adjustBalance({
        userId: user.id,
        amount: -price,
        type: "purchase",
        purchaseId,
        reason: service.title,
      });
      if (!service.requires_approval) this.markUserSpent(user.id, price);
      return this.getPurchaseById(purchaseId)!;
    });
  }

  createCinderLimitUpgradePurchase(user: UserRecord, service: ServiceRecord, price: number, targetLimit: number) {
    return this.db.transaction(() => {
      const result = this.db.run(
        `
        INSERT INTO purchases (user_id, service_id, price, status, reviewed_at)
        VALUES (:userId, :serviceId, :price, 'approved', :now)
        `,
        {
          userId: user.id,
          serviceId: service.id,
          price,
          now: nowIso(),
        },
      );
      const purchaseId = Number(result.lastInsertRowid);
      this.adjustBalance({
        userId: user.id,
        amount: -price,
        type: "purchase",
        purchaseId,
        reason: service.title,
      });
      this.db.run(
        `
        UPDATE users
        SET cinder_limit = MAX(cinder_limit, :targetLimit),
            updated_at = :now
        WHERE id = :userId
        `,
        { userId: user.id, targetLimit, now: nowIso() },
      );
      this.markUserSpent(user.id, price);
      return this.getPurchaseById(purchaseId)!;
    });
  }

  recordStarServicePurchase(input: {
    userId: number;
    serviceId: number;
    telegramPaymentChargeId: string;
    stars: number;
    cinders: number;
    payload: string;
  }) {
    return this.db.transaction(() => {
      const result = this.db.run(
        `
        INSERT OR IGNORE INTO star_service_purchases (
          user_id, service_id, telegram_payment_charge_id, stars, cinders, payload
        )
        VALUES (:userId, :serviceId, :telegramPaymentChargeId, :stars, :cinders, :payload)
        `,
        input,
      );
      if (result.changes === 0) return { created: false, credited: 0 };

      const { credited } = this.adjustBalanceToLimit({
        userId: input.userId,
        amount: input.cinders,
        type: "stars_purchase",
        reason: `Покупка Угольков за ${input.stars} Stars`,
      });
      return { created: true, credited };
    });
  }

  recordStarCinderPurchase(input: {
    userId: number;
    telegramPaymentChargeId: string;
    stars: number;
    cinders: number;
    payload: string;
  }) {
    return this.db.transaction(() => {
      const result = this.db.run(
        `
        INSERT OR IGNORE INTO star_cinder_purchases (
          user_id, telegram_payment_charge_id, stars, cinders, payload
        )
        VALUES (:userId, :telegramPaymentChargeId, :stars, :cinders, :payload)
        `,
        input,
      );
      if (result.changes === 0) return { created: false, credited: 0 };

      const { credited } = this.adjustBalanceToLimit({
        userId: input.userId,
        amount: input.cinders,
        type: "stars_purchase",
        reason: `Покупка Угольков за ${input.stars} Stars`,
      });
      return { created: true, credited };
    });
  }

  markUserSpent(userId: number, amount: number) {
    this.db.run("UPDATE users SET total_spent = total_spent + :amount, updated_at = :now WHERE id = :userId", {
      userId,
      amount,
      now: nowIso(),
    });
  }

  getPurchaseById(id: number) {
    return this.db.get<PurchaseRecord>(
      `
      SELECT
        p.*,
        u.telegram_id,
        u.username,
        u.first_name,
        u.last_name,
        s.title AS service_title
      FROM purchases p
      JOIN users u ON u.id = p.user_id
      JOIN services s ON s.id = p.service_id
      WHERE p.id = :id
      `,
      { id },
    );
  }

  listPendingPurchases(limit = 10) {
    return this.db.query<PurchaseRecord>(
      `
      SELECT
        p.*,
        u.telegram_id,
        u.username,
        u.first_name,
        u.last_name,
        s.title AS service_title
      FROM purchases p
      JOIN users u ON u.id = p.user_id
      JOIN services s ON s.id = p.service_id
      WHERE p.status = 'pending'
      ORDER BY p.created_at ASC
      LIMIT :limit
      `,
      { limit },
    );
  }

  reviewPurchase(id: number, status: Exclude<PurchaseStatus, "pending">, adminUserId: number, note?: string | null) {
    return this.db.transaction(() => {
      const purchase = this.getPurchaseById(id);
      if (!purchase) throw new Error("Заявка не найдена");
      if (purchase.status !== "pending") throw new Error("Заявка уже обработана");

      this.db.run(
        `
        UPDATE purchases
        SET status = :status, admin_id = :adminUserId, note = :note, reviewed_at = :now
        WHERE id = :id
        `,
        { id, status, adminUserId, note: note ?? null, now: nowIso() },
      );

      if (status === "approved") {
        this.markUserSpent(purchase.user_id, purchase.price);
      } else {
        this.adjustBalance({
          userId: purchase.user_id,
          amount: purchase.price,
          type: "refund",
          purchaseId: purchase.id,
          adminUserId,
          reason: "Возврат за отклоненную заявку",
        });
      }

      return this.getPurchaseById(id)!;
    });
  }

  createPromo(input: { code: string; reward: number; maxUses: number; createdBy?: number | null }) {
    const result = this.db.run(
      `
      INSERT INTO promo_codes (code, reward, max_uses, created_by)
      VALUES (:code, :reward, :maxUses, :createdBy)
      `,
      {
        code: input.code.trim().toUpperCase(),
        reward: input.reward,
        maxUses: input.maxUses,
        createdBy: input.createdBy ?? null,
      },
    );
    return this.getPromoById(Number(result.lastInsertRowid))!;
  }

  getPromoById(id: number) {
    return this.db.get<PromoCodeRecord>("SELECT * FROM promo_codes WHERE id = :id", { id });
  }

  getPromoByCode(code: string) {
    return this.db.get<PromoCodeRecord>(
      "SELECT * FROM promo_codes WHERE code = :code COLLATE NOCASE AND deleted_at IS NULL",
      {
        code: code.trim(),
      },
    );
  }

  listPromos() {
    return this.db.query<PromoCodeRecord>(
      "SELECT * FROM promo_codes WHERE deleted_at IS NULL ORDER BY created_at DESC, id DESC",
    );
  }

  togglePromo(id: number) {
    this.db.run(
      `
      UPDATE promo_codes
      SET is_active = CASE is_active WHEN 1 THEN 0 ELSE 1 END
      WHERE id = :id AND deleted_at IS NULL
      `,
      { id },
    );
    return this.getPromoById(id)!;
  }

  deletePromo(id: number) {
    this.db.run(
      `
      UPDATE promo_codes
      SET code = code || '_DELETED_' || id,
          is_active = 0,
          deleted_at = :now
      WHERE id = :id AND deleted_at IS NULL
      `,
      { id, now: nowIso() },
    );
  }

  promoRedemptionUsers(id: number, limit = 10) {
    return this.db.query<UserRecord>(
      `
      SELECT u.*
      FROM promo_redemptions r
      JOIN users u ON u.id = r.user_id
      WHERE r.promo_code_id = :id
      ORDER BY r.created_at DESC
      LIMIT :limit
      `,
      { id, limit },
    );
  }

  hasRedeemedPromo(promoId: number, userId: number) {
    return Boolean(
      this.db.get<{ id: number }>(
        "SELECT id FROM promo_redemptions WHERE promo_code_id = :promoId AND user_id = :userId",
        { promoId, userId },
      ),
    );
  }

  createTitle(input: { name: string; createdBy?: number | null }) {
    const result = this.db.run(
      "INSERT INTO titles (name, created_by) VALUES (:name, :createdBy)",
      { name: input.name.trim(), createdBy: input.createdBy ?? null },
    );
    return this.getTitleById(Number(result.lastInsertRowid))!;
  }

  listTitles() {
    return this.db.query<TitleRecord>(
      "SELECT * FROM titles WHERE deleted_at IS NULL ORDER BY is_active DESC, name COLLATE NOCASE ASC",
    );
  }

  getTitleById(id: number) {
    return this.db.get<TitleRecord>("SELECT * FROM titles WHERE id = :id", { id });
  }

  getTitleByName(name: string) {
    return this.db.get<TitleRecord>(
      "SELECT * FROM titles WHERE name = :name COLLATE NOCASE AND deleted_at IS NULL",
      { name: name.trim() },
    );
  }

  toggleTitle(id: number) {
    this.db.run(
      `
      UPDATE titles
      SET is_active = CASE is_active WHEN 1 THEN 0 ELSE 1 END,
          updated_at = :now
      WHERE id = :id AND deleted_at IS NULL
      `,
      { id, now: nowIso() },
    );
    return this.getTitleById(id)!;
  }

  deleteTitle(id: number) {
    this.db.run(
      `
      UPDATE titles
      SET name = name || '_deleted_' || id,
          is_active = 0,
          deleted_at = :now,
          updated_at = :now
      WHERE id = :id AND deleted_at IS NULL
      `,
      { id, now: nowIso() },
    );
  }

  assignTitle(userId: number, title: string | null) {
    this.db.run(
      "UPDATE users SET title = :title, updated_at = :now WHERE id = :userId",
      { userId, title, now: nowIso() },
    );
    return this.db.get<UserRecord>("SELECT * FROM users WHERE id = :userId", { userId })!;
  }

  donorStarsTotal(userId: number) {
    return this.db.get<{ total: number }>(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM star_donations WHERE user_id = :userId",
      { userId },
    )?.total ?? 0;
  }

  donorTitleActionsLimit(userId: number) {
    const rows = this.db.query<{ amount: number }>(
      "SELECT amount FROM star_donations WHERE user_id = :userId",
      { userId },
    );
    const bonus = this.db.get<{ bonus: number }>(
      "SELECT COALESCE(donor_title_bonus_actions, 0) AS bonus FROM users WHERE id = :userId",
      { userId },
    )?.bonus ?? 0;
    return rows.reduce((total, row) => total + donorTitleActionsForStars(row.amount), 0) + bonus;
  }

  donorTitleActionsLeft(user: UserRecord) {
    return Math.max(0, this.donorTitleActionsLimit(user.id) - user.donor_title_actions_used);
  }

  setDonorTitle(userId: number, titleHtml: string | null, spendAction = true) {
    return this.db.transaction(() => {
      const user = this.db.get<UserRecord>("SELECT * FROM users WHERE id = :userId", { userId });
      if (!user) throw new Error("Пользователь не найден");
      if (spendAction && this.donorTitleActionsLeft(user) <= 0) throw new Error("Не осталось действий с донатным титулом");

      this.db.run(
        `
        UPDATE users
        SET donor_title_html = :titleHtml,
            donor_title_actions_used = donor_title_actions_used + :actionsDelta,
            updated_at = :now
        WHERE id = :userId
        `,
        { userId, titleHtml, actionsDelta: spendAction ? 1 : 0, now: nowIso() },
      );
      return this.db.get<UserRecord>("SELECT * FROM users WHERE id = :userId", { userId })!;
    });
  }

  recordStarDonation(input: {
    userId: number;
    telegramPaymentChargeId: string;
    amount: number;
    payload: string;
  }) {
    const result = this.db.run(
      `
      INSERT OR IGNORE INTO star_donations (user_id, telegram_payment_charge_id, amount, payload)
      VALUES (:userId, :telegramPaymentChargeId, :amount, :payload)
      `,
      input,
    );
    return result.changes > 0;
  }

  addDonorTitleBonusActions(userId: number, amount: number) {
    if (!Number.isInteger(amount) || amount <= 0) throw new Error("Bonus amount must be a positive integer");
    this.db.run(
      `
      UPDATE users
      SET donor_title_bonus_actions = donor_title_bonus_actions + :amount,
          updated_at = :now
      WHERE id = :userId
      `,
      { userId, amount, now: nowIso() },
    );
    return this.db.get<UserRecord>("SELECT * FROM users WHERE id = :userId", { userId })!;
  }

  starDonationStats() {
    return {
      count: this.db.get<{ value: number }>("SELECT COUNT(*) AS value FROM star_donations")?.value ?? 0,
      total: this.db.get<{ value: number }>("SELECT COALESCE(SUM(amount), 0) AS value FROM star_donations")?.value ?? 0,
    };
  }

  getAssetFileId(assetKey: string) {
    return this.db.get<{ file_id: string }>(
      "SELECT file_id FROM asset_cache WHERE asset_key = :assetKey",
      { assetKey },
    )?.file_id;
  }

  setAssetFileId(assetKey: string, fileId: string) {
    this.db.run(
      `
      INSERT INTO asset_cache (asset_key, file_id, updated_at)
      VALUES (:assetKey, :fileId, :now)
      ON CONFLICT(asset_key) DO UPDATE SET
        file_id = excluded.file_id,
        updated_at = excluded.updated_at
      `,
      { assetKey, fileId, now: nowIso() },
    );
  }

  redeemPromo(user: UserRecord, code: string) {
    return this.db.transaction(() => {
      const promo = this.getPromoByCode(code);
      if (!promo || !promo.is_active || promo.deleted_at) throw new Error("Промокод не найден или уже выключен");
      if (promo.expires_at && isExpiredDate(promo.expires_at)) throw new Error("Срок действия промокода закончился");
      if (promo.used_count >= promo.max_uses) throw new Error("У промокода закончились активации");

      const used = this.db.get<{ id: number }>(
        "SELECT id FROM promo_redemptions WHERE promo_code_id = :promoId AND user_id = :userId",
        { promoId: promo.id, userId: user.id },
      );
      if (used && promo.single_use_per_user) throw new Error("Ты уже активировал этот промокод");

      this.db.run("INSERT INTO promo_redemptions (promo_code_id, user_id) VALUES (:promoId, :userId)", {
        promoId: promo.id,
        userId: user.id,
      });
      this.db.run("UPDATE promo_codes SET used_count = used_count + 1 WHERE id = :id", { id: promo.id });
      this.adjustBalance({
        userId: user.id,
        amount: promo.reward,
        type: "promo",
        promoCodeId: promo.id,
        reason: `Промокод ${promo.code}`,
      });
      return promo;
    });
  }

  getState(telegramId: number) {
    return this.db.get<UserStateRecord>("SELECT * FROM user_states WHERE telegram_id = :telegramId", { telegramId });
  }

  setState(telegramId: number, flow: string, step: string, data: unknown) {
    this.db.run(
      `
      INSERT INTO user_states (telegram_id, flow, step, data, updated_at)
      VALUES (:telegramId, :flow, :step, :data, :now)
      ON CONFLICT(telegram_id) DO UPDATE SET
        flow = excluded.flow,
        step = excluded.step,
        data = excluded.data,
        updated_at = excluded.updated_at
      `,
      { telegramId, flow, step, data: JSON.stringify(data), now: nowIso() },
    );
  }

  clearState(telegramId: number) {
    this.db.run("DELETE FROM user_states WHERE telegram_id = :telegramId", { telegramId });
  }

  stats() {
    const one = (sql: string) => this.db.get<{ value: number }>(sql)?.value ?? 0;
    return {
      users: one("SELECT COUNT(*) AS value FROM users"),
      activeUsers: one("SELECT COUNT(*) AS value FROM users WHERE status = 'active'"),
      totalBalance: one("SELECT COALESCE(SUM(balance), 0) AS value FROM users"),
      totalIssued: one("SELECT COALESCE(SUM(amount), 0) AS value FROM transactions WHERE amount > 0 AND type != 'refund'"),
      totalTaken: Math.abs(one("SELECT COALESCE(SUM(amount), 0) AS value FROM transactions WHERE amount < 0")),
      totalSpent: one("SELECT COALESCE(SUM(total_spent), 0) AS value FROM users"),
      pendingPurchases: one("SELECT COUNT(*) AS value FROM purchases WHERE status = 'pending'"),
      services: one("SELECT COUNT(*) AS value FROM services"),
      promos: one("SELECT COUNT(*) AS value FROM promo_codes WHERE is_active = 1 AND deleted_at IS NULL"),
    };
  }

  topReceivers(limit = 5) {
    return this.db.query<UserRecord>(
      "SELECT * FROM users ORDER BY total_received DESC, balance DESC LIMIT :limit",
      { limit },
    );
  }
}

function donorTitleActionsForStars(amount: number) {
  if (amount >= 100) return 4;
  if (amount >= 50) return 3;
  if (amount >= 25) return 2;
  if (amount >= 10) return 1;
  return 0;
}

function isExpiredDate(value: string) {
  const date = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isFinite(date.getTime()) && date.getTime() <= Date.now();
}
