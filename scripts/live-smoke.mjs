/**
 * 真实接口冒烟：验证插件 lib/decider.js 走真实 OpenRouter alpha decisions。
 * 用法（PowerShell）：
 *   $env:DECISION_MODEL_KEY = '<key>'
 *   node scripts/live-smoke.mjs
 * 不会打印 key。
 */
import { callDecisionModel, summarizeAnswers } from '../lib/decider.js'
import { formatGateAdvice, evaluateGate, buildGateQuestions, buildGateState } from '../lib/decider.js'

const key = process.env.DECISION_MODEL_KEY || process.env.OPENROUTER_DECISION_API_KEY || ''
if (key === '') {
  console.error('缺少 DECISION_MODEL_KEY / OPENROUTER_DECISION_API_KEY')
  process.exit(2)
}

const questions = {
  clarity: { type: 'noul', instructions: '一个独立的 Host 插件要在调度子代理前调用决策模型，任务定义是否清晰？' },
  dispatch: {
    type: 'choice',
    instructions: '这次调度应当如何进行？',
    criteria: { dispatch: '直接调度一个子代理', split: '拆分后再并行', defer: '暂不调度' },
  },
  quality: { type: 'score', instructions: '当前方案的质量等级？', criteria: ['很差', '一般', '很好'] },
}

const started = Date.now()
const decision = await callDecisionModel({
  apiKey: key,
  model: process.env.DECISION_MODEL || 'perplexity/pplx-decider-v1.2',
  state: buildGateState('subagent', { prompt: '为 DSH 编写 decision 插件并安装验证' }),
  questions,
})

console.log(`耗时 ${Date.now() - started}ms；模型 ${decision.model}；provider ${decision.provider}`)
console.log(summarizeAnswers(decision, questions))
console.log('--- 调度前裁决 ---')
const gate = evaluateGate(decision, { threshold: 0.5 })
console.log(formatGateAdvice('subagent', decision, gate))
console.log('gate:', JSON.stringify({ blocked: gate.blocked, clarity: gate.clarity, route: gate.route }))
console.log('usage:', JSON.stringify(decision.usage))

const gateQuestions = buildGateQuestions('spawn_teammate')
console.log('gateQuestions:', JSON.stringify(gateQuestions))
