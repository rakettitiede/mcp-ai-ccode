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
const shortId = (id) => `[${id.slice(-8)}]`;
const jobStatus = new Map(); // job_id -> { status, output?, error?, exit_code?, session_id?, startedAt }
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
  const jobId = randomUUID();
  const cwd = process.env.CLAUDE_CODE_CWD || process.cwd();

  console.log(`🚀 ${shortId(jobId)} spawn cwd=${cwd}`);
  console.log(`🚀 ${shortId(jobId)} spawn prompt="${prompt.slice(0, 80)}..."`);
  if (sessionId) console.log(`🚀 ${shortId(jobId)} resuming session=${sessionId}`);

  const args = sessionId
    ? ["--resume", sessionId, "-p", prompt, "--dangerously-skip-permissions"]
    : ["-p", prompt, "--dangerously-skip-permissions"];

  jobStatus.set(jobId, { status: "running", startedAt: Date.now() });

  const proc = spawn("claude", args, {
    env: { ...process.env },
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  proc.stdout.on("data", (chunk) => {
    stdout += chunk;
  });

  proc.stderr.on("data", (chunk) => {
    console.log(`⚠️ ${shortId(jobId)} stderr: ${chunk.toString().slice(0, 100)}`);
    stderr += chunk;
  });

  proc.on("close", (code) => {
    const prev = jobStatus.get(jobId) || {};
    const foundSessionId = findSessionId(cwd);
    if (code === 0) {
      console.log(`🟢 ${shortId(jobId)} done — session=${foundSessionId ?? "unknown"}`);
      fetch('https://ntfy.sh/ai-ccode-teatteri-kevat-sampo', {
        method: 'POST',
        body: `🟢 [${shortId(jobId)}] done`
      }).catch(() => {});
      jobStatus.set(jobId, {
        ...prev,
        status: "done",
        output: stdout.trim(),
        exit_code: code,
        session_id: foundSessionId,
      });
    } else {
      console.log(`🔴 ${shortId(jobId)} failed (exit ${code}) — session=${foundSessionId ?? "unknown"}`);
      jobStatus.set(jobId, {
        ...prev,
        status: "failed",
        error: stderr.trim() || `exit code ${code}`,
        exit_code: code,
        session_id: foundSessionId,
      });
    }
  });

  proc.on("error", (err) => {
    console.error(`🔴 ${shortId(jobId)} spawn error: ${err?.message || err}`);
    const prev = jobStatus.get(jobId) || {};
    jobStatus.set(jobId, {
      ...prev,
      status: "failed",
      error: String(err?.message || err),
      exit_code: -1,
    });
  });

  return { job_id: jobId, status: "running" };
}

function checkStatus(jobId) {
  const entry = jobStatus.get(jobId);
  if (!entry) return { job_id: jobId, status: "unknown" };
  return { job_id: jobId, ...entry };
}

// One MCP server instance per session
const mcpSessions = {};

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  try {
    if (sessionId && !mcpSessions[sessionId]) {
      console.log(`[mcp] unknown session ${sessionId} — returning 404 to force re-init`);
      res.status(404).json({ error: "Session not found" });
      return;
    }

    if (sessionId && mcpSessions[sessionId]) {
      await mcpSessions[sessionId].transport.handleRequest(req, res, req.body);
      return;
    }

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
          "Execute a prompt via Claude Code CLI (claude -p) asynchronously. " +
          "Returns { job_id, status: 'running' } immediately. Use check_status(job_id) to poll for completion and retrieve output. " +
          "The session_id parameter (optional) resumes a prior Claude Code session — obtain session_id from a previous check_status result when its status is 'done'.",
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
        const result = runClaudeCode(prompt, session_id);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
    );

    mcpServer.registerTool(
      "check_status",
      {
        title: "Check Claude Code Job Status",
        description:
          "Check the status of a Claude Code job by job_id (returned from run_claude_code). " +
          "Returns { status: 'running'|'done'|'failed'|'unknown', output?, error?, exit_code?, session_id? }. " +
          "When status is 'done', session_id contains the Claude Code session id for resuming via run_claude_code.",
        inputSchema: {
          job_id: z.string().describe("The job_id returned by run_claude_code"),
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ job_id }) => {
        const result = checkStatus(job_id);
        console.log(`🔎 ${shortId(job_id)} status=${result.status}${result.session_id ? ` (session=${result.session_id})` : ""}`);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
    );

    mcpSessions[newSessionId] = { transport };
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
app.get("/", (_, res) => {
  res.json({ ok: true, service: "claude-code-mcp-server", version: "1.0.0" });
});

app.listen(PORT, () => {
  console.log(`🚀 claude-code-mcp-server running on http://localhost:${PORT}`);
  console.log(`📡 MCP endpoint: POST /mcp`);
  console.log(`🏥 Health check: GET /`);
});
// @@mcp-ai-ccode/index.mjs
