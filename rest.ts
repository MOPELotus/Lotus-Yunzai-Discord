import { randomUUID } from "node:crypto";
import type { DiscordAccountSettings, DiscordSettings } from "./config.ts";
import { discordId, displayText, object, requireDiscordId, type DiscordId } from "./identity.ts";
import { discordAttachmentUrl, normalizeDiscordMessage, type DiscordAttachment, type DiscordConversation } from "./messages.ts";

const defaultUploadBytes = 10 * 1024 * 1024;
const maxJsonBytes = 2 * 1024 * 1024;
const requestTimeoutMs = 15_000;
const attachmentTimeoutMs = 10_000;
const maxRateLimitDelayMs = 5_000;

export type DiscordRequestOutcome = "rejected" | "unknown" | "rate-limited" | "configuration";
export class DiscordRequestError extends Error {
  constructor(readonly outcome: DiscordRequestOutcome, readonly status?: number, readonly code?: number) {
    super(`Discord 请求${outcome === "unknown" ? "回执未确认" : outcome === "rate-limited" ? "受到频率限制" :
      outcome === "configuration" ? "配置无效" : "被拒绝"}。`);
  }
}

export type DiscordSendPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "mention"; readonly userId: DiscordId }
  | { readonly type: "attachment"; readonly bytes: Uint8Array; readonly name: string; readonly contentType?: string };

export interface DiscordSendOptions {
  readonly signal?: AbortSignal;
  readonly replyTo?: DiscordId;
  readonly mentionReplyAuthor?: boolean;
}

function encodeMessage(parts: readonly DiscordSendPart[], channelId: DiscordId, { replyTo, mentionReplyAuthor }: DiscordSendOptions) {
  const mentions = new Set<DiscordId>();
  const attachments: Array<{ readonly id: number; readonly filename: string }> = [];
  const files: Blob[] = [];
  if (parts.length > 100) throw new DiscordRequestError("rejected");
  let text = "";
  let totalBytes = 0;
  for (const part of parts) {
    if (part.type === "text") {
      text += part.text;
    } else if (part.type === "mention") {
      const id = requireDiscordId(part.userId);
      mentions.add(id);
      text += `<@${id}>`;
    } else if (part.type === "attachment") {
      if (!(part.bytes instanceof Uint8Array) || !part.bytes.length || files.length === 10 ||
          (totalBytes += part.bytes.length) > defaultUploadBytes || !displayText(part.name, 200) ||
          /[/\\]/u.test(part.name) || part.name === "." || part.name === "..") throw new DiscordRequestError("rejected");
      const type = part.contentType && /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u.test(part.contentType)
        ? part.contentType : "application/octet-stream";
      attachments.push({ id: files.length, filename: part.name });
      files.push(new Blob([Uint8Array.from(part.bytes)], { type }));
    }
  }
  if ((!text.trim() && !files.length) || text.length > 2000 || !text.isWellFormed() || text.includes("\u0000")) {
    throw new DiscordRequestError("rejected");
  }
  const payload = {
    ...(text && { content: text }),
    nonce: randomUUID().replaceAll("-", "").slice(0, 25),
    enforce_nonce: true,
    allowed_mentions: { parse: [], users: [...mentions], replied_user: Boolean(replyTo && mentionReplyAuthor) },
    ...(replyTo && { message_reference: { message_id: requireDiscordId(replyTo), channel_id: channelId, fail_if_not_exists: true } }),
    ...(attachments.length && { attachments }),
  };
  if (!files.length) return JSON.stringify(payload);
  const form = new FormData();
  form.set("payload_json", JSON.stringify(payload));
  for (const [index, file] of files.entries()) form.set(`files[${index}]`, file, attachments[index]!.filename);
  return form;
}

async function boundedBytes(response: Response, max: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const output = [];
  let size = 0;
  try {
    if (Number(response.headers.get("content-length")) > max) throw new DiscordRequestError("rejected", response.status);
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      if ((size += next.value.byteLength) > max) throw new DiscordRequestError("rejected", response.status);
      output.push(next.value);
    }
    return Buffer.concat(output, size);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function json(response: Response): Promise<unknown> {
  if (response.status === 204) return;
  const bytes = await boundedBytes(response, maxJsonBytes);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function retryAfter(response: Response, value: unknown) {
  const raw = object(value)?.retry_after ?? response.headers.get("retry-after");
  const seconds = typeof raw === "string" && /^\d+(?:\.\d+)?$/u.test(raw) ? Number(raw) : raw;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 ? Math.max(100, Math.ceil(seconds * 1000)) : undefined;
}

function wireCode(raw: unknown) {
  const code = object(raw)?.code;
  return typeof code === "number" && Number.isSafeInteger(code) && code >= 0 ? code : undefined;
}

async function delay(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function discordGatewayUrl(value: unknown): URL | undefined {
  const url = typeof value === "string" && value.length <= 512 ? URL.parse(value) : null;
  if (!url || url.protocol !== "wss:" || !/^gateway(?:-[a-z0-9-]+)?\.discord\.gg$/u.test(url.hostname) ||
      url.port || url.username || url.password || url.pathname !== "/" || url.hash) return;
  url.search = "?v=10&encoding=json";
  return url;
}

export function createDiscordRest(account: DiscordAccountSettings, settings: Pick<DiscordSettings, "restBase" | "forwardProxy">,
  transport: typeof fetch = fetch) {
  const restBase = new URL(settings.restBase);
  const proxy = settings.forwardProxy && new URL(settings.forwardProxy);
  if (restBase.protocol !== "https:" || restBase.username || restBase.password || restBase.search || restBase.hash ||
      !restBase.pathname.endsWith("/")) throw new DiscordRequestError("configuration");
  const headersFor = (body: unknown) => new Headers({
    Authorization: `Bot ${account.token}`, Accept: "application/json",
    "User-Agent": "DiscordBot (https://github.com/MOPELotus/Lotus-Yunzai, 0.1.0)",
    ...(typeof body === "string" && { "Content-Type": "application/json" }),
  });
  let lane: Promise<unknown> = Promise.resolve();
  let outstanding = 0;
  let globalPauseUntil = 0;

  async function perform(method: "GET" | "POST" | "DELETE", path: string, body?: BodyInit, active?: AbortSignal) {
    const timeout = AbortSignal.timeout(requestTimeoutMs);
    const signal = active ? AbortSignal.any([active, timeout]) : timeout;
    const url = new URL(path, restBase);
    let retries = 0;
    for (;;) {
      signal.throwIfAborted();
      const wait = globalPauseUntil - Date.now();
      if (wait > maxRateLimitDelayMs) throw new DiscordRequestError("rate-limited", 429);
      if (wait > 0) await delay(wait, signal);
      let response: Response;
      try {
        response = await transport(url, { method, headers: headersFor(body), body, signal, redirect: "error", proxy: proxy ?? false });
      } catch {
        throw new DiscordRequestError("unknown");
      }
      if (response.redirected) throw new DiscordRequestError("unknown", response.status);
      const result = await json(response).catch(() => undefined);
      if (response.status === 429) {
        const retry = retryAfter(response, result);
        if (retry !== undefined && (object(result)?.global === true || response.headers.get("x-ratelimit-global") === "true")) {
          globalPauseUntil = Math.max(Date.now() + retry, globalPauseUntil);
        }
        if (retry === undefined || retry > maxRateLimitDelayMs || retries++ >= 1) throw new DiscordRequestError("rate-limited", 429);
        await delay(retry, signal);
        continue;
      }
      if (!response.ok) throw new DiscordRequestError(response.status >= 500 ? "unknown" : "rejected", response.status, wireCode(result));
      if (response.status !== 204 && result === undefined) throw new DiscordRequestError("unknown", response.status);
      return result;
    }
  }

  function request(method: "GET" | "POST" | "DELETE", path: string, body?: BodyInit | (() => BodyInit), signal?: AbortSignal) {
    if (outstanding >= 32) return Promise.reject(new DiscordRequestError("rate-limited"));
    if (signal?.aborted) return Promise.reject(signal.reason);
    outstanding++;
    const task = lane.then(() => {
      signal?.throwIfAborted();
      return perform(method, path, typeof body === "function" ? body() : body, signal);
    });
    lane = task.catch(() => {}).finally(() => { outstanding--; });
    return task;
  }

  return {
    async getGateway(signal?: AbortSignal) {
      const value = object(await request("GET", "gateway/bot", undefined, signal));
      const url = discordGatewayUrl(value?.url), startLimit = object(value?.session_start_limit);
      const remaining = startLimit?.remaining, shardCount = value?.shards, resetAfter = startLimit?.reset_after;
      if (!url || typeof remaining !== "number" || !Number.isSafeInteger(remaining) || remaining < 0 ||
          typeof shardCount !== "number" || !Number.isSafeInteger(shardCount) || shardCount < 1 ||
          typeof resetAfter !== "number" || !Number.isSafeInteger(resetAfter) || resetAfter < 0) {
        throw new DiscordRequestError("unknown");
      }
      if (shardCount !== 1) throw new DiscordRequestError("configuration");
      return { url, remaining, resetAfter };
    },
    async currentUser(signal?: AbortSignal) {
      const row = object(await request("GET", "users/@me", undefined, signal));
      const id = discordId(row?.id);
      if (!id || row?.bot !== true) throw new DiscordRequestError("configuration");
      if (account.expectedId && account.expectedId !== id) throw new DiscordRequestError("configuration");
      return { id, name: displayText(row.username, 128) };
    },
    async openDm(userId: DiscordId, signal?: AbortSignal) {
      const body = JSON.stringify({ recipient_id: requireDiscordId(userId) });
      const row = object(await request("POST", "users/@me/channels", body, signal));
      const id = discordId(row?.id);
      if (!id || row?.type !== 1 || !Array.isArray(row.recipients) ||
          row.recipients.length !== 1 || object(row.recipients[0])?.id !== userId) throw new DiscordRequestError("unknown");
      return { kind: "dm", id, peerId: userId } as const;
    },
    async send(conversation: DiscordConversation, parts: readonly DiscordSendPart[], options: DiscordSendOptions = {}) {
      const channelId = requireDiscordId(conversation.id);
      const result = object(await request("POST", `channels/${channelId}/messages`, () => encodeMessage(parts, channelId, options), options.signal));
      const id = discordId(result?.id);
      if (!id || result?.channel_id !== channelId) throw new DiscordRequestError("unknown");
      return { id, conversation };
    },
    async getMessage(conversation: DiscordConversation, messageId: DiscordId, botId: DiscordId, signal?: AbortSignal) {
      const channelId = requireDiscordId(conversation.id);
      const value = await request("GET", `channels/${channelId}/messages/${requireDiscordId(messageId)}`, undefined, signal);
      const message = normalizeDiscordMessage(value, { botId, channelId, lookup: true,
        ...(conversation.kind === "guild" ? { guildId: conversation.guildId } : { dmPeerId: conversation.peerId }),
      });
      if (message?.id !== messageId || message.conversation.kind !== conversation.kind) throw new DiscordRequestError("unknown");
      return message;
    },
    async deleteMessage(conversation: DiscordConversation, id: DiscordId, signal?: AbortSignal) {
      await request("DELETE", `channels/${requireDiscordId(conversation.id)}/messages/${requireDiscordId(id)}`, undefined, signal);
    },
    async readAttachment(conversation: DiscordConversation, attachment: DiscordAttachment, signal?: AbortSignal) {
      const url = discordAttachmentUrl(attachment.url, requireDiscordId(conversation.id), requireDiscordId(attachment.id));
      if (!url || !Number.isSafeInteger(attachment.size) || attachment.size < 0 || attachment.size > defaultUploadBytes) {
        throw new DiscordRequestError("rejected");
      }
      const deadline = AbortSignal.timeout(attachmentTimeoutMs);
      const response = await transport(url, { redirect: "error", credentials: "omit", proxy: proxy ?? false,
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
      if (!response.ok || response.redirected) throw new DiscordRequestError("rejected", response.status);
      const bytes = await boundedBytes(response, attachment.size);
      if (bytes.length !== attachment.size) throw new DiscordRequestError("rejected");
      return bytes;
    },
  };
}
