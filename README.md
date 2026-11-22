# Lotus-Yunzai Discord

[Lotus-Yunzai](https://github.com/MOPELotus/Lotus-Yunzai) 的 Discord 协议适配器，使用 TypeScript 和 Bun，对接 Discord API v10。

适配器处理单分片 Bot 的 Gateway 连接、心跳与会话恢复。宿主可接收私聊、频道与线程消息，并向已确认的本账号会话回复文字、提及或附件。雪花 ID 全程保留为字符串。REST 层另提供历史消息、撤回与附件读取接口，宿主开放范围由集成决定。

## 接入

宿主从私有配置读取 Bot Token，通过 `parseDiscordSettings` 校验后调用 `createDiscordAdapter(instance, settings)`。配置默认关闭。可按需设置 `expectedId` 核对 Bot 身份，启用消息正文时需在 Discord Developer Portal 中配置相应 Intent。旧配置由 `migrateDiscordSettings` 转换，结果由宿主存入私有路径。

本仓已通过独立依赖安装和严格类型检查。宿主模拟回包、真实 Discord 网关和代理联调另行验收。

```sh
bun install --frozen-lockfile
bun run typecheck
```

实现依据为 [Gateway](https://docs.discord.com/developers/events/gateway)、[消息资源](https://docs.discord.com/developers/resources/message)、[权限](https://docs.discord.com/developers/topics/permissions)、[频率限制](https://docs.discord.com/developers/topics/rate-limits) 和 [Bun WebSocket](https://bun.com/docs/runtime/http/websockets#connect-to-a-websocket-server)。
