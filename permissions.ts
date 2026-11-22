import { discordId, object, type DiscordId } from "./identity.ts";

export const discordPermissions = {
  administrator: 1n << 3n,
  viewChannel: 1n << 10n,
  sendMessages: 1n << 11n,
  manageMessages: 1n << 13n,
  embedLinks: 1n << 14n,
  attachFiles: 1n << 15n,
  readMessageHistory: 1n << 16n,
  mentionEveryone: 1n << 17n,
  sendMessagesInThreads: 1n << 38n,
} as const;

function bits(value: unknown): bigint | undefined {
  if (typeof value === "string" && /^\d{1,24}$/u.test(value)) return BigInt(value);
}

export interface DiscordChannelPermissionInput {
  readonly guildId: DiscordId;
  readonly ownerId: DiscordId;
  readonly memberId: DiscordId;
  readonly roleIds: readonly DiscordId[];
  readonly roles: readonly unknown[];
  /** For a thread, use the parent channel's overwrite list. */
  readonly overwrites: readonly unknown[];
  readonly thread?: boolean;
}

export function discordChannelCapabilities({ guildId, ownerId, memberId, roleIds, roles, overwrites, thread }:
  DiscordChannelPermissionInput) {
  let effective = 0n;
  const memberRoles = new Set(roleIds);
  const known = new Set<DiscordId>();
  for (const row of roles.map(object)) {
    const id = discordId(row?.id), permission = bits(row?.permissions);
    if (!id || permission === undefined || known.has(id)) return;
    known.add(id);
    if (id === guildId || memberRoles.has(id)) effective |= permission;
  }
  if (!known.has(guildId) || roleIds.some(role => !known.has(role))) return;
  const isOwner = ownerId === memberId;
  const isAdministrator = (effective & discordPermissions.administrator) !== 0n;
  if (!isOwner && !isAdministrator) {
    let roleAllow = 0n, roleDeny = 0n, everyoneAllow = 0n, everyoneDeny = 0n, personalAllow = 0n, personalDeny = 0n;
    for (const row of overwrites.map(object)) {
      const id = discordId(row?.id), allow = bits(row?.allow), deny = bits(row?.deny);
      if (!id || allow === undefined || deny === undefined || (row?.type !== 0 && row?.type !== 1)) return;
      if (row.type === 0 && id === guildId) { everyoneAllow |= allow; everyoneDeny |= deny; }
      else if (row.type === 0 && memberRoles.has(id)) { roleAllow |= allow; roleDeny |= deny; }
      else if (row.type === 1 && id === memberId) { personalAllow |= allow; personalDeny |= deny; }
    }
    effective = (effective & ~everyoneDeny) | everyoneAllow;
    effective = (effective & ~roleDeny) | roleAllow;
    effective = (effective & ~personalDeny) | personalAllow;
  }
  const has = (permission: bigint) => isOwner || isAdministrator || (effective & permission) !== 0n;
  const canRead = has(discordPermissions.viewChannel);
  const canSend = canRead && has(thread ? discordPermissions.sendMessagesInThreads : discordPermissions.sendMessages);
  return {
    isOwner, isAdministrator, canRead, canSend,
    canReadHistory: canRead && has(discordPermissions.readMessageHistory),
    canAttach: canSend && has(discordPermissions.attachFiles),
    canMentionEveryone: canSend && has(discordPermissions.mentionEveryone),
    canManageMessages: canRead && has(discordPermissions.manageMessages),
  };
}
