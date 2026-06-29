import type { UserRecord } from "../types.js";

export function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function cleanUsername(value: string) {
  return value.trim().replace(/^@/, "");
}

export function formatAmount(value: number) {
  return new Intl.NumberFormat("ru-RU").format(value);
}

export function formatCinders(value: number) {
  return `${formatAmount(value)} <tg-emoji emoji-id="5314763033682143911">💎</tg-emoji>`;
}

export function usernameOrName(user: Pick<UserRecord, "username" | "first_name" | "last_name">) {
  if (user.username) return `@${user.username}`;
  return userDisplayName(user);
}

export function userDisplayName(user: Pick<UserRecord, "username" | "first_name" | "last_name">) {
  if (user.username) return user.username;
  return [user.first_name, user.last_name].filter(Boolean).join(" ") || "без имени";
}

export function mentionUser(user: Pick<UserRecord, "telegram_id" | "username" | "first_name" | "last_name">) {
  const label = escapeHtml(userDisplayName(user));
  return `<a href="tg://user?id=${user.telegram_id}">${label}</a>`;
}

export function topUserName(user: Pick<UserRecord, "username" | "first_name" | "last_name">, maxLength = 28) {
  return escapeHtml(truncateDisplayName(userDisplayName(user), maxLength));
}

function truncateDisplayName(value: string, maxLength: number) {
  const chars = Array.from(value.trim() || "без имени");
  if (chars.length <= maxLength) return chars.join("");
  return `${chars.slice(0, Math.max(0, maxLength - 3)).join("")}...`;
}

export function sanitizeDonorTitleHtml(input: string) {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Титул не может быть пустым");
  if (trimmed.length > 256) throw new Error("Титул слишком длинный. Максимум 256 символов с HTML-тегами.");

  const allowedSimpleTags = new Set(["b", "i", "u", "s", "code", "tg-spoiler"]);
  const stack: string[] = [];
  let output = "";
  let cursor = 0;
  const tagPattern = /<[^>]+>/g;

  for (const match of trimmed.matchAll(tagPattern)) {
    const tag = match[0];
    const index = match.index ?? 0;
    output += escapeHtml(trimmed.slice(cursor, index));

    const simpleOpen = tag.match(/^<(b|i|u|s|code|tg-spoiler)>$/);
    const simpleClose = tag.match(/^<\/(b|i|u|s|code|tg-spoiler)>$/);
    const emojiOpen = tag.match(/^<tg-emoji emoji-id="(\d{5,30})">$/);
    const emojiClose = tag === "</tg-emoji>";

    if (simpleOpen && allowedSimpleTags.has(simpleOpen[1])) {
      stack.push(simpleOpen[1]);
      output += tag;
    } else if (simpleClose && allowedSimpleTags.has(simpleClose[1])) {
      const expected = stack.pop();
      if (expected !== simpleClose[1]) throw new Error("HTML-теги в титуле закрыты неправильно.");
      output += tag;
    } else if (emojiOpen) {
      stack.push("tg-emoji");
      output += `<tg-emoji emoji-id="${emojiOpen[1]}">`;
    } else if (emojiClose) {
      const expected = stack.pop();
      if (expected !== "tg-emoji") throw new Error("HTML-теги в титуле закрыты неправильно.");
      output += tag;
    } else {
      output += escapeHtml(tag);
    }

    cursor = index + tag.length;
  }

  output += escapeHtml(trimmed.slice(cursor));
  if (stack.length) throw new Error("В титуле есть незакрытые HTML-теги.");
  return output;
}

export function slugify(input: string) {
  const slug = input
    .trim()
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[^a-zа-я0-9]+/giu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return slug || `service_${Date.now()}`;
}
