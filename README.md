# claude-code-mcp-server

A minimal local MCP server that bridges Claude.ai (web chat) to Claude Code CLI.

## What it does

Exposes a single MCP tool `run_claude_code` that executes any prompt via 
`claude -p` and returns the output — allowing Claude.ai to drive Claude Code 
locally without copy-pasting prompts.

## Setup

```bash
npm install
```

## Register in Claude.ai

Add this to your Claude.ai MCP settings (Settings → Connectors → Add custom):

```json
{
  "mcpServers": {
    "claude-code": {
      "command": "node",
      "args": ["/absolute/path/to/claude-code-mcp/index.mjs"]
    }
  }
}
```

Or via Claude Code's own MCP config:

```bash
claude mcp add claude-code node /absolute/path/to/claude-code-mcp/index.mjs
```

## Tool

### `run_claude_code(prompt: string) -> string`

Executes the prompt via `claude -p "<prompt>"` and returns stdout.

## Notes

- Uses stdio transport (correct for local MCP servers)
- Runs with `--dangerously-skip-permissions` for unattended execution
- Local only — do not deploy to GCP
- Claude Code must be installed and authenticated (`claude auth`)
