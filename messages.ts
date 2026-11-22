import { discordId, displayText, object, type DiscordId } from "./identity.ts";

const maxContentChars = 4000;
const maxAttachments = 10;
const mentionPattern = /<@(!?)([1-9]\d{0,19})>|<@&([1-9]\d{0,19})>|<#([1-9]\d{0,19})>/gu;
const attachmentHosts = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

export interface DiscordAttachment {
  readonly id: DiscordId;
  readonly name: string;
  readonly size: number;
  readonly url: string;
  readonly media: "image" | "audio" | "video" | "file";
  readonly contentType?: string;
}

export type DiscordInboundPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "mention"; readonly target: "user" | "role" | "channel"; readonly id: DiscordId }
  | { readonly type: "reply"; readonly id: DiscordId }
  | { readonly type: "attachment"; readonly attachment: DiscordAttachment };

export type DiscordConversation =
  | { readonly kind: "guild"; readonly id: DiscordId; readonly guildId: DiscordId; readonly threadParentId?: DiscordId }
  | { readonly kind: "dm"; readonly id: DiscordId; readonly peerId: DiscordId };

export interface DiscordMessage {
  readonly id: DiscordId;
  readonly botId: DiscordId;
  readonly authorId: DiscordId;
  readonly authorName?: string;
  readonly conversation: DiscordConversation;
  readonly text: string;
  readonly parts: readonly DiscordInboundPart[];
  readonly replyId?: DiscordId;
  readonly memberRoles: readonly DiscordId[];
  readonly mentionsBot: boolean;
}

export function discordAttachmentUrl(value: unknown, channelId: DiscordId, attachmentId: DiscordId) {
  const url = typeof value === "string" && value.length <= 4096 ? URL.parse(value) : null;
  if (!url || url.protocol !== "https:" || url.port || url.username || url.password || url.hash ||
      !attachmentHosts.has(url.hostname) || !url.pathname.startsWith(`/attachments/${channelId}/${attachmentId}/`)) return;
  return url;
}

function attachmentOf(value: unknown, channelId: DiscordId): DiscordAttachment | undefined {
  const row = object(value);
  if (!row) return;
  const id = discordId(row.id);
  const name = displayText(row.filename, 255);
  const size = row.size;
  if (!id || !name || typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return;
  const url = discordAttachmentUrl(row.url, channelId, id);
  if (!url) return;
  const contentType = typeof row.content_type === "string" &&
    /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/iu.test(row.content_type) ? row.content_type : undefined;
  const category = contentType?.split("/", 1)[0]?.toLowerCase();
  const media = category === "image" || category === "audio" || category === "video" ? category : "file";
  return { id, name, size, url: url.href, media, ...(contentType && { contentType }) };
}

function splitMentions(content: string, users: ReadonlySet<DiscordId>, roles: ReadonlySet<DiscordId>): DiscordInboundPart[] {
  const parts: DiscordInboundPart[] = [];
  let offset = 0;
  for (const match of content.matchAll(mentionPattern)) {
    const target = match[2] ? "user" : match[3] ? "role" : "channel";
    const id = discordId(match[2] ?? match[3] ?? match[4]);
    if (!id || (target === "user" && !users.has(id)) || (target === "role" && !roles.has(id))) continue;
    const before = content.slice(offset, match.index);
    if (before) parts.push({ type: "text", text: before });
    parts.push({ type: "mention", target, id });
    offset = match.index! + match[0].length;
  }
  if (offset < content.length) parts.push({ type: "text", text: content.slice(offset) });
  return parts;
}

type DecodeOptions = {
  readonly botId: DiscordId;
  readonly acceptBotMessages?: boolean;
  readonly channelId?: DiscordId;
  readonly dmPeerId?: DiscordId;
  readonly guildId?: DiscordId;
  readonly threadParentId?: DiscordId;
  /** Reply lookup can decode an already fetched message written by the bot itself. */
  readonly lookup?: boolean;
};

export function normalizeDiscordMessage(raw: unknown, options: DecodeOptions): DiscordMessage | undefined {
  const row = object(raw), author = object(row?.author);
  const authorId = discordId(author?.id), id = discordId(row?.id), channelId = discordId(row?.channel_id);
  if (!row || !author || !id || !authorId || !channelId || (options.channelId && options.channelId !== channelId) ||
      (row.type !== 0 && row.type !== 19)) return;
  if (!options.lookup && (authorId === options.botId || row.webhook_id !== undefined ||
      (author.bot === true && !options.acceptBotMessages))) return;

  const eventGuild = discordId(row.guild_id);
  if ((row.guild_id != null && !eventGuild) || (options.guildId && eventGuild && options.guildId !== eventGuild)) return;
  const guildId = eventGuild ?? options.guildId;
  const dmPeerId = options.dmPeerId ?? authorId;
  if (!guildId && options.dmPeerId && authorId !== options.botId && authorId !== options.dmPeerId) return;
  const conversation: DiscordConversation = guildId ? { kind: "guild", id: channelId, guildId, threadParentId: options.threadParentId }
    : { kind: "dm", id: channelId, peerId: dmPeerId };

  const text = row.content === undefined ? "" : row.content;
  if (typeof text !== "string" || text.length > maxContentChars || !text.isWellFormed() || text.includes("\u0000")) return;
  const userMentions = Array.isArray(row.mentions) ? row.mentions : [];
  const users = new Set(userMentions.slice(0, 100).flatMap(value => discordId(object(value)?.id) ?? []));
  const roles = new Set(Array.isArray(row.mention_roles) ? row.mention_roles.slice(0, 100).flatMap(value => discordId(value) ?? []) : []);
  const parts = splitMentions(text, users, roles);
  const reference = object(row.message_reference);
  const replyId = row.type === 19 && (reference?.type === undefined || reference.type === 0) &&
    (reference?.channel_id === undefined || reference.channel_id === channelId) &&
    (reference?.guild_id === undefined || reference.guild_id === guildId) ? discordId(reference?.message_id) : undefined;
  if (replyId) parts.unshift({ type: "reply", id: replyId });
  if (Array.isArray(row.attachments)) {
    for (const attachment of row.attachments.slice(0, maxAttachments)) {
      const value = attachmentOf(attachment, channelId);
      if (value) parts.push({ type: "attachment", attachment: value });
    }
  }
  if (!parts.length) return;

  const member = object(row.member);
  const memberRoles = Array.isArray(member?.roles) ? member.roles.slice(0, 250).flatMap(role => discordId(role) ?? []) : [];
  return {
    id, botId: options.botId, authorId, conversation, text, parts, ...(replyId && { replyId }),
    authorName: displayText(member?.nick, 128) || displayText(author.global_name, 128) || displayText(author.username, 128),
    memberRoles, mentionsBot: users.has(options.botId),
  };
}
