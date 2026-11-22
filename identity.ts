export type DiscordId = string & { readonly __discordSnowflake: unique symbol };

export function discordId(value: unknown): DiscordId | undefined {
  if (typeof value !== "string" || !/^[1-9]\d{0,19}$/u.test(value) ||
      (value.length === 20 && value > "18446744073709551615")) return;
  return value as DiscordId;
}

export function legacyDiscordId(value: DiscordId): `dc_${string}` {
  return `dc_${value}`;
}

export function readLegacyDiscordId(value: unknown) {
  return typeof value === "string" ? discordId(value.replace(/^dc_/u, "")) : undefined;
}

export function requireDiscordId(value: unknown) {
  const id = discordId(value);
  if (!id) throw new TypeError("Discord ID 须为有效的雪花字符串。");
  return id;
}

export type DiscordObject = Readonly<Record<string, unknown>>;
export function object(value: unknown): DiscordObject | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as DiscordObject;
}

export function displayText(value: unknown, max: number) {
  if (typeof value === "string" && value.length <= max && value.isWellFormed() && !/[\p{Cc}\p{Cf}]/u.test(value)) return value;
}
