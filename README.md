# ai-ccode

A personal MCP bridge that connects Claude.ai web chat to a Claude Code CLI session running on this machine.

> **Personal tool** — this is not part of the shared ai-talent ecosystem. It belongs to Nicoandres and is not deployed to any shared infrastructure.

## What it does

Exposes two MCP tools to Claude.ai:

- **`run_claude_code(prompt, session_id?)`** — spawns `claude -p "<prompt>"` asynchronously and returns `{ job_id, status: "running" }` immediately
- **`check_status(job_id)`** — reads the result after the job finishes, returns `{ status, output, exit_code, session_id }`

This lets Claude.ai delegate code writing, git operations, and `gh` CLI work directly to Claude Code — without copy-pasting prompts.

## How it works

```
Claude.ai (browser)
    ↓  MCP tool call over HTTPS
nicoandres-ai.dev  ← Cloudflare (paid domain)
    ↓  Cloudflare Named Tunnel (free)
    ↓  TCP → localhost:8080
ai-ccode Express server  ← this repo, running locally
    ↓  child_process spawn
claude -p "<prompt>"  ← Claude Code CLI
    ↓  stdout captured async
check_status(job_id)  ← polled by Claude.ai after user pings
```

## Cloudflare setup

Two components make the stable HTTPS URL possible:

### Named Tunnel — free tier

A persistent Cloudflare tunnel forwards traffic from the edge to `localhost:8080`. Runs as a background process on the laptop.

```bash
# Install cloudflared
# https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

# Authenticate
cloudflared tunnel login

# The named tunnel (already created — nicoandresr-dev)
# Tunnel ID: 630b1f4f-2f5f-48dd-ac99-bdc7fc66f0a1

# Start the tunnel
cloudflared tunnel run nicoandresr-dev
```

### Custom domain — paid (`nicoandres-ai.dev`)

Routes `nicoandres-ai.dev` to the tunnel. Purchased via Cloudflare Registrar (~$10/year). Without it, the tunnel URL would be a random `*.trycloudflare.com` that changes on restart.

DNS record (set once in Cloudflare dashboard):
```
CNAME  nicoandres-ai.dev  →  630b1f4f-2f5f-48dd-ac99-bdc7fc66f0a1.cfargotunnel.com
```

The result: `https://nicoandres-ai.dev/mcp` is the stable MCP endpoint Claude.ai connects to.

## Local setup

```bash
# Prerequisites
# - Node.js (nvm use)
# - Claude Code CLI installed and authenticated (claude --version)
# - cloudflared installed and tunnel configured (see above)

npm install

# Start the server
npm start
# → Listening on :8080

# In a separate terminal, start the tunnel
cloudflared tunnel run nicoandresr-dev
# → Connection established

# Verify
curl http://localhost:8080/
# → {"ok":true}
```

## Connect to Claude.ai

In the Claude.ai project settings → MCP connector:

```
URL: https://nicoandres-ai.dev/mcp
```

Claude.ai will discover the `run_claude_code` and `check_status` tools automatically.

## Session management

Claude Code sessions persist across multiple `run_claude_code` calls via the `session_id` returned by `check_status`. Pass it to the next call to resume the same session — preserves working directory, tool context, and in-memory state.

## YubiKey note

Git push and SSH operations require a YubiKey touch. The SSH multiplexer is configured for 3-hour sessions — first touch caches credentials for all subsequent operations within the window.
