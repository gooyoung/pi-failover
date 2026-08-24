# pi-failover

面向 [Pi coding agent](https://github.com/nicobailon/pi-coding-agent) `>=0.84.2` 的自动凭证与 provider 故障切换扩展。

- [English README](./README.md)

```bash
pi install npm:pi-failover
```

`pi-failover` 用于在当前凭证或 provider 不可用时，继续让 Pi 会话向下执行。它直接复用 Pi 现有的 `auth.json`，并为 API key provider 增加一个扩展字段 `"key-backup"`。

## 快速开始

### 1. 安装扩展

```bash
pi install npm:pi-failover
```

### 2. 修改 `auth.json`

`pi-failover` 只读取 Pi `getAgentDir()` 下的 `auth.json`，默认位置通常是：

```text
~/.pi/agent/auth.json
```

如果设置了 `PI_CODING_AGENT_DIR`，仍然沿用 Pi 自身的 agent 目录解析规则。

保留 Pi 原有的主凭证，并在需要同 provider 备用 key 的 API-key provider 上增加一个字面量、非空的 `"key-backup"` 字段：

```json
{
  "anthropic": {
    "type": "api_key",
    "key": "primary-api-key",
    "key-backup": "backup-api-key"
  },
  "openai-codex": {
    "type": "oauth",
    "access": "...",
    "refresh": "...",
    "expires": 1767225600000
  }
}
```

### 3. 验证故障切换已启用

启动 Pi 后执行：

```text
/failover status
```

该命令只显示脱敏后的运行时状态，不会输出原始凭证值。

当当前 key 在一次 turn 中遇到可重试故障时，`pi-failover` 会按情况执行：

- 切到同一 provider 的备用 key
- 切到下一个已配置 provider
- 当所有可选项都耗尽时，保留 Pi 原始错误

## 配置说明

- `pi-failover` 不会读取或写入 `keyrouter.json`。
- `"key-backup"` 表示同一 provider 的第二把 key，不表示 provider 级切换。
- provider 的切换顺序由 `auth.json` 顶层字段的插入顺序决定。
- OAuth 条目可以参与 provider 级切换，但不支持 `"key-backup"`。
- `"key-backup"` 按字面量字符串处理，不支持从环境变量或命令动态展开。
- Pi 的 `/login` 流程可能会重写 `auth.json` 并移除未知扩展字段，因此重新登录后可能需要再次补上 `"key-backup"`。

## 故障切换规则

每个 turn 内，同一个凭证或 provider 最多只会尝试一次。收到成功的 `2xx` 响应后，当前凭证或 provider 会被标记为健康。

| 故障类型 | `pi-failover` 的处理方式 |
| --- | --- |
| `401` / `403` | 将当前凭证在本次会话中标记为不可用，然后依次尝试该 provider 的备用 key 和下一个 provider。 |
| `429` | 按 `Retry-After` 冷却当前凭证；如果没有该响应头，则冷却 60 秒，然后尝试备用 key。 |
| `529` 或 overloaded 响应 | 按 `Retry-After` 冷却当前 provider；如果没有该响应头，则冷却 30 秒，然后切换 provider。 |
| `500`、`502`、`503`、`504`、网络错误、超时 | 将当前 provider 冷却 30 秒，然后切换 provider。 |
| 其他故障 | 保持 Pi 原有的错误处理逻辑，不额外接管。 |

发生 provider 切换时，`pi-failover` 会优先保留当前 model ID；如果目标 provider 没有该 model，则退回到该 provider 的第一个可用 model。扩展内部会调用 Pi 的 `setModel()`，因此新的默认 model 会持续生效；后续不会自动切回原 provider。

## 命令

- `/failover status`：查看脱敏后的故障切换状态
- `/failover reload`：恢复扩展接管的 override，然后重新读取 `auth.json`

## 输出模式

| 模式 | 通知行为 |
| --- | --- |
| TUI | 显示通知 |
| RPC | 显示通知 |
| JSON | 不显示 UI 通知，也不注入消息 |
| print | 不显示 UI 通知，也不注入消息 |

## 迁移说明

如果从 `~/.pi/keyrouter.json` 迁移，需要把每个 provider 的主凭证搬到 Pi 的 `auth.json` 中，再把同 provider 的第二把 key 写入 `"key-backup"`。如需控制 provider 切换顺序，可直接调整 `auth.json` 顶层条目的顺序。

当前没有双读迁移模式，`pi-failover` 只读取 `auth.json`。

## 安全说明

- 将 `auth.json` 视为敏感文件。
- 不要提交凭证内容。
- 应限制文件访问权限。
- `pi-failover` 的状态和错误信息默认保持脱敏。

## 开发

```bash
npm test
npm run typecheck
npm pack --dry-run
```
