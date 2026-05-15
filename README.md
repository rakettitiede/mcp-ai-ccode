# ai-ccode

A minimal MCP bridge that connects any Claude interface to a Claude Code CLI session running on your local machine.

## What it does

Exposes two MCP tools:

- **`run_claude_code(prompt, session_id?)`** — spawns `claude -p "<prompt>"` asynchronously, returns `{ job_id, status: "running" }` immediately
- **`check_status(job_id)`** — reads the result once the job finishes, returns `{ status, output, exit_code, session_id }`

This lets Claude delegate code writing, git operations, and `gh` CLI work directly to Claude Code — without copy-pasting prompts.

## How it works

```
Claude (browser / CLI / desktop)
    ↓  MCP tool call over HTTPS
your-domain.com  ← public HTTPS endpoint (see Cloudflare setup below)
    ↓  Cloudflare Tunnel
    ↓  TCP → localhost:8080
ai-ccode Express server  ← this repo, running on your machine
    ↓  child_process spawn
claude -p "<prompt>"  ← Claude Code CLI
    ↓  stdout captured async
check_status(job_id)  ← polled after job finishes
```

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) for the tunnel

## Installation

```bash
git clone https://github.com/rakettitiede/ai-ccode.git
cd ai-ccode
npm install
npm start
# → Listening on :8080
```

## Exposing via Cloudflare Tunnel

The MCP endpoint must be reachable over HTTPS. Cloudflare Tunnel handles this without opening firewall ports.

### Option A — Free tier (random URL)

```bash
cloudflared tunnel --url http://localhost:8080
# → https://random-name.trycloudflare.com
```

The URL changes every time you restart the tunnel. Use this for testing.

### Option B — Named tunnel with custom domain (stable URL)

A stable URL requires a Cloudflare account and a registered domain (can be purchased via [Cloudflare Registrar](https://www.cloudflare.com/products/registrar/) for ~$10/year).

```bash
# Authenticate
cloudflared tunnel login

# Create a named tunnel
cloudflared tunnel create my-bridge

# Route your domain to the tunnel
cloudflared tunnel route dns my-bridge mcp.your-domain.com

# Start the tunnel
cloudflared tunnel run my-bridge
```

The tunnel URL (`https://mcp.your-domain.com`) stays stable across restarts. Use this for production use.

## Connect to Claude

In your Claude project settings → MCP connector:

```
URL: https://your-tunnel-url/mcp
```

Claude will discover the `run_claude_code` and `check_status` tools automatically.

## Session management

Claude Code sessions persist across multiple `run_claude_code` calls via the `session_id` returned by `check_status`. Pass it to the next call to resume the same session — preserves working directory, in-memory state, and tool context.

```
# First call
run_claude_code("git status") → { job_id: "abc...", status: "running" }
check_status("abc...") → { status: "done", session_id: "xyz..." }

# Resume same session
run_claude_code("git add -A && git commit -m 'fix'", session_id: "xyz...")
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | Port for the Express server |

## YubiKey / SSH note

Git push and SSH operations require hardware key authentication if configured. With SSH multiplexing, a single touch caches credentials for the session duration — subsequent operations within the window don't re-prompt.

## License

Apache 2.0 — see [LICENSE](LICENSE).
