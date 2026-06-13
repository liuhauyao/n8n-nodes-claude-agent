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
| Redis | Required on Claude Agent node (session persistence + Sidecar live metadata) |
| Host SDK | Install in `~/.n8n/nodes` (see below) |

---

## Install

### n8n UI

Settings → Community Nodes → Install → `n8n-nodes-claude-sdk-agent`

### Host dependencies (`~/.n8n/nodes/package.json`)

Community nodes must not bundle the SDK. Install alongside the node package in `~/.n8n/nodes` (versions should match; check this package README or npm page for the recommended SDK release):

```json
{
  "dependencies": {
    "n8n-nodes-claude-sdk-agent": "<version from n8n UI>",
    "@anthropic-ai/claude-agent-sdk": "<recommended SDK version>"
  },
  "optionalDependencies": {
    "@anthropic-ai/claude-agent-sdk-linux-x64": "<same as SDK>",
    "@anthropic-ai/claude-agent-sdk-linux-arm64": "<same as SDK>"
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

### Model Selector rules (example)

| Rule | Condition | Profile |
|------|-----------|---------|
| 1 | `$json.inferenceModelProvider` equals `deepseek` | 2 (LiteLLM gateway credential) |
| 2 | `$json.inferenceModelProvider` equals `anthropic` | 1 (official credential) |
| Default | — | Profile 1 |

---

## Claude Provider credential

Single credential type with **Provider Type** switching:

- **Anthropic Direct** — `ANTHROPIC_API_KEY`, dynamic `/v1/models`
- **Anthropic Gateway** — `ANTHROPIC_BASE_URL` + key (LiteLLM / Anthropic-compatible proxy)
- **OpenAI Compatible Gateway** — Upstream with only OpenAI Chat Completions; built-in `anthropic-openai-shim` handles protocol translation (no LiteLLM required)
- **Bedrock / Vertex / Foundry / AWS Platform** — env vars per [Claude Code docs](https://code.claude.com/docs/en/env-vars)

Use **Custom Model ID** when the gateway does not expose `/v1/models`.

### OpenAI Compatible Gateway

Claude Agent SDK sends Anthropic `/v1/messages`; many self-hosted or third-party gateways only accept OpenAI `/v1/chat/completions`. This package includes a lightweight shim — no LiteLLM needed.

**1. Start the shim on the same host as n8n (one-time setup, recommend pm2):**

```bash
# After installing the package under ~/.n8n/nodes:
node ~/.n8n/nodes/node_modules/n8n-nodes-claude-sdk-agent/scripts/anthropic-openai-shim.mjs

# Or from the dev directory: npm run shim
# Default: http://127.0.0.1:18789
```

pm2 example:

```javascript
{
  name: 'claude-anthropic-openai-shim',
  script: 'scripts/anthropic-openai-shim.mjs',
  cwd: '/home/<user>/.n8n/nodes/node_modules/n8n-nodes-claude-sdk-agent',
  env: { CLAUDE_AGENT_SHIM_HOST: '127.0.0.1', CLAUDE_AGENT_SHIM_PORT: '18789' }
}
```

**2. Configure the Claude Provider credential:**

| Field | Example |
|-------|---------|
| Provider Type | **OpenAI Compatible Gateway** |
| Upstream Base URL | `https://your-openai-gateway.example.com/v1` |
| Shim Base URL | `http://127.0.0.1:18789` (default) |
| API Key or Auth Token | Your upstream API key (Bearer) |
| Default / Custom Model | The model ID your gateway exposes |

Credential test: ① probes upstream `GET /models`; ② sends a test message via shim `POST /v1/messages`. Both must pass.

---

## Claude Agent node

| Parameter | Description |
|-----------|-------------|
| Model Config Source | `fromSelector` / `fromCredential` / `fromInput` |

### Session continuation (1.6.0+)

Multi-turn context uses the Claude SDK session transcript on disk (`~/.claude/projects/...`). Redis stores `{ claudeSessionId, modelConfig }` only.

| Change | Sidecar runtime | Stateless runtime |
|--------|-----------------|-------------------|
| Same model + profile | `streamInput` + resume | `resume` |
| Model only (same profile) | `setModel()` + `streamInput` | `resume` + `forkSession` + new `model` |
| Profile / provider change | close → fork bridge → new streaming | `resume` + `forkSession` + new `env` |
| New session | cold streaming `query` | new `query` |

**Options → Session → Session Runtime**

| Value | Behavior |
|-------|----------|
| **Sidecar (Recommended)** | Long-lived `claude-agent-sidecar` on localhost; supports `setModel()` without losing context |
| **Stateless (Fallback)** | Cold `query()` per n8n execution; Sidecar unreachable → auto `stateless-fallback` once |

Output debug fields: `sessionContinuation` (`new` / `resume` / `fork` / `setModel`), `sessionRuntime` (`sidecar` / `stateless` / `stateless-fallback`), `previousClaudeSessionId` (when forked).

### Agent Sidecar deployment

See `services/claude-agent-sidecar/ecosystem.config.cjs`. Default listen: `127.0.0.1:18790` (localhost only).

```bash
cd ~/.n8n/nodes && npm install n8n-nodes-claude-sdk-agent
cd node_modules/n8n-nodes-claude-sdk-agent
npm run build:sidecar
pm2 start services/claude-agent-sidecar/ecosystem.config.cjs --name claude-agent-sidecar
pm2 restart n8n
```

Sidecar `.env` (same Redis as Claude Agent node): `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, optional `SIDECAR_IDLE_TIMEOUT_MS` (default 30min), `SIDECAR_MAX_SESSIONS` (default 64).

In n8n: **Claude Agent → Options → Session → Session Runtime = Sidecar**, Sidecar URL = `http://127.0.0.1:18790`.

POC scripts:

```bash
npm run test:session          # continuation matrix
npm run poc:resume-fork       # Phase A (needs ANTHROPIC_API_KEY)
npm run sidecar               # start sidecar (terminal 1)
npm run poc:sidecar           # Phase B client (terminal 2)
```

### Permission presets

| Preset | Description |
|--------|-------------|
| **`mcp_skills_only`** | Built-in tools denied via `disallowedTools` + `dontAsk`. MCP tools auto-approved with `allowedTools: mcp__{server}__*` when using Deny/No Filter mode. Requires `strictMcpConfig`. Use for workflows that rely on MCP and skills only, with no local code access. |
| **`plan_only`** | All built-in tools denied (`dontAsk`); streaming UI still shows rejected calls. No MCP on the workflow side. Use for pure text-planning agents. |
| `customer_service` | **Read/Grep/Glob + Skills** — registers `claude_code` toolset, blocks Write/Bash/Web. Use for Q&A agents that need to analyze a local codebase alongside skills. |
| `read_only` | Alias for `customer_service`. |
| `full_agent` | Full Claude Code tools (`world_assistant` legacy alias → `full_agent`). Use only in trusted, sandboxed environments. |

### Permission preset matrix

| Preset | Built-in tools | MCP | Skills | Streaming tool events |
|--------|----------------|-----|--------|-----------------------|
| `mcp_skills_only` | Denied | Yes | Yes | Yes (MCP + denied built-ins) |
| `plan_only` | Denied | No (workflow side) | Yes | Yes (denied calls only) |
| `customer_service` | Read/Grep/Glob | Optional | Yes | Yes |
| `read_only` | Read/Grep/Glob | Optional | Yes | Yes |
| `full_agent` | All | Yes | Yes | Yes |

**Workspace guidance:** For `mcp_skills_only` / `plan_only`, set **Skills Root** to the skills directory only; do **not** mount source code repositories in Working Directories — these presets block file-read tools.

### MCP Tool Filter (Options → MCP)

| Filter Mode | Behavior |
|-------------|----------|
| **No Filter** (default) | All tools from MCP `tools/list` remain available. |
| **Deny List** | Deny listed bare tool names on every configured MCP server (Claude: `disallowedTools` as `mcp__{server}__{tool}`). With `mcp_skills_only`, also pre-approves `mcp__{server}__*`. |
| **Allow List** | Allow listed tools only (no server wildcard); optionally fill **Tool Catalog** to deny everything else. |

**Claude vs Cursor (MCP permissions)**

| Step | Cursor Agent | Claude Agent (`mcp_skills_only`) |
|------|--------------|----------------------------------|
| Local Read/Shell | `.cursor/cli.json` deny | `disallowedTools` + `dontAsk` |
| MCP default approval | Deny mode writes `Mcp(server:*)` to `cli.json` | ≥1.3.9: writes `mcp__server__*` to `allowedTools` |
| Without pre-approval | CLI rejects | `dontAsk` → silently rejected (appears as "MCP unavailable") |

Official: [MCP permissions](https://code.claude.com/docs/en/agent-sdk/mcp) — MCP requires `allowedTools`; `acceptEdits` does **not** auto-approve MCP.

Streaming output uses `__claude__` JSON chunks.

### Output fields

| Field | Description |
|-------|-------------|
| `output` | Full response body: Markdown (including `<next>` blocks) + `<claude_meta>` (toolCalls / timeline / suggestions) |
| `textOutput` | Plain Markdown only (no `<next>`, no `<claude_meta>`); suitable for passing directly to downstream nodes |
| `claudeSessionId` | Claude SDK session id |
| `sessionContinuation` | `new` / `resume` / `fork` / `setModel` — how this turn continued the SDK session |
| `sessionRuntime` | `sidecar` / `stateless` / `stateless-fallback` |
| `previousClaudeSessionId` | Source session when `sessionContinuation=fork` |
| `usage` / `costUsd` | Token counts and cost (when available) |

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
- `customer_service` / `read_only` allow Read/Grep/Glob against mounted Working Directories — only mount directories the agent is authorized to access.

---

## License

MIT
