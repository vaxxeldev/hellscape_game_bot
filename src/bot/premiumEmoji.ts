import fs from "node:fs";
import path from "node:path";
import { logger } from "../utils/logger.js";

const names = [
  "settings",
  "profile",
  "people",
  "userApproved",
  "userRejected",
  "file",
  "smile",
  "growthChart",
  "statsChart",
  "home",
  "lockClosed",
  "lockOpen",
  "announcement",
  "check",
  "cross",
  "pencil",
  "trash",
  "down",
  "attach",
  "link",
  "info",
  "bot",
  "eye",
  "hidden",
  "send",
  "download",
  "notification",
  "gift",
  "clock",
  "celebration",
  "font",
  "write",
  "media",
  "location",
  "wallet",
  "box",
  "cryptoBot",
  "calendar",
  "tag",
  "elapsed",
  "apps",
  "brush",
  "addText",
  "format",
  "money",
  "sendMoney",
  "receiveMoney",
  "code",
  "loading",
  "cinder",
  "star",
] as const;

type PremiumEmojiName = (typeof names)[number];

export const premiumEmoji = loadPremiumEmoji();

function loadPremiumEmoji() {
  const candidates = [
    path.resolve(process.cwd(), "premium_emoji.json"),
    path.resolve(process.cwd(), "..", "premium_emoji.json"),
  ];

  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Record<PremiumEmojiName, unknown>>;
      return Object.fromEntries(names.map((name) => [name, typeof raw[name] === "string" ? raw[name] : ""])) as Record<
        PremiumEmojiName,
        string
      >;
    } catch (error) {
      logger.warn({ error, file }, "failed to load premium emoji config");
    }
  }

  return Object.fromEntries(names.map((name) => [name, ""])) as Record<PremiumEmojiName, string>;
}

export function pe(id: string | undefined, fallback: string) {
  if (!id) return fallback;
  return `<tg-emoji emoji-id="${id}">${fallback}</tg-emoji>`;
}
