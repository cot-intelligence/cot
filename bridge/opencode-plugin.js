// cot OpenCode plugin (OpenCode 1.18.29+ and 2.x).
// Copy to ~/.config/opencode/plugins/cot.js; no opencode.json entry is needed.
import { spawn } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"

const bridge = join(homedir(), ".cot", "bin", "cot")
const seen = new Set()
const keyFor = (prefix, id) => id ? `${prefix}:${id}` : undefined

function once(key) {
  if (!key) return true
  if (seen.has(key)) return false
  if (seen.size > 10000) seen.clear()
  seen.add(key)
  return true
}

function timestamp(value) {
  if (typeof value === "number") return new Date(value).toISOString()
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString()
  return new Date().toISOString()
}

function send(sessionID, hook, fields = {}, key) {
  if (!sessionID || !once(key)) return Promise.resolve()
  const payload = {
    session_id: sessionID,
    hook_event_name: hook,
    origin: "hook",
    ...fields,
    timestamp: timestamp(fields.timestamp),
    ...(key ? { _dedup_key: `opencode:${key}` } : {}),
  }
  // The bridge persists events while the collector is down. Hook failures must
  // never break an OpenCode turn.
  return new Promise((resolve) => {
    let child
    let body
    try {
      body = JSON.stringify(payload, (_, value) => typeof value === "bigint" ? String(value) : value)
      child = spawn(bridge, ["hook", "opencode"], { stdio: ["pipe", "ignore", "ignore"] })
    } catch {
      resolve()
      return
    }
    child.on("error", resolve)
    child.on("close", resolve)
    child.stdin.on("error", () => {})
    child.stdin.end(body)
  })
}

function sessionStarted(info, directory) {
  const sid = info?.id || info?.sessionID
  return send(sid, "SessionStart", {
    cwd: info?.directory || info?.location?.directory || directory,
    parent_session_id: info?.parentID,
    session_title: info?.title,
  }, keyFor("session", sid))
}

function v1Event(event, directory) {
  const p = event.properties || {}
  if (event.type === "session.created") return sessionStarted(p.info, directory)
  if (event.type === "session.idle") return send(p.sessionID, "Stop", { cwd: directory })
  if (event.type === "session.compacted") return send(p.sessionID, "PostCompact", { cwd: directory })
  if (event.type === "permission.asked") {
    return send(p.sessionID, "PermissionRequest", {
      cwd: directory,
      tool_name: p.permission,
      permission: p,
    }, keyFor("permission", p.id))
  }
  if (event.type === "message.updated") {
    const info = p.info
    if (info?.role !== "assistant" || !info.time?.completed) return
    const t = info.tokens || {}
    return send(info.sessionID, "OpenCodeUsage", {
      cwd: directory,
      model: info.modelID,
      usage: {
        input_tokens: t.input || 0,
        output_tokens: t.output || 0,
        cache_read_tokens: t.cache?.read || 0,
        cache_write_tokens: t.cache?.write || 0,
      },
    }, keyFor("usage", info.id))
  }
  if (event.type !== "message.part.updated") return
  const part = p.part
  if (!part?.sessionID || !part.id) return
  if (part.type === "tool" && (part.state?.status === "completed" || part.state?.status === "error")) {
    const failed = part.state.status === "error"
    return send(part.sessionID, failed ? "PostToolUseFailure" : "PostToolUse", {
      cwd: directory,
      tool_name: part.tool,
      tool_input: part.state.input,
      tool_response: failed ? part.state.error : part.state.output,
      tool_use_id: part.callID,
    }, keyFor("tool:end", part.id))
  }
  if ((part.type === "text" || part.type === "reasoning") && part.time?.end && part.text?.trim()) {
    const response = part.type === "text"
    return send(part.sessionID, response ? "afterAgentResponse" : "afterAgentThought", {
      cwd: directory,
      [response ? "response" : "thought"]: part.text,
    }, keyFor("part", part.id))
  }
}

function v2Event(event, directory, stepModels) {
  const p = event.data || {}
  const sid = p.sessionID
  switch (event.type) {
    case "session.next.step.started":
      if (p.assistantMessageID && p.model) {
        stepModels.set(p.assistantMessageID, `${p.model.providerID}/${p.model.id}`)
      }
      return
    case "session.next.text.ended":
    case "session.next.reasoning.ended": {
      if (!p.text?.trim()) return
      const response = event.type === "session.next.text.ended"
      return send(sid, response ? "afterAgentResponse" : "afterAgentThought", {
        cwd: directory,
        timestamp: p.timestamp,
        [response ? "response" : "thought"]: p.text,
      }, keyFor("part", p.textID || p.reasoningID))
    }
    case "session.next.step.ended": {
      const t = p.tokens || {}
      const model = stepModels.get(p.assistantMessageID)
      stepModels.delete(p.assistantMessageID)
      const usage = send(sid, "OpenCodeUsage", {
        cwd: directory,
        timestamp: p.timestamp,
        model,
        usage: {
          input_tokens: t.input || 0,
          output_tokens: t.output || 0,
          cache_read_tokens: t.cache?.read || 0,
          cache_write_tokens: t.cache?.write || 0,
        },
      }, keyFor("usage", p.assistantMessageID))
      if (p.finish && p.finish !== "tool-calls") {
        return usage.then(() => send(sid, "Stop", { cwd: directory, timestamp: p.timestamp }, keyFor("stop", p.assistantMessageID)))
      }
      return usage
    }
    case "session.next.compaction.ended":
      return send(sid, "PostCompact", { cwd: directory, timestamp: p.timestamp }, `compact:${p.messageID}`)
  }
}

function v1Hooks({ directory }) {
  return {
    "chat.message": async (input, output) => {
      const prompt = (output.parts || [])
        .filter((part) => part.type === "text" && !part.synthetic)
        .map((part) => part.text)
        .join("\n")
      if (prompt) await send(input.sessionID, "UserPromptSubmit", {
        cwd: directory,
        prompt,
        model: input.model?.modelID,
      }, keyFor("prompt", input.messageID || output.message?.id))
    },
    "tool.execute.before": async (input, output) => {
      await send(input.sessionID, "PreToolUse", {
        cwd: directory,
        tool_name: input.tool,
        tool_input: output.args,
        tool_use_id: input.callID,
      }, keyFor("tool:start", input.callID))
    },
    event: async ({ event }) => { await v1Event(event, directory) },
  }
}

// OpenCode 1 calls server(); OpenCode 2 calls setup(). A plain definition
// keeps this file dependency-free for manual installation.
export default {
  id: "cot.observability",
  async server(ctx) { return v1Hooks(ctx) },
  async setup(ctx) {
    const directory = ctx.location.directory
    const knownSessions = new Map()
    const stepModels = new Map()
    const ensureSession = (sessionID, knownInfo) => {
      if (!sessionID) return Promise.resolve()
      if (knownSessions.has(sessionID)) return knownSessions.get(sessionID)
      const task = (async () => {
        let info = knownInfo
        if (!info) {
          try {
            info = await ctx.session.get({ sessionID })
          } catch {
            info = { id: sessionID }
          }
        }
        await sessionStarted(info, directory)
      })()
      knownSessions.set(sessionID, task)
      return task
    }
    await ctx.session.hook("prompt", async (event) => {
      await ensureSession(event.sessionID)
      if (event.prompt?.text) await send(event.sessionID, "UserPromptSubmit", {
        cwd: directory,
        prompt: event.prompt.text,
      }, keyFor("prompt", event.messageID))
    })
    await ctx.tool.hook("execute.before", async (event) => {
      await ensureSession(event.sessionID)
      await send(event.sessionID, "PreToolUse", {
        cwd: directory,
        tool_name: event.tool,
        tool_input: event.input,
        tool_use_id: event.callID,
      }, keyFor("tool:start", event.callID))
    })
    await ctx.tool.hook("execute.after", async (event) => {
      await ensureSession(event.sessionID)
      const failed = event.status === "error"
      await send(event.sessionID, failed ? "PostToolUseFailure" : "PostToolUse", {
        cwd: directory,
        tool_name: event.tool,
        tool_input: event.input,
        tool_response: failed ? event.error?.message : event.result,
        tool_use_id: event.callID,
      }, keyFor("tool:end", event.callID))
    })
    await ctx.permission.hook("evaluate", async (event) => {
      if (event.effect !== "ask") return
      await ensureSession(event.sessionID)
      await send(event.sessionID, "PermissionRequest", {
        cwd: directory,
        tool_name: event.action,
        permission: {
          action: event.action,
          resources: event.resources,
          metadata: event.metadata,
          message: event.message,
        },
      }, keyFor("permission", event.source?.id && `${event.source.id}:${event.action}:${event.resources.join(",")}`))
    })
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          await ensureSession(event.data?.sessionID || event.data?.info?.id, event.data?.info)
          await v2Event(event, directory, stepModels)
        }
      } catch {
        // OpenCode owns the event stream and may close it during reload.
      }
    })()
    return () => controller.abort()
  },
}
