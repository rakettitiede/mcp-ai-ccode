import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import express from "express";
import { randomUUID } from "node:crypto";

const PORT = 8090;
const app = express();
app.use(express.json());

function findSessionId(cwd) {
  try {
    const projectsDir = join(homedir(), ".claude", "projects");
    const cwdHash = cwd.replace(/\//g, "-");
    const projectDir = join(projectsDir, cwdHash);
    const files = readdirSync(projectDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({
        name: f,
        mtime: statSync(join(projectDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0) return null;
    return basename(files[0].name, ".jsonl");
  } catch {
    return null;
  }
}

function runClaudeCode(prompt, sessionId) {
  return new Promise((resolve, reject) => {
    console.log(`[claude] spawning with prompt: "${prompt.slice(0, 80)}..."`);
    const cwd = process.env.CLAUDE_CODE_CWD || process.cwd();
    console.log(`[claude] cwd: ${cwd}`);
    if (sessionId) console.log(`[claude] resuming session: ${sessionId}`);

    const args = sessionId
      ? ["--resume", sessionId, "-p", prompt, "--dangerously-skip-permissions"]
      : ["-p", prompt, "--dangerously-skip-permissions"];

    const proc = spawn("claude", args, {
      env: { ...process.env },
      cwd,
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
        const foundSessionId = findSessionId(cwd);
        resolve(JSON.stringify({ output: stdout.trim(), session_id: foundSessionId }));
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
          session_id: z.string().optional().describe("Resume a previous Claude Code session by ID. Omit for a fresh session."),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({ prompt, session_id }) => {
        console.log(`[tool] run_claude_code called`);
        const result = await runClaudeCode(prompt, session_id);
        console.log(`[tool] run_claude_code done, result length: ${result.length}`);
        return { content: [{ type: "text", text: result }] };
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
