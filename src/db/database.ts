import fs from "node:fs";
import nodePath from "node:path";
import BetterSqlite3 from "better-sqlite3";
import type { Database as SqliteDatabase, RunResult } from "better-sqlite3";

type SQLInputValue = string | number | bigint | Buffer | null;

export class Database {
  private readonly db: SqliteDatabase;
  readonly filePath: string;

  constructor(databaseUrl: string) {
    const filePath = databaseUrl.startsWith("file:") ? databaseUrl.slice("file:".length) : databaseUrl;
    this.filePath = nodePath.resolve(process.cwd(), filePath);
    fs.mkdirSync(nodePath.dirname(this.filePath), { recursive: true });
    this.db = new BetterSqlite3(this.filePath, { timeout: 5000 });
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA temp_store = MEMORY;
    `);
    this.applySchema();
  }

  query<T>(sql: string, params: Record<string, SQLInputValue> = {}) {
    return this.db.prepare(sql).all(params) as T[];
  }

  get<T>(sql: string, params: Record<string, SQLInputValue> = {}) {
    return this.db.prepare(sql).get(params) as T | undefined;
  }

  run(sql: string, params: Record<string, SQLInputValue> = {}): RunResult {
    return this.db.prepare(sql).run(params);
  }

  transaction<T>(fn: () => T) {
    return this.db.transaction(fn)();
  }

  close() {
    this.db.close();
  }

  private applySchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id INTEGER NOT NULL UNIQUE,
        username TEXT,
        first_name TEXT,
        last_name TEXT,
        role TEXT NOT NULL DEFAULT 'user',
        status TEXT NOT NULL DEFAULT 'active',
        title TEXT,
        donor_title_html TEXT,
        donor_title_actions_used INTEGER NOT NULL DEFAULT 0,
        donor_title_bonus_actions INTEGER NOT NULL DEFAULT 0,
        balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
        cinder_limit INTEGER NOT NULL DEFAULT 500 CHECK (cinder_limit >= 0),
        total_received INTEGER NOT NULL DEFAULT 0 CHECK (total_received >= 0),
        total_spent INTEGER NOT NULL DEFAULT 0 CHECK (total_spent >= 0),
        last_activity_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_inactivity_penalty_at TEXT,
        joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_users_username ON users(username COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_users_balance ON users(balance DESC);

      CREATE TABLE IF NOT EXISTS services (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        price INTEGER NOT NULL CHECK (price >= 0),
        category TEXT NOT NULL DEFAULT 'general',
        currency TEXT NOT NULL DEFAULT 'cinders',
        pricing_type TEXT NOT NULL DEFAULT 'fixed',
        pricing_config TEXT NOT NULL DEFAULT '{}',
        is_active INTEGER NOT NULL DEFAULT 1,
        requires_approval INTEGER NOT NULL DEFAULT 1,
        created_by INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        deleted_at TEXT
      );

      CREATE TABLE IF NOT EXISTS purchases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
        price INTEGER NOT NULL CHECK (price >= 0),
        status TEXT NOT NULL DEFAULT 'pending',
        admin_id INTEGER,
        note TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        reviewed_at TEXT,
        FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_purchases_status ON purchases(status, created_at DESC);

      CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        amount INTEGER NOT NULL,
        type TEXT NOT NULL,
        balance_after INTEGER NOT NULL,
        counterparty_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        admin_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        purchase_id INTEGER REFERENCES purchases(id) ON DELETE SET NULL,
        promo_code_id INTEGER REFERENCES promo_codes(id) ON DELETE SET NULL,
        reason TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_transactions_type_created ON transactions(type, created_at);

      CREATE TABLE IF NOT EXISTS weekly_top_runs (
        week_key TEXT PRIMARY KEY,
        start_iso TEXT NOT NULL,
        end_iso TEXT NOT NULL,
        winners_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS weekly_top_rewards (
        week_key TEXT NOT NULL,
        place INTEGER NOT NULL CHECK (place BETWEEN 1 AND 3),
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        score INTEGER NOT NULL CHECK (score > 0),
        reward INTEGER NOT NULL CHECK (reward > 0),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (week_key, place)
      );

      CREATE INDEX IF NOT EXISTS idx_weekly_top_rewards_user ON weekly_top_rewards(user_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS promo_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL UNIQUE,
        reward INTEGER NOT NULL CHECK (reward > 0),
        max_uses INTEGER NOT NULL CHECK (max_uses > 0),
        used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
        single_use_per_user INTEGER NOT NULL DEFAULT 1,
        expires_at TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        deleted_at TEXT
      );

      CREATE TABLE IF NOT EXISTS promo_redemptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        promo_code_id INTEGER NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (promo_code_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS titles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        deleted_at TEXT
      );

      CREATE TABLE IF NOT EXISTS star_donations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        telegram_payment_charge_id TEXT NOT NULL UNIQUE,
        amount INTEGER NOT NULL CHECK (amount > 0),
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_star_donations_user ON star_donations(user_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS star_service_purchases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
        telegram_payment_charge_id TEXT NOT NULL UNIQUE,
        stars INTEGER NOT NULL CHECK (stars > 0),
        cinders INTEGER NOT NULL CHECK (cinders > 0),
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS star_cinder_purchases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        telegram_payment_charge_id TEXT NOT NULL UNIQUE,
        stars INTEGER NOT NULL CHECK (stars > 0),
        cinders INTEGER NOT NULL CHECK (cinders > 0),
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS asset_cache (
        asset_key TEXT PRIMARY KEY,
        file_id TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS user_states (
        telegram_id INTEGER PRIMARY KEY,
        flow TEXT NOT NULL,
        step TEXT NOT NULL,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS user_price_adjustments (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        amount INTEGER NOT NULL CHECK (amount >= 0),
        admin_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    this.addColumnIfMissing("services", "deleted_at", "TEXT");
    this.addColumnIfMissing("promo_codes", "deleted_at", "TEXT");
    this.addColumnIfMissing("users", "donor_title_html", "TEXT");
    this.addColumnIfMissing("users", "donor_title_actions_used", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("users", "donor_title_bonus_actions", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("users", "cinder_limit", "INTEGER NOT NULL DEFAULT 500");
    this.addColumnIfMissing("users", "last_activity_at", "TEXT");
    this.addColumnIfMissing("users", "last_inactivity_penalty_at", "TEXT");
    this.db.exec(`
      UPDATE users
      SET last_activity_at = COALESCE(last_activity_at, CURRENT_TIMESTAMP)
      WHERE last_activity_at IS NULL;
    `);
    this.db.exec(`
      UPDATE users
      SET cinder_limit = CASE
        WHEN balance <= 500 THEN 500
        WHEN balance <= 800 THEN 800
        WHEN balance <= 1100 THEN 1100
        WHEN balance <= 1600 THEN 1600
        WHEN balance <= 2100 THEN 2100
        WHEN balance <= 2600 THEN 2600
        WHEN balance <= 3000 THEN 3000
        ELSE balance
      END
      WHERE cinder_limit < balance;
    `);
    this.addColumnIfMissing("services", "category", "TEXT NOT NULL DEFAULT 'general'");
    this.addColumnIfMissing("services", "currency", "TEXT NOT NULL DEFAULT 'cinders'");
    this.addColumnIfMissing("services", "pricing_type", "TEXT NOT NULL DEFAULT 'fixed'");
    this.addColumnIfMissing("services", "pricing_config", "TEXT NOT NULL DEFAULT '{}'");
  }

  private addColumnIfMissing(table: string, column: string, definition: string) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (columns.some((item) => item.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
