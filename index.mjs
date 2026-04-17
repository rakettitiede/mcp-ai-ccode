import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import express from "express";
import { randomUUID } from "node:crypto";

const PORT = 8090;
const app = express();
app.use(express.json());

function runClaudeCode(prompt) {
  return new Promise((resolve, reject) => {
    console.log(`[claude] spawning with prompt: "${prompt.slice(0, 80)}..."`);
    console.log(`[claude] cwd: ${process.env.CLAUDE_CODE_CWD || process.cwd()}`);

    const proc = spawn("claude", ["-p", prompt, "--dangerously-skip-permissions"], {
      env: { ...process.env },
      cwd: process.env.CLAUDE_CODE_CWD || process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      console.log(`[claude] stdout chunk: ${chunk.toString().slice(0, 100)}`);
      stdout += chunk;
    });

    proc.stderr.on("data", (chunk) => {
      console.log(`[claude] stderr: ${chunk.toString().slice(0, 100)}`);
      stderr += chunk;
    });

    proc.on("close", (code) => {
      console.log(`[claude] process closed with code: ${code}`);
      if (code !== 0) {
        reject(new Error(`claude exited with code ${code}: ${stderr}`));
      } else {
        resolve(stdout.trim());
      }
    });

    proc.on("error", (err) => {
      console.error(`[claude] spawn error:`, err);
      reject(err);
    });
  });
}

// One MCP server instance per session
const sessions = {};

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  console.log(`[mcp] POST /mcp sessionId=${sessionId || "none"} method=${req.body?.method}`);

  try {
    if (sessionId && !sessions[sessionId]) {
      console.log(`[mcp] unknown session ${sessionId} — returning 404 to force re-init`);
      res.status(404).json({ error: "Session not found" });
      return;
    }

    if (sessionId && sessions[sessionId]) {
      console.log(`[mcp] reusing session ${sessionId}`);
      await sessions[sessionId].transport.handleRequest(req, res, req.body);
      return;
    }

    console.log(`[mcp] creating new session`);
    const newSessionId = randomUUID();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => newSessionId,
    });

    const mcpServer = new McpServer({
      name: "claude-code-mcp-server",
      version: "1.0.0",
    });

    mcpServer.registerTool(
      "run_claude_code",
      {
        title: "Run Claude Code",
        description:
          "Execute a prompt via Claude Code CLI (claude -p) and return the output. " +
          "Use this to run gh CLI commands, read files, or perform any dev task locally.",
        inputSchema: {
          prompt: z.string().describe("The prompt to send to Claude Code"),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({ prompt }) => {
        console.log(`[tool] run_claude_code called`);
        const output = await runClaudeCode(prompt);
        console.log(`[tool] run_claude_code done, output length: ${output.length}`);
        return { content: [{ type: "text", text: output }] };
      }
    );

    sessions[newSessionId] = { transport };
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp] error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: String(err?.message || err) },
        id: null,
      });
    }
  }
});

// Health check
app.get("/", (req, res) => {
  res.json({ ok: true, service: "claude-code-mcp-server", version: "1.0.0" });
});

app.listen(PORT, () => {
  console.log(`🚀 claude-code-mcp-server running on http://localhost:${PORT}`);
  console.log(`📡 MCP endpoint: POST /mcp`);
  console.log(`🏥 Health check: GET /`);
});
