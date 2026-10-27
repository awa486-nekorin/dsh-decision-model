/**
 * index.js 的离线集成测试：用假 ctx 驱动插件注册，用 mock fetch 驱动决策调用，
 * 验证工具、系统提示词、tools/pre-execute 与 tools/post-execute 的真实行为。
 * 运行：node --test test/
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, Config } from '../index.js'
import { DEFAULT_ENDPOINT, DEFAULT_MODEL } from '../lib/decider.js'

/** 一次响应：clarity 高、route=dispatch。 */
function allowResponse() {
  return {
    model: 'perplexity/pplx-decider-v1.2-20261016',
    answers: {
      clarity: { type: 'noul', noul: 0.91 },
      dispatch: {
        type: 'choice',
        choice: 'dispatch',
        probabilities: { dispatch: 0.8, split: 0.15, defer: 0.05 },
        confidence: 0.4,
      },
    },
    usage: { input_tokens: 120, output_tokens: 2, cost: 0.0000025 },
    id: 'gen-dec-test-allow',
    provider: 'Perplexity',
  }
}

/** 一次响应：clarity 低、route=defer。 */
function blockResponse() {
  return {
    model: 'perplexity/pplx-decider-v1.2-20261016',
    answers: {
      clarity: { type: 'noul', noul: 0.12 },
      dispatch: { type: 'choice', choice: 'defer', probabilities: { dispatch: 0.1, split: 0.2, defer: 0.7 } },
    },
    usage: { cost: 0.0000021 },
    id: 'gen-dec-test-block',
    provider: 'Perplexity',
  }
}

/** 构造一个只记录注册的最小 ctx。 */
function makeCtx() {
  const tools = []
  const sections = []
  const handlers = new Map()
  const logs = []
  const ctx = {
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {}
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      },
    },
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, [])
      handlers.get(name).push(handler)
      return () => {}
    },
    logger: {
      info: (message) => logs.push(['info', message]),
      warn: (message) => logs.push(['warn', message]),
      error: (message) => logs.push(['error', message]),
    },
  }
  return { ctx, tools, sections, handlers, logs }
}

/** 用给定响应替换 globalThis.fetch，返回恢复函数。 */
function stubFetch(response, status = 200) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    const text = typeof response === 'string' ? response : JSON.stringify(response)
    return { ok: status >= 200 && status < 300, status, async text() { return text } }
  }
  return {
    calls,
    restore() {
      globalThis.fetch = original
    },
  }
}

/** 依次执行某个事件的 waterfall：handler(...args, next)，next 返回最后一个 listener 的结果。 */
async function runWaterfall(handlers, name, args, terminal) {
  const list = handlers.get(name) ?? []
  let index = 0
  const next = async () => {
    if (index >= list.length) return terminal ? terminal() : undefined
    const handler = list[index]
    index += 1
    return handler(...args, next)
  }
  return next()
}

function baseConfig(overrides = {}) {
  return {
    endpoint: DEFAULT_ENDPOINT,
    model: DEFAULT_MODEL,
    apiKey: 'sk-test',
    timeoutMs: 3000,
    gateTimeoutMs: 3000,
    toolName: 'decision',
    mode: 'advisory',
    threshold: 0.5,
    onError: 'allow',
    promptSection: true,
    maxStateChars: 4000,
    gatedTools: ['subagent', 'spawn_teammate', 'workflow'],
    ...overrides,
  }
}

test('Config 是有效的 schemastery schema（本机可加载时）', () => {
  if (Config === undefined) return
  const config = Config(baseConfig())
  assert.equal(config.toolName, 'decision')
  assert.equal(config.mode, 'advisory')
  assert.deepEqual(config.gatedTools, ['subagent', 'spawn_teammate', 'workflow'])
  assert.equal(config.threshold, 0.5)
  assert.equal(config.gateTimeoutMs, 3000)
})

test('apply 注册 decision 工具、系统提示词与两个 waterfall listener', () => {
  const { ctx, tools, sections, handlers } = makeCtx()
  apply(ctx, baseConfig())

  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, 'decision')
  assert.equal(typeof tools[0].execute, 'function')
  assert.equal(typeof tools[0].output.render, 'function')
  assert.deepEqual(tools[0].parameters.required, ['state', 'questions'])

  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'decision-model')
  assert.equal(sections[0].order, 3150)
  assert.equal(sections[0].interpolate, false)
  assert.match(sections[0].text, /decision/)
  assert.match(sections[0].text, /advisory/)

  assert.equal(handlers.get('tools/pre-execute')?.length, 1)
  assert.equal(handlers.get('tools/post-execute')?.length, 1)
})

test('mode=off 时只注册工具与提示词，不介入调度', () => {
  const { ctx, tools, handlers } = makeCtx()
  apply(ctx, baseConfig({ mode: 'off' }))
  assert.equal(tools.length, 1)
  assert.equal(handlers.get('tools/pre-execute'), undefined)
  assert.equal(handlers.get('tools/post-execute'), undefined)
})

test('gatedTools: [] 表示不门禁任何工具', () => {
  const { ctx, handlers } = makeCtx()
  apply(ctx, baseConfig({ gatedTools: [] }))
  assert.equal(handlers.get('tools/pre-execute'), undefined)
  assert.equal(handlers.get('tools/post-execute'), undefined)
})

test('省略 gatedTools 时使用默认调度工具清单', () => {
  const { ctx, handlers } = makeCtx()
  apply(ctx, { apiKey: 'sk-test', mode: 'advisory' })
  assert.equal(handlers.get('tools/pre-execute')?.length, 1)
  assert.equal(handlers.get('tools/post-execute')?.length, 1)
})

test('decision 工具执行真实请求路径并返回摘要', async () => {
  const stub = stubFetch(allowResponse())
  try {
    const { ctx, tools } = makeCtx()
    apply(ctx, baseConfig())
    const value = await tools[0].execute({
      state: { goal: '写插件' },
      questions: {
        clarity: { type: 'noul', instructions: '是否清晰？' },
        dispatch: { type: 'choice', instructions: '怎么调度？', criteria: { dispatch: '直接', split: '拆分', defer: '暂缓' } },
      },
    }, { signal: new AbortController().signal })

    assert.equal(value.ok, true)
    assert.equal(value.model, 'perplexity/pplx-decider-v1.2-20261016')
    assert.match(value.summary, /P\(是\)=91\.0%/)
    assert.equal(stub.calls.length, 1)
    const body = JSON.parse(stub.calls[0].init.body)
    assert.deepEqual(body.state, { goal: '写插件' })
    const rendered = tools[0].output.render({}, value)
    assert.equal(rendered[0].type, 'text')
    assert.match(rendered[0].text, /决策模型/)
  } finally {
    stub.restore()
  }
})

test('decision 工具把调用失败转成可读错误', async () => {
  const stub = stubFetch({ error: 'bad' }, 500)
  try {
    const { ctx, tools } = makeCtx()
    apply(ctx, baseConfig())
    await assert.rejects(
      () => tools[0].execute({
        state: 'x',
        questions: { q: { type: 'noul', instructions: 'y' } },
      }, { signal: new AbortController().signal }),
      /决策模型调用失败（http）/,
    )
  } finally {
    stub.restore()
  }
})

test('advisory：调度前裁决并把意见追加到调度结果之后', async () => {
  const stub = stubFetch(allowResponse())
  try {
    const { ctx, handlers } = makeCtx()
    apply(ctx, baseConfig())

    const exec = {
      name: 'subagent',
      arguments: { description: '调研', prompt: '调研 X 并汇报' },
      callId: 'call-1',
      agent: { id: 'session-lead' },
      signal: new AbortController().signal,
    }
    const pre = await runWaterfall(handlers, 'tools/pre-execute', [exec], () => ({ kind: 'allow' }))
    assert.equal(pre.kind, 'allow')

    const result = { isError: false, content: [{ type: 'text', text: '子代理已启动' }] }
    const post = await runWaterfall(handlers, 'tools/post-execute', [exec, result], () => ({ kind: 'accept' }))
    assert.equal(post.kind, 'accept')
    assert.equal(post.content.length, 2)
    assert.equal(post.content[0].text, '子代理已启动')
    assert.match(post.content[1].text, /\[decision-model\] 调度「subagent」/)
    assert.match(post.content[1].text, /P\(是\)=91\.0%/)
    assert.equal(stub.calls.length, 1)
  } finally {
    stub.restore()
  }
})

test('advisory：低清晰度仅输出风险提示，仍放行', async () => {
  const stub = stubFetch(blockResponse())
  try {
    const { ctx, handlers } = makeCtx()
    apply(ctx, baseConfig({ mode: 'advisory' }))
    const exec = { name: 'subagent', arguments: { prompt: '信息不足' }, callId: 'call-risk', signal: new AbortController().signal }
    const pre = await runWaterfall(handlers, 'tools/pre-execute', [exec], () => ({ kind: 'allow' }))
    assert.equal(pre.kind, 'allow')
    const result = { isError: false, content: [{ type: 'text', text: 'started' }] }
    const post = await runWaterfall(handlers, 'tools/post-execute', [exec, result], () => ({ kind: 'accept' }))
    assert.equal(post.kind, 'accept')
    assert.equal(post.content.length, 2)
    assert.match(post.content[1].text, /风险提示/)
    assert.match(post.content[1].text, /暂不调度/)
  } finally {
    stub.restore()
  }
})

test('结构化 value 结果保留原值并记录未能追加意见的 warning', async () => {
  const stub = stubFetch(allowResponse())
  try {
    const { ctx, handlers, logs } = makeCtx()
    apply(ctx, baseConfig())
    const exec = { name: 'subagent', arguments: {}, callId: 'call-value', signal: new AbortController().signal }
    await runWaterfall(handlers, 'tools/pre-execute', [exec], () => ({ kind: 'allow' }))
    const value = { status: 'started' }
    const result = { isError: false, content: [{ type: 'text', text: 'started' }] }
    const post = await runWaterfall(handlers, 'tools/post-execute', [exec, result], () => ({ kind: 'accept', value }))
    assert.equal(post.kind, 'accept')
    assert.equal(post.value, value)
    assert.ok(logs.some(([level, text]) => level === 'warn' && /无法附加/.test(text)))
  } finally {
    stub.restore()
  }
})

test('enforce：清晰度低时拒绝调度并带原因', async () => {
  const stub = stubFetch(blockResponse())
  try {
    const { ctx, handlers } = makeCtx()
    apply(ctx, baseConfig({ mode: 'enforce' }))
    const exec = {
      name: 'spawn_teammate',
      arguments: { name: 'worker', prompt: '做点事' },
      callId: 'call-2',
      agent: { id: 'session-lead' },
      signal: new AbortController().signal,
    }
    const pre = await runWaterfall(handlers, 'tools/pre-execute', [exec], () => ({ kind: 'allow' }))
    assert.equal(pre.kind, 'deny')
    assert.match(pre.reason, /清晰度/)
    assert.match(pre.reason, /enforce 模式/)
    assert.equal(pre.info.code, 'DECISION_GATE')
  } finally {
    stub.restore()
  }
})

test('enforce + onError=deny：决策模型不可用时拒绝调度', async () => {
  const stub = stubFetch({ error: 'boom' }, 500)
  try {
    const { ctx, handlers } = makeCtx()
    apply(ctx, baseConfig({ mode: 'enforce', onError: 'deny' }))
    const exec = { name: 'workflow', arguments: { script: 'x' }, callId: 'call-3', signal: new AbortController().signal }
    const pre = await runWaterfall(handlers, 'tools/pre-execute', [exec], () => ({ kind: 'allow' }))
    assert.equal(pre.kind, 'deny')
    assert.match(pre.reason, /决策模型不可用/)
    assert.equal(pre.info.code, 'DECISION_UNAVAILABLE')
  } finally {
    stub.restore()
  }
})

test('非调度工具与上游 deny 不受影响', async () => {
  const stub = stubFetch(allowResponse())
  try {
    const { ctx, handlers } = makeCtx()
    apply(ctx, baseConfig())

    const other = { name: 'read', arguments: {}, callId: 'call-4', signal: new AbortController().signal }
    const pre = await runWaterfall(handlers, 'tools/pre-execute', [other], () => ({ kind: 'allow' }))
    assert.equal(pre.kind, 'allow')
    assert.equal(stub.calls.length, 0)

    const gated = { name: 'subagent', arguments: {}, callId: 'call-5', signal: new AbortController().signal }
    const denied = await runWaterfall(handlers, 'tools/pre-execute', [gated], () => ({ kind: 'deny', reason: '别的插件拦了' }))
    assert.equal(denied.kind, 'deny')
    assert.equal(stub.calls.length, 0)
  } finally {
    stub.restore()
  }
})

test('advisory 下模型超时不影响调度（fail-open）', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
  })
  try {
    const { ctx, handlers } = makeCtx()
    apply(ctx, baseConfig({ timeoutMs: 3000, gateTimeoutMs: 1000, threshold: 0.9 }))
    const exec = { name: 'subagent', arguments: {}, callId: 'call-6', signal: new AbortController().signal }
    const started = Date.now()
    const pre = await runWaterfall(handlers, 'tools/pre-execute', [exec], () => ({ kind: 'allow' }))
    assert.equal(pre.kind, 'allow')
    // 门禁按 gateTimeoutMs（1s）超时放行，而不是按工具 timeoutMs（3s）。
    assert.ok(Date.now() - started < 2500)
  } finally {
    globalThis.fetch = original
  }
})
