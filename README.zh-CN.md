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

保留 Pi 原有的主凭证，并在需要同 provider 备用 key 的 API-key provider 上增加 `"key-backup"` 字段。该字段既可以是一个字面量、非空字符串，也可以是由字面量、非空字符串组成的非空数组：

```json
{
  "anthropic": {
    "type": "api_key",
    "key": "primary-api-key",
    "key-backup": ["backup-api-key-1", "backup-api-key-2"]
  },
  "openai-codex": {
    "type": "oauth",
    "access": "...",
    "refresh": "...",
    "expires": 1767225600000
  }
}
```

现有字符串形式等价于只含一项的数组，数组中的凭证按书写顺序尝试。如果数组为空或任一元素无效，整个备用字段都会被忽略，该 provider 仍只能使用主凭证。

### 3. 验证故障切换已启用

启动 Pi 后执行：

```text
/failover status
```

该命令只显示脱敏后的运行时状态，不会输出原始凭证值。

当当前 key 在一次用户请求中遇到已接管的故障时，`pi-failover` 会按情况执行：

- 切到同一 provider 的下一把备用 key
- 切到下一个已配置 provider
- 成功切换后自动重试同一次用户请求
- 当所有可选项都耗尽时，只显示最后一次 provider 错误

中间 provider 错误会被替换为隐藏的续跑消息，因此用户无需再次发送相同内容。TUI 和 RPC 模式仍会为每次实际生效的凭据或 provider 切换显示一条脱敏警告。

以下是切换到备用凭证及切换 provider 后显示的警告示例：

![切换到备用凭证的警告](https://raw.githubusercontent.com/gooyoung/pi-failover/main/docs/images/failover-backup-credential-switch.png)

![切换 provider 的警告](https://raw.githubusercontent.com/gooyoung/pi-failover/main/docs/images/failover-provider-switches.png)

如果所有 failover 选项已经耗尽，但 Pi 仍有内置自动重试尚未执行，扩展会保留最后一个实际使用的凭证，直到该重试结束。重试成功时继续保留该凭证；最终仍失败时，扩展才恢复其运行时 override，并只报告一次 exhausted。这样可以避免 Pi 的重试意外切回已经失败的主凭证。

## 配置说明

- `pi-failover` 不会读取或写入 `keyrouter.json`。
- `"key-backup"` 表示同一 provider 的一把或多把备用 key，不表示 provider 级切换。
- provider 优先按 `auth.json` 顶层字段的插入顺序切换，再按 Pi 模型注册表顺序追加发现的自定义 provider。
- OAuth 条目可以参与 provider 级切换，但不支持 `"key-backup"`。
- `"key-backup"` 中的每个值都按字面量字符串处理，不支持从环境变量或命令动态展开。
- Pi 的 `/login` 流程可能会重写 `auth.json` 并移除未知扩展字段，因此重新登录后可能需要再次补上 `"key-backup"`。

## 故障切换规则

同一次用户请求内，失败的凭证或 provider 会先被禁用或进入冷却，再执行隐藏续跑。收到成功的 `2xx` 响应后，当前凭证或 provider 会被标记为健康。

| 故障类型 | `pi-failover` 的处理方式 |
| --- | --- |
| `401` / `403` | 将当前凭证在本次会话中标记为不可用，切换到下一把备用 key 或下一个 provider，然后重试同一次请求。 |
| `429` | 按 `Retry-After` 冷却当前凭证；如果没有该响应头，则冷却 60 秒，切换到下一把备用 key 后重试。 |
| `529` 或 overloaded 响应 | 按 `Retry-After` 冷却当前 provider；如果没有该响应头，则冷却 30 秒，切换 provider 后重试。 |
| `500`、`502`、`503`、`504`、网络错误、超时 | 将当前 provider 冷却 30 秒，切换 provider 后重试。 |
| 其他故障 | 保持 Pi 原有的错误处理逻辑，不额外接管。 |

发生 provider 切换时，`pi-failover` 会优先保留当前 model ID；如果目标 provider 没有该 model，则退回到该 provider 的第一个可用 model。扩展内部会调用 Pi 的 `setModel()`，因此新的默认 model 会持续生效；后续不会自动切回原 provider。

状态和警告信息只显示脱敏后的凭证槽位：主凭证为 `primary`，第一把备用凭证为 `backup`，后续依次为 `backup-2`、`backup-3`……

## 自定义 Provider

通过 Pi 的 `models.json` 定义或由 provider 扩展注册的自定义 provider，即使没有出现在 `auth.json` 中，也可以参与 provider 故障切换。扩展在会话启动及执行 `/failover reload` 时，从 Pi 模型注册表发现凭证已配置、具体聊天模型可用的 provider。`auth.json` 中的 provider 优先，发现的自定义 provider 按模型注册表顺序追加一次。如果需要明确控制顺序，将它们的凭证按所需顺序写入 `auth.json`。

例如，在 Pi 现有的 `~/.pi/agent/models.json` 中定义 OpenAI 兼容端点：

```json
{
  "providers": {
    "my-endpoint": {
      "baseUrl": "https://example.invalid/v1",
      "api": "openai-completions",
      "apiKey": "$CUSTOM_API_KEY",
      "models": [{ "id": "my-chat-model" }]
    }
  }
}
```

替换示例 URL 和模型名，并设置 `CUSTOM_API_KEY`。provider 的加载和认证由 Pi 完成；`pi-failover` 使用 Pi 的注册表，不自行读取其他配置文件。修改或注册 provider 后，先在 Pi 中刷新，再执行 `/failover reload`。

如果还需要**备用 key 切换**，在 `auth.json` 中使用完全相同的 provider ID，配置主凭证及有序备用凭证：

```json
{
  "my-endpoint": {
    "type": "api_key",
    "key": "$CUSTOM_API_KEY",
    "key-backup": ["backup-api-key-1", "backup-api-key-2"]
  }
}
```

没有备用 key 时，已接管的故障会直接切到其他已配置 provider。provider 需要有可用的具体聊天模型和有效认证，仅配置端点 URL 不够。仅使用运行时已配置的自定义 provider 时，允许 `auth.json` 不存在；文件格式错误或无法读取时仍禁用 failover。扩展不会创建或重写该文件。

## Pi 1.0 虚拟模型

选择 `router/auto` 等虚拟模型时，扩展根据 assistant 响应记录的实际 provider 和 model 归属故障。切换备用 key 时保留虚拟模型选择及其路由逻辑。如果重试时路由选择了其他 provider，故障会归属到该 provider 实际使用的凭证。

跨 provider 切换会通过 `setModel()` 选择具体模型，替换原来的虚拟模型选择。虚拟模型不会作为 provider 故障切换的候选，避免路由立即把续跑请求送回故障 provider。该具体模型选择会持续生效，直到手动修改。

Pi 的请求钩子不会在请求前暴露实际模型。因此，虚拟模型的凭证切换发生在实际请求失败之后；扩展无法阻止路由首次选择处于冷却中的 provider，也不会在冷却结束后自动恢复主 key。选择具体模型后会恢复每轮请求前的凭证选择；`/failover reload` 可恢复扩展接管的 override。

扩展处理主聊天 assistant 的故障。codemode 的分类器／图像请求及压缩请求没有独立的 failover 支持。未派发到具体模型的路由错误仍由 Pi 正常处理。

## 命令

- `/failover status`：查看脱敏后的故障切换状态
- `/failover reload`：恢复扩展接管的 override，然后重新读取 `auth.json`

## 输出模式

| 模式 | 通知行为 |
| --- | --- |
| TUI | 显示通知 |
| RPC | 显示通知 |
| JSON | 不显示 UI 通知，但仍会执行透明重试 |
| print | 不显示 UI 通知，但仍会执行透明重试 |

## 迁移说明

如果从 `~/.pi/keyrouter.json` 迁移，需要把每个 provider 的主凭证搬到 Pi 的 `auth.json` 中，再把一把备用 key 字符串或按顺序排列的备用 key 数组写入 `"key-backup"`。如需控制 provider 切换顺序，可直接调整 `auth.json` 顶层条目的顺序。

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
npm run audit
npm pack --dry-run
```

开发依赖及 runtime 集成测试使用 Pi 1.1.0，peer dependency 仍为 `>=0.84.2`；源码类型检查和核心回归测试也已在 Pi 0.84.2 下通过。

`npm run audit` 对官方 npm registry 检查仅用于开发的依赖树。发布包不携带任何运行时依赖。
