import type { DiscordAccountSettings, DiscordSettings } from "./config.ts";
import { discordId, object, type DiscordId } from "./identity.ts";
import { normalizeDiscordMessage, type DiscordMessage } from "./messages.ts";
import { createDiscordRest, discordGatewayUrl, DiscordRequestError } from "./rest.ts";

const requiredIntents = (1 << 0) | (1 << 9) | (1 << 12);
const messageContentIntent = 1 << 15;
const maxFrameBytes = 8 * 1024 * 1024;
const helloTimeoutMs = 15_000;
const startTimeoutMs = 30_000;
const identifyIntervalMs = 5500;
const fatalCloseCodes = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
const forgetSessionCloseCodes = new Set([1000, 1001, 4007, 4009]);
type GatewaySocket = WebSocket & { terminate(): void };
const BunWebSocket = WebSocket as unknown as new (url: URL, options: Bun.WebSocketOptions) => GatewaySocket;

interface Session {
  readonly id: string;
  readonly url: URL;
  seq: number;
}

type End = {
  readonly state: "reconnect" | "stopped" | "fatal";
  readonly delay?: number;
  readonly code?: number;
};

export interface DiscordGatewayStatus {
  readonly state: "connecting" | "ready" | "reconnect" | "stopped" | "fatal";
  readonly code?: number;
}

export interface DiscordGatewayHandlers {
  readonly message: (event: DiscordMessage, signal: AbortSignal) => void | Promise<void>;
  readonly status?: (event: DiscordGatewayStatus) => void;
  readonly ready?: (bot: { readonly id: DiscordId; readonly name?: string }, signal: AbortSignal) => void;
}

function wait(ms: number, signal: AbortSignal) {
  if (signal.aborted || ms <= 0) return Promise.resolve();
  return new Promise<void>(resolve => {
    const end = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", end);
      resolve();
    };
    const timer = setTimeout(end, ms);
    signal.addEventListener("abort", end, { once: true });
  });
}

function boundedSessionId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/u.test(value) ? value : undefined;
}

export async function runDiscordGateway(account: DiscordAccountSettings, settings: DiscordSettings,
  handlers: DiscordGatewayHandlers, signal: AbortSignal, rest = createDiscordRest(account, settings)) {
  signal.throwIfAborted();
  const bot = await rest.currentUser(signal);
  const proxy = settings.forwardProxy && new URL(settings.forwardProxy);
  let session: Session | undefined;
  let lastIdentify = -Infinity;
  let backoff = 1000;
  let activeMessages = 0;
  const threadParents = new Map<DiscordId, { readonly parentId: DiscordId; readonly guildId: DiscordId }>();

  function status(state: DiscordGatewayStatus["state"], code?: number) {
    try { handlers.status?.({ state, ...(code !== undefined && { code }) }); } catch {}
  }

  function connect(url: URL, botId: DiscordId): Promise<End> {
    const closeSession = new AbortController();
    const { promise, resolve } = Promise.withResolvers<End>();
    let socket: GatewaySocket;
    try { socket = new BunWebSocket(url, { perMessageDeflate: false, ...(proxy && { proxy }) }); }
    catch { return Promise.resolve({ state: "reconnect" }); }

    let ended = false;
    let hello = false;
    let ready = false;
    let awaitingAcknowledgement = false;
    let sequence = session?.seq ?? null;
    const replayed: DiscordMessage[] = [];
    let scheduleHeartbeat: ReturnType<typeof setTimeout> | undefined;
    let identifyTimer: ReturnType<typeof setTimeout> | undefined;
    let timeout = setTimeout(() => finish({ state: "reconnect" }), helloTimeoutMs);

    function finish(result: End) {
      if (ended) return;
      ended = true;
      clearTimeout(timeout);
      clearTimeout(scheduleHeartbeat);
      clearTimeout(identifyTimer);
      signal.removeEventListener("abort", aborted);
      closeSession.abort();
      if (socket.readyState < WebSocket.CLOSING) socket.terminate();
      resolve(result);
    }

    function aborted() { finish({ state: "stopped" }); }

    function send(op: number, data: unknown) {
      if (ended || socket.readyState !== WebSocket.OPEN) return;
      try { socket.send(JSON.stringify({ op, d: data })); }
      catch { finish({ state: "reconnect" }); }
    }

    function heartbeat() {
      awaitingAcknowledgement = true;
      send(1, sequence);
    }

    function identify() {
      if (session) {
        send(6, { token: account.token, session_id: session.id, seq: session.seq });
      } else {
        lastIdentify = Date.now();
        send(2, {
          token: account.token, intents: requiredIntents | (settings.messageContentIntent ? messageContentIntent : 0),
          properties: { os: process.platform, browser: "Lotus-Yunzai", device: "Lotus-Yunzai" },
        });
      }
    }

    function helloFrame(raw: unknown) {
      const interval = object(raw)?.heartbeat_interval;
      if (hello || typeof interval !== "number" || !Number.isSafeInteger(interval) || interval < 1000 || interval > 120_000) {
        finish({ state: "reconnect" });
        return;
      }
      hello = true;
      clearTimeout(timeout);
      timeout = setTimeout(() => finish({ state: "reconnect" }), startTimeoutMs);
      const beginAfter = session ? 0 : Math.max(0, lastIdentify + identifyIntervalMs - Date.now());
      if (beginAfter) identifyTimer = setTimeout(identify, beginAfter);
      else identify();
      function tick() {
        if (awaitingAcknowledgement) {
          finish({ state: "reconnect" });
          return;
        }
        heartbeat();
        scheduleHeartbeat = setTimeout(tick, interval as number);
      }
      scheduleHeartbeat = setTimeout(tick, Math.floor(interval * Math.random()));
    }

    function becameReady() {
      clearTimeout(timeout);
      ready = true;
      backoff = 1000;
      try { handlers.ready?.(bot, closeSession.signal); } catch {}
      if (ended) return;
      status("ready");
      for (const message of replayed.splice(0)) deliver(message);
    }

    function deliver(message: DiscordMessage) {
      if (activeMessages >= 128 || ended) return;
      activeMessages++;
      void Promise.resolve().then(() => {
        if (!closeSession.signal.aborted) return handlers.message(message, closeSession.signal);
      }).catch(() => {}).finally(() => { activeMessages--; });
    }

    function rememberThread(raw: unknown, guildId?: DiscordId) {
      const row = object(raw);
      const id = discordId(row?.id), parentId = discordId(row?.parent_id);
      const guild = discordId(row?.guild_id) ?? guildId;
      if (!id || !parentId || !guild || (row?.type !== 10 && row?.type !== 11 && row?.type !== 12)) return;
      threadParents.set(id, { parentId, guildId: guild });
      if (threadParents.size > 2048) threadParents.delete(threadParents.keys().next().value!);
    }

    function dispatch(event: string, data: unknown, seq: unknown) {
      if (!hello || typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) return;
      if (event === "READY") {
        const parsed = object(data);
        const id = boundedSessionId(parsed?.session_id);
        const resumeUrl = discordGatewayUrl(parsed?.resume_gateway_url);
        if (discordId(object(parsed?.user)?.id) !== botId || !id || !resumeUrl) {
          finish({ state: "fatal" });
          return;
        }
        sequence = seq;
        session = { id, url: resumeUrl, seq };
        threadParents.clear();
        becameReady();
        return;
      }
      if (!session || (sequence !== null && seq <= sequence)) return;
      sequence = seq;
      session.seq = seq;
      if (event === "RESUMED") {
        becameReady();
      } else if (event === "MESSAGE_CREATE") {
        const row = object(data), channelId = discordId(row?.channel_id);
        const thread = channelId && threadParents.get(channelId);
        const message = normalizeDiscordMessage(row, { botId, acceptBotMessages: settings.acceptBotMessages,
          threadParentId: thread && thread.guildId === row?.guild_id ? thread.parentId : undefined });
        if (message && ready) deliver(message);
        else if (message && replayed.length < 128) replayed.push(message);
      } else if (event === "THREAD_CREATE" || event === "THREAD_UPDATE") {
        rememberThread(data);
      } else if (event === "THREAD_DELETE") {
        const id = discordId(object(data)?.id);
        if (id) threadParents.delete(id);
      } else if (event === "THREAD_LIST_SYNC" || event === "GUILD_CREATE") {
        const row = object(data);
        const guildId = discordId(event === "GUILD_CREATE" ? row?.id : row?.guild_id);
        if (Array.isArray(row?.threads)) for (const thread of row.threads.slice(0, 2048)) rememberThread(thread, guildId);
      }
    }

    socket.addEventListener("message", ({ data: frame }) => {
      if (ended || typeof frame !== "string" || frame.length > maxFrameBytes || Buffer.byteLength(frame) > maxFrameBytes) return;
      let raw: unknown;
      try { raw = JSON.parse(frame); } catch { return; }
      const value = object(raw);
      if (!value) return;
      switch (value.op) {
        case 0:
          if (typeof value.t === "string") dispatch(value.t, value.d, value.s);
          break;
        case 1:
          if (hello) heartbeat();
          break;
        case 7:
          finish({ state: "reconnect" });
          break;
        case 9:
          if (value.d !== true) session = undefined;
          finish({ state: "reconnect", delay: 1000 + Math.floor(Math.random() * 4000) });
          break;
        case 10:
          if (!ready) helloFrame(value.d);
          break;
        case 11:
          awaitingAcknowledgement = false;
      }
    });
    socket.addEventListener("close", ({ code }) => {
      if (ended) return;
      if (forgetSessionCloseCodes.has(code)) session = undefined;
      finish({ state: fatalCloseCodes.has(code) ? "fatal" : "reconnect", code });
    }, { once: true });
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    return promise;
  }

  while (!signal.aborted) {
    let url = session?.url;
    if (!url) {
      try {
        const gateway = await rest.getGateway(signal);
        if (gateway.remaining === 0) {
          status("reconnect");
          await wait(Math.max(1000, gateway.resetAfter), signal);
          continue;
        }
        url = gateway.url;
      } catch (error) {
        if (signal.aborted) break;
        if (error instanceof DiscordRequestError && (error.outcome === "configuration" || error.status === 401 || error.status === 403)) {
          status("fatal", error.status);
          return;
        }
        status("reconnect");
        await wait(backoff, signal);
        backoff = Math.min(backoff * 2, 30_000);
        continue;
      }
    }
    status("connecting");
    const next = await connect(url, bot.id);
    if (next.state === "stopped") break;
    if (next.state === "fatal") {
      status("fatal", next.code);
      return;
    }
    status("reconnect", next.code);
    await wait(next.delay ?? backoff, signal);
    backoff = Math.min(backoff * 2, 30_000);
  }
  status("stopped");
}
