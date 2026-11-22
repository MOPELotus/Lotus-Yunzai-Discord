import type { DiscordSettings } from "./config.ts";
import { runDiscordGateway, type DiscordGatewayStatus } from "./gateway.ts";
import { discordId, object, type DiscordId } from "./identity.ts";
import type { DiscordMessage } from "./messages.ts";
import { createDiscordRest, DiscordRequestError, type DiscordSendPart } from "./rest.ts";

type ProjectedPart = { readonly type: "text"; readonly text: string }
  | { readonly type: "mention"; readonly id: DiscordId }
  | { readonly type: "image" | "audio" | "video" | "file"; readonly id: DiscordId; readonly name: string };

function projectMessage(instance: string, message: DiscordMessage) {
  const parts = message.parts.flatMap<ProjectedPart>(part => {
    switch (part.type) {
      case "text":
        return [part];
      case "mention":
        if (part.target === "user") return [{ type: "mention", id: part.id } as const];
        return [{ type: "text", text: part.target === "role" ? `<@&${part.id}>` : `<#${part.id}>` } as const];
      case "attachment":
        return [{ type: part.attachment.media, id: part.attachment.id, name: part.attachment.name } as const];
      case "reply":
        return [];
    }
  });
  const target = message.conversation;
  return {
    scope: { adapter: "discord", instance, account: message.botId } as const,
    conversation: target.kind === "guild"
      ? { kind: "channel", id: target.id, parentId: target.threadParentId ?? target.guildId } as const
      : { kind: "private", id: target.id } as const,
    actor: message.authorId, messageId: message.id, parts,
    ...(message.replyId && { replyTo: message.replyId }),
  };
}

type ProjectedMessage = ReturnType<typeof projectMessage>;
type Receiver = (message: ProjectedMessage) => Promise<void>;
type Channel = {
  readonly target: DiscordMessage["conversation"];
  readonly projected: ProjectedMessage["conversation"];
  readonly observed: Set<DiscordId>;
};
type OnlineAccount = {
  readonly rest: ReturnType<typeof createDiscordRest>;
  readonly live: AbortSignal;
  readonly channels: Map<DiscordId, Channel>;
};

function partOf(raw: unknown): DiscordSendPart | undefined {
  const part = object(raw);
  switch (part?.type) {
    case "text":
      return typeof part.text === "string" ? { type: "text", text: part.text } : undefined;
    case "mention": {
      const userId = discordId(part.id);
      if (userId) return { type: "mention", userId };
      return;
    }
    case "image":
    case "audio":
    case "video":
    case "file":
      if (part.bytes instanceof Uint8Array && typeof part.name === "string") {
        return { type: "attachment", bytes: part.bytes, name: part.name };
      }
  }
}

/** The implementation is structurally compatible with the host's ProtocolGateway. */
export function createDiscordAdapter(instance: string, settings: DiscordSettings, {
  status,
}: { readonly status?: (accountIndex: number, value: DiscordGatewayStatus) => void } = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(instance)) throw new TypeError("Discord 实例名称无效。");
  let running = false;
  const online = new Map<DiscordId, OnlineAccount>();

  function notify(index: number, event: DiscordGatewayStatus) {
    try { status?.(index, event); } catch {}
  }

  async function start(receive: Receiver, signal: AbortSignal) {
    if (running) throw new Error("Discord 实例已运行。");
    signal.throwIfAborted();
    running = true;
    try {
      await Promise.all(settings.accounts.map(async (account, index) => {
        const rest = createDiscordRest(account, settings);
        const identity = new AbortController();
        const accountSignal = AbortSignal.any([identity.signal, signal]);
        await runDiscordGateway(account, settings, {
          ready(bot, live) {
            const current = online.get(bot.id);
            if (current && !current.live.aborted) {
              notify(index, { state: "fatal" });
              identity.abort();
              return;
            }
            const connected = { rest, live, channels: new Map<DiscordId, Channel>() };
            online.set(bot.id, connected);
            live.addEventListener("abort", () => {
              if (online.get(bot.id) === connected) online.delete(bot.id);
            }, { once: true });
          },
          status(event) { notify(index, event); },
          async message(event, live) {
            const account = online.get(event.botId);
            if (!account || account.live !== live || live.aborted) return;
            const projected = projectMessage(instance, event);
            if (!projected.parts.length) return;
            const id = event.conversation.id;
            const prior = account.channels.get(id);
            const channel = prior && prior.target.kind === event.conversation.kind &&
              prior.projected.parentId === projected.conversation.parentId
              ? prior : { target: event.conversation, projected: projected.conversation, observed: new Set<DiscordId>() };
            account.channels.set(id, channel);
            channel.observed.add(event.id);
            if (event.replyId) channel.observed.add(event.replyId);
            while (channel.observed.size > 128) channel.observed.delete(channel.observed.values().next().value!);
            if (account.channels.size > 4096) account.channels.delete(account.channels.keys().next().value!);
            await receive(projected);
          },
        }, accountSignal, rest).catch(error => {
          if (!accountSignal.aborted) notify(index, { state: "fatal",
            ...(error instanceof DiscordRequestError && error.status !== undefined && { code: error.status }) });
        });
      }));
    } finally {
      online.clear();
      running = false;
    }
  }

  async function send(message: unknown, rawParts: readonly unknown[], signal: AbortSignal) {
    const row = object(message), scope = object(row?.scope), conversation = object(row?.conversation);
    const channelId = discordId(conversation?.id), botId = discordId(scope?.account);
    if (!channelId || !botId || scope?.adapter !== "discord" || scope.instance !== instance || scope.platform !== undefined) {
      return { status: "unsupported" } as const;
    }
    const account = online.get(botId);
    const channel = account?.channels.get(channelId);
    if (!channel || !account || channel.projected.kind !== conversation?.kind ||
        channel.projected.parentId !== conversation?.parentId) return { status: "unsupported" } as const;
    if (signal.aborted || account.live.aborted) return { status: "rejected" } as const;
    const replyTo = discordId(row?.replyTo);
    if (row?.replyTo !== undefined && (!replyTo || !channel.observed.has(replyTo))) return { status: "rejected" } as const;
    if (!Array.isArray(rawParts) || !rawParts.length || rawParts.length > 100) return { status: "rejected" } as const;
    const parts = rawParts.map(partOf);
    if (parts.some(part => !part)) return { status: "unsupported" } as const;
    const active = AbortSignal.any([signal, account.live]);
    try {
      const receipt = await account.rest.send(channel.target, parts as DiscordSendPart[], { signal: active, replyTo });
      return { status: "accepted", messageId: receipt.id } as const;
    } catch (error) {
      return { status: error instanceof DiscordRequestError && error.outcome === "unknown" ? "unknown" : "rejected" } as const;
    }
  }

  return { start, send };
}
