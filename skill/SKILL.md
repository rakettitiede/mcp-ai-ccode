---
name: ccode
version: 1.0.0
description: Workflow rules and discipline for using the ccode (Claude Code) MCP bridge — run_claude_code and check_status tools. Use whenever about to call a ccode tool, when reporting on a finished ccode job, or when planning multi-step work that will involve ccode. Covers what the bridge is, the fire-and-forget async contract, the no-polling rule, job_id reporting convention, session_id resume, YubiKey/git ops discipline, preflight convention, optimistic programming inside ccode prompts, and fade-out recovery.
---

# Claude Code (ccode) bridge

## What is ai-ccode?

ai-ccode is a personal MCP bridge that connects a Claude interface (web, CLI, or desktop) to a Claude Code CLI session running on the bridge operator's local machine. It is not part of the shared ai-talent ecosystem — it is a personal productivity tool set up by whoever runs it.

The bridge exposes two MCP tools to Claude:
- **`run_claude_code(prompt, session_id?)`** — spawns `claude -p "<prompt>"` asynchronously on the operator's machine, returns `{ job_id, status: "running" }` immediately
- **`check_status(job_id)`** — reads the result once the job finishes, returns `{ status, output, exit_code, session_id }`

This allows Claude to delegate code writing, git operations, and `gh` CLI work directly to Claude Code — without copy-pasting prompts.

### How the connection works

```
Claude (browser / CLI / desktop)
    ↓  MCP tool call over HTTPS
your-domain.com  ← public HTTPS endpoint (Cloudflare, paid or free)
    ↓  Cloudflare Tunnel (free tier)
    ↓  TCP → localhost:8080
ai-ccode Express server  ← running on the operator's machine
    ↓  child_process spawn
claude -p "<prompt>"  ← Claude Code CLI
    ↓  stdout captured async
check_status(job_id)  ← polled after the operator signals completion
```

### Cloudflare setup

Two options for the HTTPS endpoint:

**Free** — `cloudflared tunnel --url http://localhost:8080` gives a random `*.trycloudflare.com` URL. Changes on restart. Fine for testing.

**Paid** — A named tunnel + custom domain (e.g. purchased via Cloudflare Registrar, ~$10/year) gives a stable URL that survives restarts. Use this for daily work.

See the [ai-ccode README](https://github.com/rakettitiede/ai-ccode) for full setup instructions.

---

## Async contract — fire and STOP

`run_claude_code` is fire-and-forget. It returns `{ job_id, status: "running" }` immediately, before the work starts.

After firing: **STOP**. Do not poll. Do not call `check_status` preemptively. Do not "just check once to be sure." The bridge operator watches the Claude Code terminal side-by-side — they ping when the job has finished. **Only then** call `check_status(job_id)` once to read the result.

This is the rule that's hardest to internalize because polling feels helpful. It isn't — it burns tool calls and clutters the chat. The terminal is the source of truth for "is it done"; the bridge operator is the messenger.

## Reporting job_ids

The ccode terminal shows only the **last 6 hex characters** of the job_id. When reporting in chat, always use those last 6 chars so the operator can match what they see in their terminal.

Examples:
- `a955e63c-da32-4c29-adb9-069c22e307ad` → `e307ad`
- `855fb4d1-f5f2-4dba-8dc6-21e68e9ca08a` → `9ca08a`

## Sessions: job_id vs session_id

- **`job_id`** — ai-ccode UUID, one per `run_claude_code` spawn. Used only by `check_status`.
- **`session_id`** — Claude Code's real session id, returned in `check_status` when `status === "done"`. Pass this to the next `run_claude_code` to resume the same Claude Code session — preserves repo-layout context, tool definitions, and in-memory state.

Resume sessions when the next call is in the same repo or builds on the previous step. Start fresh when crossing repos or topics.

## Incremental > monolithic

With `session_id`, prefer many small calls over one giant call. Each step within a session is cheap and easier to recover from. Big monolithic prompts are brittle.

Exception: deterministically chained steps (branch → edit → commit → push → PR) go in one prompt — they're one logical unit.

## Optimistic programming inside ccode prompts

Tell Claude Code to:
- skip defensive checks (no `git status` reads, no branch verification, no file existence checks) when preflight has been confirmed
- not add try/catch
- not run smoke tests / boot dev servers / write tests unless that's the explicit task
- never read files "to be safe" — only when `str_replace` needs uniqueness verification

## Preflight convention

Before any repo task, confirm a brief preflight. The operator checks their machine; Claude does not need to recite the conditions. A short "preflight ok?" is fine — skip entirely when context is obvious.

Conditions the operator checks:
- on the right branch (usually `main`) with clean working tree
- branch up-to-date with origin
- project knowledge matches the repo state

When confirmed: include "preflight confirmed, skip defensive checks, optimistic programming" in the ccode prompt.

## Git ops discipline

YubiKey touches are required for `git push` and SSH operations. The SSH multiplexer is configured for 3 hours — first touch caches credentials; subsequent ops within the window don't re-prompt.

Rules:
1. **Always branch before committing.** Never commit to `main`.
2. **`git push` and `gh pr create` go in the same ccode call.** They are one logical unit.
3. **On aborted calls, verify file state before re-firing.** Partial work may have happened.

## PR bodies need the triage block

Repos with auto-triage require the `<!--triage-start-->` / `<!--triage-end-->` block in every PR body passed via `--body` or `--body-file`. Without it, Priority/Size/Label stay empty on the project board. See the `ai-talent-triage` skill.

## Verify via project_knowledge_search before asserting

Before telling Claude Code "the file looks like X", search project knowledge to verify. Memory is fallible; `project_knowledge_search` is the cheap accurate source for repo state.

## Fade-out recovery

**Visible fade-out**: tool call returns an error or times out. Obvious.

**Silent fade-out**: the entire previous response evaporated from Claude's context. The tell is the operator reporting a job_id Claude doesn't recognize. If they report one that doesn't match visible history — that's a fade-out, not user error. Claude DID fire it.

In both cases the Claude Code session persisted. Don't re-fire the whole task — that risks duplicate work or branch conflicts.

Steps:
1. Trust the operator's job_id. Don't argue.
2. Ask for the full UUID if needed, then `check_status`.
3. If partial: re-fire only the missing steps with the same `session_id`.

## Quick reference

| Action | Convention |
|--------|------------|
| Start work | `run_claude_code(prompt)` → job_id, then STOP |
| Resume session | `run_claude_code(prompt, session_id)` |
| Read result | `check_status(job_id)` ONCE after operator pings |
| Report a job | last 6 hex chars of job_id |
| Before any repo task | ask "preflight ok?" or skip if obvious |
| In every ccode prompt | optimistic programming, no defensive reads |
| PR body via ccode | include triage block (where applicable) |
