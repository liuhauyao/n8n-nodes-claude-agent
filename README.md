# n8n-nodes-claude-agent

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

Settings → Community Nodes → Install → `@liuhuayao/n8n-nodes-claude-agent`

### Host dependencies (`~/.n8n/nodes/package.json`)

Community nodes must not bundle the SDK. Install alongside the node package:

```json
{
  "dependencies": {
    "@liuhuayao/n8n-nodes-claude-agent": "1.0.30",
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
| Permission Preset | `customer_service` (default), `read_only`, `full_agent` (`world_assistant` legacy alias → `full_agent`) |
| Skills / MCP | Same patterns as n8n-nodes-cursor-agent |
| Session ID | Maps to Claude SDK `session_id` via Redis; locks model on first turn |

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
- Customer-service preset disables Bash/Write/Edit by default.

---

## License

MIT
