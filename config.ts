/** Private adapter settings. Keep tokens and proxy credentials out of reports and browser data. */
export interface DiscordAccountSettings {
  readonly token: string;
  readonly expectedId?: string;
}

export interface DiscordSettings {
  readonly accounts: readonly DiscordAccountSettings[];
  readonly forwardProxy?: URL;
  readonly restBase: URL;
  readonly acceptBotMessages: boolean;
  readonly messageContentIntent: boolean;
}

import { object, requireDiscordId } from "./identity.ts";

export const discordOfficialRest = "https://discord.com/api/v10/";

function invalid(field: string): never {
  throw new TypeError(`Discord 配置字段 ${field} 无效。`);
}

function botToken(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]{20,200}$/u.test(value)) return invalid("token");
  return value;
}

function flag(value: unknown, field: string, fallback: boolean) {
  if (value === undefined) return fallback;
  return typeof value === "boolean" ? value : invalid(field);
}

function transportUrl(value: unknown, kind: "proxy" | "reverseProxy") {
  if (value === undefined || value === "") return;
  if (typeof value !== "string" || value.length > 4096 || /[\s\\]/u.test(value)) return invalid(kind);
  // Eris accepted just a hostname for its REST domain. Old configuration help also permitted an explicit URL.
  const source = kind === "reverseProxy" && !value.includes("://") ? `https://${value}` : value;
  const url = URL.parse(source);
  if (!url || !url.hostname || url.search || url.hash) return invalid(kind);
  if (kind === "proxy") {
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.pathname !== "/") return invalid(kind);
  } else {
    if (url.protocol !== "https:" || url.username || url.password || /%|\/\.{1,2}(?:\/|$)/u.test(url.pathname)) {
      return invalid(kind);
    }
    const path = url.pathname.replace(/\/$/u, "");
    url.pathname = path.endsWith("/api/v10") ? path + "/" : path + "/api/v10/";
  }
  return url;
}

function readAccounts(value: unknown): DiscordAccountSettings[] {
  if (!Array.isArray(value) || value.length > 32) return invalid("accounts");
  const tokens = new Set<string>();
  const botIds = new Set<string>();
  return value.map(raw => {
    const row = object(raw);
    if (!row) return invalid("accounts");
    const token = botToken(row.token);
    const expectedId = row.expectedId === undefined ? undefined : requireDiscordId(row.expectedId);
    if (tokens.has(token) || (expectedId !== undefined && botIds.has(expectedId))) return invalid("accounts");
    tokens.add(token);
    if (expectedId) botIds.add(expectedId);
    return { token, expectedId };
  });
}

export function parseDiscordSettings(value: unknown): DiscordSettings | undefined {
  if (value === undefined || value === null) return;
  const source = object(value);
  if (!source) return invalid("配置");
  if (!flag(source.enabled, "enabled", false)) return;
  const accounts = readAccounts(source.accounts);
  if (!accounts.length) return invalid("accounts");
  return {
    accounts,
    forwardProxy: transportUrl(source.proxy, "proxy"),
    restBase: transportUrl(source.reverseProxy, "reverseProxy") ?? new URL(discordOfficialRest),
    acceptBotMessages: flag(source.acceptBotMessages, "acceptBotMessages", false),
    messageContentIntent: flag(source.messageContentIntent, "messageContentIntent", true),
  };
}

/** Convert old config/Discord.yaml in memory. Caller publishes only to a private destination. */
export function migrateDiscordSettings(value: unknown) {
  const source = object(value);
  if (!source) return invalid("旧配置");
  const tokens = source.token ?? [];
  if (!Array.isArray(tokens) || tokens.length > 32) return invalid("token");
  const accounts = [...new Set(tokens.map(botToken))].map(token => ({ token }));
  const proxy = transportUrl(source.proxy, "proxy");
  const reverseProxy = transportUrl(source.reverseProxy, "reverseProxy");
  return {
    enabled: accounts.length > 0,
    accounts,
    ...(proxy ? { proxy: proxy.href } : {}),
    ...(reverseProxy ? { reverseProxy: reverseProxy.href } : {}),
  };
}
