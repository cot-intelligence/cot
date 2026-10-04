// cot OpenCode plugin (OpenCode 1.18.29+ and 2.x).
// Copy to ~/.config/opencode/plugins/cot.js; no opencode.json entry is needed.
import { spawn } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"

const bridge = join(homedir(), ".cot", "bin", "cot")
const keyFor = (prefix, id) => id ? `${prefix}:${id}` : undefined

function timestamp(value) {
  const date = new Date(typeof value === "number" || typeof value === "string" ? value : NaN)
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString()
}

function serialize(payload) {
  const ancestors = []
  return JSON.stringify(payload, function (_, value) {
    if (typeof value === "bigint") return String(value)
    if (!value || typeof value !== "object") return value
    while (ancestors.length && ancestors.at(-1) !== this) ancestors.pop()
    if (ancestors.includes(value)) return "[Circular]"
    ancestors.push(value)
    return value
  })
}

function createSender() {
  const seen = new Set(), pending = new Map()
  return function send(sessionID, hook, fields = {}, key) {
    if (!sessionID) return Promise.resolve(false)
    const scopedKey = key && `${sessionID}:${key}`
    if (scopedKey && seen.has(scopedKey)) return Promise.resolve(true)
    if (scopedKey && pending.has(scopedKey)) return pending.get(scopedKey)
    const task = new Promise((resolve) => {
      let child, timer, settled = false
      const finish = (ok, reason) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (ok && scopedKey) {
          seen.add(scopedKey)
          if (seen.size > 10000) seen.delete(seen.values().next().value)
        }
        if (!ok) console.error(`cot: OpenCode ${hook} delivery failed (${reason}); retry remains available`)
        resolve(ok)
      }
      try {
        const body = serialize({
          session_id: sessionID, hook_event_name: hook, origin: "hook", ...fields,
          timestamp: timestamp(fields.timestamp),
          ...(scopedKey ? { _dedup_key: `opencode:${scopedKey}` } : {}),
        })
        // OpenCode tears down its plugin worker at exit. A detached bridge
        // must finish persisting the event even if that worker is terminated.
        child = spawn(bridge, ["hook", "opencode"], { detached: true, stdio: ["pipe", "ignore", "ignore"] })
        child.on("error", (error) => finish(false, error.code || "spawn"))
        child.on("close", (code) => finish(code === 0, `exit ${code}`))
        child.stdin.on("error", () => {})
        child.stdin.end(body)
        // Longer than the bridge's individual three-second HTTP timeout.
        timer = setTimeout(() => { child.kill("SIGKILL"); finish(false, "timeout") }, 5000)
      } catch { finish(false, "serialization or spawn") }
    })
    if (scopedKey) {
      pending.set(scopedKey, task)
      void task.then(() => pending.delete(scopedKey))
    }
    return task
  }
}

function sessionStarted(send, info, directory) {
  const sid = info?.id || info?.sessionID
  return send(sid, "SessionStart", {
    cwd: info?.directory || info?.location?.directory || directory,
    parent_session_id: info?.parentID, session_title: info?.title,
  }, keyFor("session", sid))
}

function usageFields(tokens, model) {
  const t = tokens || {}
  return { model, usage: {
    input_tokens: t.input || 0, output_tokens: t.output || 0,
    cache_read_tokens: t.cache?.read || 0, cache_write_tokens: t.cache?.write || 0,
  } }
}

function modelName(model) {
  return model?.providerID && model?.id ? `${model.providerID}/${model.id}` : undefined
}

function toolFailed(tool, status, metadata) {
  return status === "error" || ((tool === "shell" || tool === "bash") &&
    typeof metadata?.exit === "number" && metadata.exit !== 0)
}

function v1Event(send, event, directory) {
  const p = event?.properties || {}
  if (event?.type === "session.created") return sessionStarted(send, p.info, directory)
  if (event?.type === "session.idle") return send(p.sessionID, "Stop", { cwd: directory })
  if (event?.type === "session.compacted") return send(p.sessionID, "PostCompact", { cwd: directory })
  if (event?.type === "permission.asked") return send(p.sessionID, "PermissionRequest", {
    cwd: directory, tool_name: p.permission, permission: p,
  }, keyFor("permission", p.id))
  if (event?.type === "message.updated") {
    const info = p.info
    if (info?.role !== "assistant" || !info.time?.completed) return
    return send(info.sessionID, "OpenCodeUsage", {
      cwd: directory, ...usageFields(info.tokens, info.modelID),
    }, keyFor("usage", info.id))
  }
  if (event?.type !== "message.part.updated") return
  const part = p.part
  if (!part?.sessionID || !part.id) return
  if (part.type === "tool" && (part.state?.status === "completed" || part.state?.status === "error")) {
    const failed = toolFailed(part.tool, part.state.status, part.state.metadata)
    return send(part.sessionID, failed ? "PostToolUseFailure" : "PostToolUse", {
      cwd: directory, tool_name: part.tool, tool_input: part.state.input,
      tool_response: part.state.error ?? part.state.output, tool_metadata: part.state.metadata, tool_use_id: part.callID,
    }, keyFor("tool:end", part.callID || part.id))
  }
  if ((part.type === "text" || part.type === "reasoning") && part.time?.end && typeof part.text === "string" && part.text.trim()) {
    const response = part.type === "text"
    return send(part.sessionID, response ? "afterAgentResponse" : "afterAgentThought", {
      cwd: directory, [response ? "response" : "thought"]: part.text,
    }, keyFor("part", part.id))
  }
}

async function v2Event(send, event, directory, stepModels) {
  const p = event.data || {}, sid = p.sessionID
  const type = event.type.replace("session.next.", "session.")
  const fields = { cwd: directory, timestamp: p.timestamp ?? event.created }
  const messageKey = p.assistantMessageID && `${sid}:${p.assistantMessageID}`
  switch (type) {
    case "session.step.started":
      if (messageKey) stepModels.set(messageKey, modelName(p.model))
      return
    case "session.text.ended":
    case "session.reasoning.ended": {
      if (typeof p.text !== "string" || !p.text.trim()) return
      const response = type === "session.text.ended"
      const partID = p.textID || p.reasoningID || (p.assistantMessageID && `${p.assistantMessageID}:${type}:${p.ordinal ?? 0}`) || event.id
      return send(sid, response ? "afterAgentResponse" : "afterAgentThought", {
        ...fields, [response ? "response" : "thought"]: p.text,
      }, keyFor("part", partID))
    }
    case "session.step.ended": {
      const model = stepModels.get(messageKey) || modelName(p.model)
      stepModels.delete(messageKey)
      await send(sid, "OpenCodeUsage", { ...fields, ...usageFields(p.tokens, model) }, keyFor("usage", p.assistantMessageID || event.id))
      // Older v2 builds used step finish as their terminal notification.
      if (event.type.startsWith("session.next.") && p.finish && p.finish !== "tool-calls") {
        await send(sid, "Stop", fields, keyFor("stop", p.assistantMessageID || event.id))
      }
      return
    }
    case "session.step.failed":
      stepModels.delete(messageKey)
      return
    case "session.compaction.ended":
      await send(sid, "PostCompact", { ...fields, summary: p.text }, keyFor("compact", event.id || p.messageID))
      if (p.tokens) await send(sid, "OpenCodeUsage", {
        ...fields, ...usageFields(p.tokens, modelName(p.model)),
      }, keyFor("usage:compact", event.id || p.messageID))
      return
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted":
      return send(sid, "Stop", {
        ...fields, ...(p.error ? { error: p.error } : {}),
        ...(type === "session.execution.interrupted" ? { interrupted: true, reason: p.reason } : {}),
      }, keyFor("execution", event.id))
    // usage.updated is cumulative. Counting it as well would double tokens.
  }
}

function v1Hooks({ directory }) {
  const send = createSender()
  return {
    "chat.message": async (input, output) => {
      const prompt = (Array.isArray(output.parts) ? output.parts : [])
        .filter((part) => part.type === "text" && !part.synthetic && typeof part.text === "string")
        .map((part) => part.text).join("\n")
      if (prompt) await send(input.sessionID, "UserPromptSubmit", {
        cwd: directory, prompt, model: input.model?.modelID,
      }, keyFor("prompt", input.messageID || output.message?.id))
    },
    "tool.execute.before": async (input, output) => {
      await send(input.sessionID, "PreToolUse", {
        cwd: directory, tool_name: input.tool, tool_input: output.args, tool_use_id: input.callID,
      }, keyFor("tool:start", input.callID))
    },
    event: async ({ event }) => { await v1Event(send, event, directory) },
  }
}

// OpenCode 1 calls server(); OpenCode 2 calls setup(). No SDK dependency.
export default {
  id: "cot.observability",
  async server(ctx) { return v1Hooks(ctx) },
  async setup(ctx) {
    const directory = ctx.location.directory
    const send = createSender()
    const knownSessions = new Map(), stepModels = new Map(), inFlight = new Set()
    const ensureSession = async (sessionID, knownInfo) => {
      if (!sessionID) return directory
      let task = knownSessions.get(sessionID)
      if (knownInfo || !task) {
        task = (async () => {
          if (knownInfo) return knownInfo
          try { return await ctx.session.get({ sessionID }) }
          catch { return { id: sessionID } }
        })()
        knownSessions.set(sessionID, task)
      }
      const info = await task
      await sessionStarted(send, { ...info, id: info?.id || sessionID }, directory)
      if (!info?.directory && !info?.location?.directory) knownSessions.delete(sessionID)
      return info?.directory || info?.location?.directory || directory
    }
    await ctx.session.hook("prompt", async (event) => {
      const cwd = await ensureSession(event.sessionID)
      if (typeof event.prompt?.text === "string" && event.prompt.text) await send(event.sessionID, "UserPromptSubmit", {
        cwd, prompt: event.prompt.text,
      }, keyFor("prompt", event.messageID))
    })
    await ctx.tool.hook("execute.before", async (event) => {
      const cwd = await ensureSession(event.sessionID)
      await send(event.sessionID, "PreToolUse", {
        cwd, tool_name: event.tool, tool_input: event.input, tool_use_id: event.callID,
      }, keyFor("tool:start", event.callID))
    })
    await ctx.tool.hook("execute.after", async (event) => {
      const cwd = await ensureSession(event.sessionID)
      const failed = toolFailed(event.tool, event.status, event.result?.metadata || event.result?.output)
      await send(event.sessionID, failed ? "PostToolUseFailure" : "PostToolUse", {
        cwd, tool_name: event.tool, tool_input: event.input,
        tool_response: event.error?.message || event.error || event.result, tool_use_id: event.callID,
      }, keyFor("tool:end", event.callID))
    })
    await ctx.permission.hook("evaluate", async (event) => {
      if (event.effect !== "ask") return
      const cwd = await ensureSession(event.sessionID)
      const resources = Array.isArray(event.resources) ? event.resources : []
      await send(event.sessionID, "PermissionRequest", {
        cwd, tool_name: event.action,
        permission: { action: event.action, resources, metadata: event.metadata, message: event.message },
      }, keyFor("permission", event.source?.id && `${event.source.id}:${event.action}:${resources.join(",")}`))
    })
    const controller = new AbortController()
    const handleEvent = async (event) => {
      try {
        if (!event || typeof event.type !== "string") return
        const p = event.data || {}
        const sessionID = p.sessionID || p.info?.id || (event.type === "session.created" ? p.id : undefined)
        if (!sessionID) return
        const cwd = await ensureSession(sessionID, p.info || (event.type === "session.created" ? p : undefined))
        await v2Event(send, { ...event, data: { ...p, sessionID } }, cwd, stepModels)
      } catch { console.error("cot: ignored malformed OpenCode event") }
    }
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          // Consume the stream promptly; bridge latency must not build a
          // subscriber backlog that loses terminal events at CLI shutdown.
          const task = handleEvent(event)
          inFlight.add(task)
          void task.then(() => inFlight.delete(task))
        }
      } catch {
        // OpenCode may close the subscription during reload or shutdown.
      }
    })()
    return async () => {
      // Let already-buffered events dispatch, then finish bounded deliveries.
      await new Promise((resolve) => setTimeout(resolve, 0))
      controller.abort()
      await Promise.allSettled([...inFlight])
      knownSessions.clear(); stepModels.clear()
    }
  },
}
