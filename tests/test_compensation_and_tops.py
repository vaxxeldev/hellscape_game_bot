import os
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
NPM = "npm.cmd" if os.name == "nt" else "npm"


def test_compensation_audience_and_top_filters():
    subprocess.run([NPM, "run", "build"], cwd=ROOT, check=True, text=True, capture_output=True)

    script = r"""
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "./dist/db/database.js";
import { Repositories } from "./dist/db/repositories.js";

const dbPath = path.join(os.tmpdir(), `game-bot-compensation-${process.pid}-${Date.now()}.sqlite`);
const db = new Database(`file:${dbPath}`);
const repos = new Repositories(db);

try {
  const developer = repos.upsertUser({ telegramId: 1, username: "developer", role: "developer" });
  const owner = repos.upsertUser({ telegramId: 2, username: "owner", role: "owner" });
  const admin = repos.upsertUser({ telegramId: 3, username: "admin", role: "admin" });
  const user = repos.upsertUser({ telegramId: 4, username: "player", role: "user" });
  const filled = repos.upsertUser({ telegramId: 5, username: "filled", role: "user" });
  const excludedById = repos.upsertUser({ telegramId: 99, username: "configured_dev", role: "user" });

  db.run("UPDATE users SET cinder_limit = 2000 WHERE id IN (:devId, :adminId, :excludedId)", {
    devId: developer.id,
    adminId: admin.id,
    excludedId: excludedById.id,
  });
  db.run("UPDATE users SET cinder_limit = 105 WHERE id = :id", { id: filled.id });

  repos.adjustBalance({ userId: developer.id, amount: 1000, type: "grant", reason: "dev test" });
  repos.adjustBalance({ userId: excludedById.id, amount: 900, type: "grant", reason: "configured dev test" });
  repos.adjustBalance({ userId: admin.id, amount: 700, type: "grant", reason: "admin balance is allowed in tops" });
  repos.adjustBalance({ userId: user.id, amount: 100, type: "grant", reason: "regular grant" });
  repos.adjustBalance({ userId: filled.id, amount: 104, type: "grant", reason: "filled limit" });
  repos.adjustBalance({ userId: user.id, amount: 50, type: "compensation", reason: "not weekly score" });

  const excluded = [1, 2, 3, 99];
  const topIds = repos.topUsers(10, 0, [99]).map((item) => item.telegram_id);
  assert.equal(topIds.includes(1), false);
  assert.equal(topIds.includes(99), false);
  assert.equal(topIds.includes(3), true);

  const startIso = "2000-01-01 00:00:00";
  const endIso = "2999-12-31 23:59:59";
  const weekly = repos.weeklyTopUsers(startIso, endIso, 10, 0, [99]);
  assert.equal(weekly.some((item) => item.telegram_id === 1), false);
  assert.equal(weekly.some((item) => item.telegram_id === 99), false);
  assert.equal(weekly.find((item) => item.telegram_id === 4)?.weekly_score, 100);
  assert.equal(repos.countWeeklyTopUsers(startIso, endIso, [99]), 3);

  const recipients = repos.listCompensationRecipients(excluded).map((item) => item.telegram_id);
  assert.deepEqual(recipients, [4, 5]);

  const preview = repos.previewCompensation(5, excluded);
  assert.deepEqual(preview.blocked.map((item) => item.user.telegram_id), [5]);
  assert.throws(() =>
    repos.applyCompensation({
      amount: 5,
      reason: "blocked by limit",
      developerUserId: developer.id,
      excludedTelegramIds: excluded,
    }),
  );
  assert.equal(repos.getUserByTelegramId(4).balance, 150);

  const result = repos.applyCompensation({
    amount: 1,
    reason: "safe compensation",
    developerUserId: developer.id,
    excludedTelegramIds: excluded,
  });
  assert.equal(result.recipients.length, 2);
  assert.equal(repos.getUserByTelegramId(4).balance, 151);
  assert.equal(repos.getUserByTelegramId(5).balance, 105);
} finally {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
}
"""
    subprocess.run(["node", "--input-type=module", "-e", script], cwd=ROOT, check=True, text=True)
