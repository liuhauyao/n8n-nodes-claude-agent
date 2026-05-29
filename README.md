# n8n-nodes-claude-sdk-agent

n8n community nodes for **Claude Code** via the official [`@anthropic-ai/claude-agent-sdk`](https://code.claude.com/docs/en/agent-sdk/overview).

Includes:

| Resource | Name | Role |
|----------|------|------|
| Credential | **Claude Provider** | Official API, gateway, Bedrock, Vertex, Foundry, AWS Platform |
| Node | **Claude Model Selector** | Rules-based profile routing → `claudeModelConfig` on Main output |
| Node | **Claude Agent** | Run agent with MCP, skills, Redis sessions, `__claude__` streaming |

---

## Requirements

| Item | Notes |
|------|-------|
| Node.js | `>= 22.16` |
| n8n | Self-hosted (not n8n Cloud) |
| Redis | Required on Claude Agent node (session + model lock) |
| Host SDK | Install in `~/.n8n/nodes` (see below) |

---

## Install

### n8n UI

Settings → Community Nodes → Install → `n8n-nodes-claude-sdk-agent`

### Host dependencies (`~/.n8n/nodes/package.json`)

Community nodes must not bundle the SDK. Install alongside the node package:

```json
{
  "dependencies": {
    "n8n-nodes-claude-sdk-agent": "1.0.0",
    "@anthropic-ai/claude-agent-sdk": "0.3.150"
  },
  "optionalDependencies": {
    "@anthropic-ai/claude-agent-sdk-linux-x64": "0.3.150",
    "@anthropic-ai/claude-agent-sdk-linux-arm64": "0.3.150"
  }
}
```

Run `npm install` in `~/.n8n/nodes`, then restart n8n.

---

## Workflow topology

```
Webhook / Chat Trigger
        ↓
Claude Model Selector   ← each Profile binds a Claude Provider credential
        ↓  (json.claudeModelConfig)
Claude Agent            ← modelConfigSource: From Previous Node
        ↓
Response / SSE
```

### Model Selector rules (Matrees example)

| Rule | Condition | Profile |
|------|-----------|---------|
| 1 | `$json.inferenceModelProvider` equals `deepseek` | 2 (LiteLLM gateway credential) |
| 2 | `$json.inferenceModelProvider` equals `anthropic` | 1 (official credential) |
| Default | — | Profile 1 |

---

## Claude Provider credential

Single credential type with **Provider Type** switching:

- **Anthropic Direct** — `ANTHROPIC_API_KEY`, dynamic `/v1/models`
- **Anthropic Gateway** — `ANTHROPIC_BASE_URL` + key (LiteLLM / compatible proxy)
- **Bedrock / Vertex / Foundry / AWS Platform** — env vars per [Claude Code docs](https://code.claude.com/docs/en/env-vars)

Use **Custom Model ID** when the gateway does not expose `/v1/models`.

---

## Claude Agent node

| Parameter | Description |
|-----------|-------------|
| Model Config Source | `fromSelector` / `fromCredential` / `fromInput` |
| Permission Preset | Description |
|-------------------|-------------|
| **`mcp_skills_only`** | **灵感助手推荐。** 内置工具经 `disallowedTools` + `dontAsk` **拒绝执行**，但流式 UI 仍展示 tool 调用；MCP + skills 可用。自动 `strictMcpConfig`。 |
| **`plan_only`** | **平台客服推荐。** 全部内置工具拒绝执行（`dontAsk`），流式 UI 仍可见被拒绝的调用；工作流侧不配 MCP。 |
| `customer_service` | Legacy: Read/Grep/Glob/Web + MCP; still allows local file reads. |
| `read_only` | Legacy: Read/Grep/Glob + MCP. |
| `full_agent` | Full Claude Code tools (`world_assistant` legacy alias → `full_agent`). |

### Permission preset matrix

| Preset | Built-in tools | MCP | Skills | UI 展示 tool 调用 |
|--------|----------------|-----|--------|-------------------|
| `mcp_skills_only` | 拒绝执行 | 是 | 是 | 是（含 MCP 与被拒内置工具） |
| `plan_only` | 拒绝执行 | 否（工作流不配） | 是 | 是（仅被拒调用） |
| `customer_service` | Read/Grep/… | Yes | Yes | Legacy |
| `read_only` | Read/Grep/Glob | Yes | Yes | Legacy |
| `full_agent` | All | Yes | Yes | Internal dev |

**Workspace guidance:** For `mcp_skills_only` / `plan_only`, set **Skills Root** to the skills directory only; do **not** mount source repos (`matrees-backend`, etc.) in Working Directories.

Streaming uses `__claude__` JSON chunks (aligned with Matrees `useClaudeStreamParser`).

---

## Local POC

```bash
npm install
ANTHROPIC_API_KEY=... POC_CWD=/path/to/project npm run poc
```

---

## Security

- API keys live only in **Claude Provider** credentials.
- `claudeModelConfig.sdkEnv` contains secrets during execution — do not log full items in production.
- Use **`mcp_skills_only`** for production AI workflows that must not read or modify local code; use **`plan_only`** when MCP should also be disabled.
- Legacy `customer_service` preset still allows Read/Grep against the workspace — prefer `mcp_skills_only` or `plan_only`.

---

## License

MIT
