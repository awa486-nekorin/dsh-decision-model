/**
 * lib/decider.js 的离线单元测试：不联网、不需要 DSH 运行时。
 * 运行：node --test test/（或 npm test）
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DeciderError,
  buildGateQuestions,
  buildGateState,
  callDecisionModel,
  evaluateGate,
  formatGateAdvice,
  normalizeQuestions,
  normalizeResponse,
  normalizeState,
  resolveApiKey,
  summarizeAnswers,
} from '../lib/decider.js'

/** 一次真实的 alpha decisions 响应（2026-10 实测，字段原样）。 */
function sampleResponse() {
  return {
    model: 'perplexity/pplx-decider-v1.2-20261016',
    answers: {
      clarity: { type: 'noul', noul: 0.5645674231450633 },
      dispatch: {
        type: 'choice',
        choice: 'dispatch',
        probabilities: { split: 0.28445516207844307, defer: 0.33943773759624185, dispatch: 0.376107100325315 },
        confidence: 0.06416065048797255,
      },
      quality: {
        type: 'score',
        score: 1.0128952538428218,
        legend: { 0: '低', 1: '中', 2: '高' },
        probabilities: { 0: 0.3229490604825048, 1: 0.3412066251921685, 2: 0.3358443143253267 },
        confidence: 0.011809937788252678,
      },
    },
    usage: { input_tokens: 139, output_tokens: 3, cost: 0.00000278 },
    id: 'gen-dec-1793094380-EKffPmF1An5zwx36ZvI8',
    provider: 'Perplexity',
  }
}

const QUESTIONS = normalizeQuestions({
  clarity: { type: 'noul', instructions: '任务是否清晰？' },
  dispatch: { type: 'choice', instructions: '怎么调度？', criteria: { dispatch: '直接', split: '拆分', defer: null } },
  quality: { type: 'score', instructions: '质量如何？', criteria: ['低', '中', '高'] },
})

/* ── normalizeQuestions ─────────────────────────────────────────────────── */

test('normalizeQuestions 接受三种类型并保留 criteria', () => {
  assert.deepEqual(QUESTIONS, {
    clarity: { type: 'noul', instructions: '任务是否清晰？' },
    dispatch: { type: 'choice', instructions: '怎么调度？', criteria: { dispatch: '直接', split: '拆分', defer: null } },
    quality: { type: 'score', instructions: '质量如何？', criteria: ['低', '中', '高'] },
  })
})

test('normalizeQuestions 拒绝非法输入', () => {
  assert.throws(() => normalizeQuestions(null), DeciderError)
  assert.throws(() => normalizeQuestions({}), /不能为空/)
  assert.throws(() => normalizeQuestions({ a: { type: 'nope', instructions: 'x' } }), /type 必须是/)
  assert.throws(() => normalizeQuestions({ a: { type: 'noul' } }), /instructions/)
  assert.throws(() => normalizeQuestions({ a: { type: 'choice', instructions: 'x' } }), /criteria 对象/)
  assert.throws(() => normalizeQuestions({ a: { type: 'choice', instructions: 'x', criteria: { only: '一个' } } }), /至少需要 2 个/)
  assert.throws(() => normalizeQuestions({ a: { type: 'score', instructions: 'x', criteria: ['单级'] } }), /至少 2 级/)
  const tooMany = {}
  for (let i = 0; i < 13; i += 1) tooMany[`q${i}`] = { type: 'noul', instructions: 'x' }
  assert.throws(() => normalizeQuestions(tooMany), /最多 12 个/)
})

/* ── normalizeState ─────────────────────────────────────────────────────── */

test('normalizeState 保留字符串/对象，超长对象退化为截断 JSON', () => {
  assert.equal(normalizeState('  待决策  ', 100), '待决策')
  assert.deepEqual(normalizeState({ goal: '写插件' }, 100), { goal: '写插件' })
  const longText = normalizeState('x'.repeat(500), 120)
  assert.ok(JSON.stringify(longText).length <= 120)
  const big = { text: 'x'.repeat(500) }
  const normalized = normalizeState(big, 120)
  assert.equal(typeof normalized, 'string')
  assert.ok(JSON.stringify(normalized).length <= 120)
  assert.match(normalized, /已截断/)
  assert.throws(() => normalizeState(undefined), DeciderError)
  assert.throws(() => normalizeState('   '), /空字符串/)
})

/* ── normalizeResponse / summarize ──────────────────────────────────────── */

test('normalizeResponse 归一化 noul / choice / score', () => {
  const decision = normalizeResponse(sampleResponse(), QUESTIONS)
  assert.equal(decision.model, 'perplexity/pplx-decider-v1.2-20261016')
  assert.equal(decision.provider, 'Perplexity')
  assert.equal(decision.usage.cost, 0.00000278)

  assert.equal(decision.answers.clarity.type, 'noul')
  assert.ok(Math.abs(decision.answers.clarity.probability - 0.5645674231450633) < 1e-12)

  assert.equal(decision.answers.dispatch.choice, 'dispatch')
  assert.equal(decision.answers.dispatch.probabilities.split, 0.28445516207844307)

  assert.equal(decision.answers.quality.scale, 2)
  assert.equal(decision.answers.quality.levelIndex, 1)
  assert.equal(decision.answers.quality.levelLabel, '中')
  assert.ok(Math.abs(decision.answers.quality.score - 1.0128952538428218) < 1e-12)
})

test('normalizeResponse 对缺失答案标记 missing 而不是抛错', () => {
  const decision = normalizeResponse({ model: 'x', answers: {} }, QUESTIONS)
  assert.deepEqual(decision.answers.clarity, { type: 'noul', missing: true })
  assert.equal(decision.answers.quality.missing, true)
})

test('summarizeAnswers 输出可读的中文裁决', () => {
  const decision = normalizeResponse(sampleResponse(), QUESTIONS)
  const text = summarizeAnswers(decision, QUESTIONS)
  assert.match(text, /P\(是\)=56\.5%/)
  assert.match(text, /选择.*dispatch/)
  assert.match(text, /1\.01 \/ 2/)
  assert.match(text, /第 1 级「中」/)
  assert.match(text, /成本约 \$0\.00000278/)
})

/* ── 调度前裁决 ─────────────────────────────────────────────────────────── */

test('evaluateGate 按 threshold 与 route 判定', () => {
  const low = normalizeResponse({ answers: { clarity: { noul: 0.2 }, dispatch: { choice: 'dispatch' } } }, QUESTIONS)
  assert.equal(evaluateGate(low, { threshold: 0.5 }).blocked, true)

  const high = normalizeResponse({ answers: { clarity: { noul: 0.9 }, dispatch: { choice: 'dispatch' } } }, QUESTIONS)
  assert.equal(evaluateGate(high, { threshold: 0.5 }).blocked, false)

  const defer = normalizeResponse({ answers: { clarity: { noul: 0.9 }, dispatch: { choice: 'defer' } } }, QUESTIONS)
  const gate = evaluateGate(defer, { threshold: 0.5 })
  assert.equal(gate.blocked, true)
  assert.match(gate.reasons.join(), /暂不调度/)
})

test('buildGateQuestions / buildGateState / formatGateAdvice 形状正确', () => {
  const questions = buildGateQuestions('subagent')
  assert.equal(questions.clarity.type, 'noul')
  assert.equal(questions.dispatch.type, 'choice')
  assert.ok(Object.keys(questions.dispatch.criteria).includes('defer'))

  const state = buildGateState('subagent', { prompt: 'x'.repeat(5000) }, 1000)
  assert.equal(state.tool, 'subagent')
  assert.match(String(state.call_arguments), /调用参数已截断/)
  assert.ok(JSON.stringify(state).length <= 1000)

  const longTool = buildGateState('tool'.repeat(200), { prompt: 'x'.repeat(5000) }, 200)
  assert.ok(JSON.stringify(longTool).length <= 200)

  const decision = normalizeResponse(sampleResponse(), QUESTIONS)
  const advice = formatGateAdvice('subagent', decision, evaluateGate(decision, { threshold: 0.5 }))
  assert.match(advice, /\[decision-model\] 调度「subagent」/)
  assert.match(advice, /判定：可以继续本次调度/)
})

/* ── callDecisionModel ──────────────────────────────────────────────────── */

test('callDecisionModel 发送正确请求并归一化响应', async () => {
  let captured
  const fetchImpl = async (url, init) => {
    captured = { url, init }
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify(sampleResponse())
      },
    }
  }
  const decision = await callDecisionModel({
    endpoint: 'https://example.test/decisions',
    apiKey: 'sk-test',
    model: 'perplexity/pplx-decider-v1.2',
    state: '待决策',
    questions: QUESTIONS,
    timeoutMs: 5000,
    fetchImpl,
  })
  assert.equal(captured.url, 'https://example.test/decisions')
  assert.equal(captured.init.method, 'POST')
  assert.equal(captured.init.headers.Authorization, 'Bearer sk-test')
  const body = JSON.parse(captured.init.body)
  assert.equal(body.model, 'perplexity/pplx-decider-v1.2')
  assert.equal(body.state, '待决策')
  assert.deepEqual(body.questions, QUESTIONS)
  assert.equal(decision.answers.dispatch.choice, 'dispatch')
})

test('callDecisionModel 分类 HTTP 错误与缺少 key', async () => {
  const httpFetch = async () => ({ ok: false, status: 401, async text() { return '{"error":"invalid api key"}' } })
  await assert.rejects(
    () => callDecisionModel({ apiKey: 'bad', state: 'x', questions: QUESTIONS, fetchImpl: httpFetch }),
    (error) => error instanceof DeciderError && error.code === 'http' && error.details.status === 401,
  )
  await assert.rejects(
    () => callDecisionModel({ apiKey: '', state: 'x', questions: QUESTIONS, fetchImpl: httpFetch }),
    (error) => error instanceof DeciderError && error.code === 'no-api-key',
  )
})

test('callDecisionModel 超时归类为 timeout', async () => {
  const hangFetch = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
  })
  await assert.rejects(
    () => callDecisionModel({ apiKey: 'k', state: 'x', questions: QUESTIONS, timeoutMs: 1000, fetchImpl: hangFetch }),
    (error) => error instanceof DeciderError && error.code === 'timeout',
  )
})

test('resolveApiKey 优先 config.apiKey，其次环境变量', () => {
  assert.equal(resolveApiKey({ apiKey: ' direct ', apiKeyEnv: 'X' }, { X: 'env' }), 'direct')
  assert.equal(resolveApiKey({ apiKey: '', apiKeyEnv: 'X' }, { X: 'env' }), 'env')
  assert.equal(resolveApiKey({ apiKey: '', apiKeyEnv: 'MISSING' }, {}), '')
})
