import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, chmod, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cot-opencode-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bridge = join(root, 'cot'), log = join(root, 'events.jsonl'), fail = join(root, 'fail')
  const executable = `#!${process.execPath}\nimport {appendFileSync,existsSync} from 'node:fs'; let body=''; for await(const c of process.stdin)body+=c; if(existsSync(${JSON.stringify(fail)}))process.exit(1); appendFileSync(${JSON.stringify(log)},body+'\\n');\n`
  await writeFile(bridge, executable); await chmod(bridge, 0o755)
  // Use .mjs for the executable so the fixture has no package dependency.
  await rename(bridge, bridge + '.mjs')
  const path = bridge + '.mjs'
  const source = (await readFile(new URL('../opencode-plugin.js', import.meta.url), 'utf8'))
    .replace('const bridge = join(homedir(), ".cot", "bin", "cot")', 'const bridge = ' + JSON.stringify(path))
  const module = join(root, 'plugin.mjs'); await writeFile(module, source)
  const plugin = (await import(pathToFileURL(module).href)).default
  const records = async () => { try { return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse) } catch { return [] } }
  return { plugin, path, fail, records }
}

async function context(plugin) {
  const handlers = new Map(), queue = []
  let stopped = false
  const cleanup = await plugin.setup({
    location: { directory: '/project/A' },
    session: { get: async ({ sessionID }) => ({ id: sessionID, location: { directory: '/project/B' } }), hook: async (name, fn) => handlers.set('session:' + name, fn) },
    tool: { hook: async (name, fn) => handlers.set('tool:' + name, fn) },
    permission: { hook: async (name, fn) => handlers.set('permission:' + name, fn) },
    event: { async *subscribe({ signal }) {
      signal.addEventListener('abort', () => { stopped = true })
      while (!stopped) { if (queue.length) yield queue.shift(); else await delay(1) }
    } },
  })
  return { handlers, emit: (type, data, id = type) => queue.push({ type, data, id, created: 1791000000000 }), finish: async () => { while(queue.length) await delay(1); await cleanup() } }
}

test('v2 burst preserves responses, thoughts, usage, compaction and terminal events on disposal', async (t) => {
  const f = await fixture(t), c = await context(f.plugin), sid = 'v2'
  await c.handlers.get('session:prompt')({ sessionID: sid, messageID: 'prompt', prompt: { text: 'π🙂' } })
  c.emit('session.step.started', { sessionID: sid, assistantMessageID: 'msg', model: { providerID: 'review', id: 'model' } })
  c.emit('session.text.ended', { sessionID: sid, assistantMessageID: 'msg', ordinal: 0, text: 'π🙂' })
  c.emit('session.text.ended', { sessionID: sid, assistantMessageID: 'msg', ordinal: 1, text: 'second part' }, 'text-2')
  c.emit('session.reasoning.ended', { sessionID: sid, assistantMessageID: 'msg', ordinal: 0, text: 'thought' })
  c.emit('session.usage.updated', { sessionID: sid, tokens: { input: 999 } })
  c.emit('session.step.ended', { sessionID: sid, assistantMessageID: 'msg', finish: 'stop', tokens: { input: 120, output: 25, cache: { read: 7, write: 3 } } })
  c.emit('session.compaction.ended', { sessionID: sid, text: 'summary' })
  c.emit('session.execution.succeeded', { sessionID: sid })
  await c.finish()
  const events = await f.records(), hooks = events.map(e => e.hook_event_name)
  for (const hook of ['SessionStart', 'UserPromptSubmit', 'afterAgentResponse', 'afterAgentThought', 'OpenCodeUsage', 'PostCompact', 'Stop']) assert(hooks.includes(hook), hook)
  assert.equal(hooks.filter(h => h === 'afterAgentResponse').length, 2)
  assert.equal(hooks.filter(h => h === 'OpenCodeUsage').length, 1)
  assert.deepEqual(events.find(e => e.hook_event_name === 'OpenCodeUsage').usage, {input_tokens:120,output_tokens:25,cache_read_tokens:7,cache_write_tokens:3})
  assert(events.every(e => e.cwd === '/project/B'))
})

test('v2 malformed events do not stop subscription and failures/interruption survive', async (t) => {
  const f = await fixture(t), c = await context(f.plugin), sid = 'edge'
  c.emit('session.text.ended', { sessionID: sid, text: 123 })
  c.emit('session.text.ended', { sessionID: sid, text: 'valid', timestamp: NaN }, 'valid-text')
  c.emit('session.execution.failed', { sessionID: sid, error: { message: 'provider rejected' } })
  c.emit('session.execution.interrupted', { sessionID: sid, reason: 'user' })
  await c.handlers.get('permission:evaluate')({ sessionID: sid, effect: 'ask', source: { id: 'perm' }, action: 'shell' })
  await c.finish()
  const events = await f.records()
  assert.equal(events.filter(e => e.hook_event_name === 'afterAgentResponse').length, 1)
  assert(events.some(e => e.error?.message === 'provider rejected'))
  assert(events.some(e => e.interrupted))
  assert(events.every(e => Number.isFinite(Date.parse(e.timestamp))))
})

test('failed spawn and nonzero bridge exit allow the same prompt to be retried', async (t) => {
  const f = await fixture(t), c = await context(f.plugin)
  const prompt = { sessionID: 'retry', messageID: 'same', prompt: { text: 'retry' } }
  await rename(f.path, f.path + '.saved')
  await c.handlers.get('session:prompt')(prompt)
  await rename(f.path + '.saved', f.path)
  await writeFile(f.fail, 'fail')
  await c.handlers.get('session:prompt')(prompt)
  await rm(f.fail)
  await c.handlers.get('session:prompt')(prompt)
  await c.handlers.get('session:prompt')(prompt)
  await c.finish()
  assert.deepEqual((await f.records()).map(e => e.hook_event_name).sort(), ['SessionStart', 'UserPromptSubmit'])
})

test('v1 circular and BigInt tool inputs preserve delivery without rejecting', async (t) => {
  const f = await fixture(t), hooks = await f.plugin.server({ directory: '/v1' })
  const input = { value: 12n }; input.self = input
  await hooks['tool.execute.before']({ sessionID: 'v1', callID: 'call', tool: 'read' }, { args: input })
  const [event] = await f.records()
  assert.equal(event.tool_input.value, '12')
  assert.equal(event.tool_input.self, '[Circular]')
})

test('nonzero shell exits are failures even when OpenCode marks the tool completed', async (t) => {
  const f = await fixture(t), c = await context(f.plugin)
  await c.handlers.get('tool:execute.after')({ sessionID: 'v2-shell', tool: 'shell', callID: 'shell', status: 'completed', input: { command: 'exit 7' }, result: { metadata: { exit: 7 }, output: 'failed-command' } })
  await c.finish()
  const hooks = await f.plugin.server({ directory: '/v1' })
  await hooks.event({ event: { type: 'message.part.updated', properties: { part: { id: 'part', sessionID: 'v1-shell', callID: 'bash', type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'exit 7' }, output: 'failed-command', metadata: { exit: 7 } } } } } })
  const events = (await f.records()).filter(e => e.tool_name)
  assert.equal(events.length, 2)
  assert(events.every(e => e.hook_event_name === 'PostToolUseFailure'))
  assert.equal(events[0].tool_response.metadata.exit, 7)
  assert.equal(events[1].tool_metadata.exit, 7)
})

test('stalled bridge is killed within the bound and retry is available', async (t) => {
  const f = await fixture(t), hooks = await f.plugin.server({ directory: '/v1' })
  const original = await readFile(f.path)
  await writeFile(f.path, `#!${process.execPath}\nsetInterval(()=>{},1000)\n`)
  const start = Date.now(), input = { sessionID: 'timeout', callID: 'call', tool: 'read' }, output = { args: { path: '/v1/a' } }
  await hooks['tool.execute.before'](input, output)
  assert(Date.now() - start < 7000)
  await writeFile(f.path, original)
  await hooks['tool.execute.before'](input, output)
  assert.equal((await f.records()).length, 1)
})
