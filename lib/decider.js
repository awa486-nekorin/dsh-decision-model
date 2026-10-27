/**
 * lib/decider.js —— OpenRouter「Alpha Decisions」JEV 类决策模型客户端。
 * ============================================================================
 * 这个文件只做四件事，全部与 Cordis 无关，所以能在 node --test 里直接跑：
 *   1. 校验 / 归一化 `questions`（noul | choice | score）与 `state`；
 *   2. 发一次 POST /api/alpha/decisions（带超时、可取消、错误可分类）；
 *   3. 把响应归一化成稳定的结构（概率、等级、置信度、用量）；
 *   4. 生成给模型看的中文摘要，以及「调度前自动裁决」的判定。
 *
 * 实测响应（2026-10，perplexity/pplx-decider-v1.2）：
 *   noul  -> { type:"noul",  noul:<0..1 的「是」概率> }
 *   choice-> { type:"choice", choice:"A", probabilities:{...}, confidence:0..1 }
 *   score -> { type:"score", score:<级别期望值>, legend:{下标:级别名},
 *              probabilities:{下标:概率}, confidence:0..1 }
 * 顶层通常还有 model / provider / id / usage{input_tokens,output_tokens,cost}。
 * ============================================================================
 */

/** 默认接口地址（OpenRouter alpha）。 */
export const DEFAULT_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions'

/** 默认模型。 */
export const DEFAULT_MODEL = 'perplexity/pplx-decider-v1.2'

/** 支持的问题类型。 */
export const QUESTION_TYPES = ['noul', 'choice', 'score']

/** 单次请求最多几个问题（防御模型一次塞爆）。 */
export const MAX_QUESTIONS = 12

/** 默认在调度哪些工具前自动咨询决策模型。 */
export const DEFAULT_GATED_TOOLS = [
  'subagent',
  'subagent_fork',
  'subagent_codex',
  'subagent_claude_code',
  'spawn_teammate',
  'ralph',
  'workflow',
]

/** 可分类的决策模型错误。 */
export class DeciderError extends Error {
  /**
   * @param {'invalid-questions'|'invalid-state'|'no-api-key'|'network'|'timeout'|'aborted'|'http'|'invalid-response'} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'DeciderError'
    this.code = code
    this.details = details
  }
}

/** 把任意值安全截断成字符串。 */
export function truncateText(value, maxChars) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  const max = Math.max(16, Number(maxChars) || 0)
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…[已截断 ${text.length - max} 字符]`
}

/** JSON.stringify 的容错版本：循环引用 / BigInt 都退化成字符串。 */
export function safeJson(value) {
  const seen = new WeakSet()
  try {
    return JSON.stringify(value, (_key, item) => {
      if (typeof item === 'bigint') return String(item)
      if (item && typeof item === 'object') {
        if (seen.has(item)) return '[Circular]'
        seen.add(item)
      }
      return item
    })
  } catch {
    return String(value)
  }
}

/**
 * 取 API key：优先 config.apiKey，其次 apiKeyEnv 指向的环境变量。
 * @param {{ apiKey?: string, apiKeyEnv?: string }} config
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveApiKey(config, env = process.env) {
  const direct = typeof config?.apiKey === 'string' ? config.apiKey.trim() : ''
  if (direct !== '') return direct
  const name = typeof config?.apiKeyEnv === 'string' ? config.apiKeyEnv.trim() : ''
  if (name !== '' && typeof env?.[name] === 'string') return env[name].trim()
  return ''
}

/**
 * 校验并归一化 questions。
 * @param {unknown} input
 * @returns {Record<string, Record<string, unknown>>} 可直接进入请求体的对象
 */
export function normalizeQuestions(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new DeciderError(
      'invalid-questions',
      'questions 必须是对象：{ 问题ID: { type, instructions, criteria? } }',
    )
  }
  const entries = Object.entries(input)
  if (entries.length === 0) {
    throw new DeciderError('invalid-questions', 'questions 不能为空，至少提一个问题')
  }
  if (entries.length > MAX_QUESTIONS) {
    throw new DeciderError('invalid-questions', `questions 最多 ${MAX_QUESTIONS} 个，当前 ${entries.length} 个`)
  }

  const out = {}
  for (const [rawId, rawQuestion] of entries) {
    const id = String(rawId).trim()
    if (id === '' || id.length > 64) {
      throw new DeciderError('invalid-questions', `问题 ID 非法（1~64 字符）：${JSON.stringify(rawId)}`)
    }
    if (!rawQuestion || typeof rawQuestion !== 'object' || Array.isArray(rawQuestion)) {
      throw new DeciderError('invalid-questions', `问题 ${id} 必须是对象`)
    }
    const type = String(rawQuestion.type ?? '').trim().toLowerCase()
    if (!QUESTION_TYPES.includes(type)) {
      throw new DeciderError(
        'invalid-questions',
        `问题 ${id} 的 type 必须是 ${QUESTION_TYPES.join(' / ')}，收到 ${JSON.stringify(rawQuestion.type)}`,
      )
    }
    const instructions = typeof rawQuestion.instructions === 'string' ? rawQuestion.instructions.trim() : ''
    if (instructions === '') {
      throw new DeciderError('invalid-questions', `问题 ${id} 缺少 instructions（要问清楚的判断）`)
    }

    if (type === 'noul') {
      out[id] = { type, instructions }
      continue
    }

    if (type === 'choice') {
      const criteria = rawQuestion.criteria
      if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) {
        throw new DeciderError('invalid-questions', `choice 问题 ${id} 需要 criteria 对象：{ 选项: 说明|null }`)
      }
      const options = {}
      for (const [label, description] of Object.entries(criteria)) {
        const option = String(label).trim()
        if (option === '') continue
        options[option] = typeof description === 'string' ? description : null
      }
      if (Object.keys(options).length < 2) {
        throw new DeciderError('invalid-questions', `choice 问题 ${id} 至少需要 2 个选项`)
      }
      out[id] = { type, instructions, criteria: options }
      continue
    }

    // score
    const criteria = rawQuestion.criteria
    if (!Array.isArray(criteria) || criteria.length < 2) {
      throw new DeciderError('invalid-questions', `score 问题 ${id} 需要 criteria 数组（从低到高，至少 2 级）`)
    }
    const levels = criteria.map((level) => String(level ?? '').trim()).filter((level) => level !== '')
    if (levels.length < 2) {
      throw new DeciderError('invalid-questions', `score 问题 ${id} 的 criteria 里至少要有 2 个非空级别名`)
    }
    out[id] = { type, instructions, criteria: levels }
  }
  return out
}

/**
 * 归一化 state：字符串原样；对象/数组原样（超大时退化为截断后的 JSON 字符串）。
 * @param {unknown} state
 * @param {number} [maxChars]
 * @returns {string|object|Array<unknown>}
 */
export function normalizeState(state, maxChars = 4000) {
  if (state === undefined || state === null) {
    throw new DeciderError('invalid-state', 'state 不能为空：把当前上下文、目标、约束写进去')
  }
  if (typeof state === 'string') {
    const text = state.trim()
    if (text === '') throw new DeciderError('invalid-state', 'state 是空字符串')
    return boundedJsonText(text, Math.max(16, Number(maxChars) || 0), 'state 已截断')
  }
  if (typeof state === 'number' || typeof state === 'boolean') {
    return String(state)
  }
  if (typeof state === 'object') {
    const json = safeJson(state)
    if (json.length > Math.max(16, Number(maxChars) || 0)) return boundedJsonText(json, Math.max(16, Number(maxChars) || 0), 'state 已截断')
    return state
  }
  return String(state)
}

/**
 * 请求一次决策模型。
 * @param {object} options
 * @param {string} options.endpoint
 * @param {string} options.apiKey
 * @param {string} options.model
 * @param {string|object|Array<unknown>} options.state
 * @param {Record<string, unknown>} options.questions
 * @param {number} [options.timeoutMs]
 * @param {AbortSignal} [options.signal]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<NormalizedDecision>}
 */
export async function callDecisionModel(options) {
  const {
    endpoint = DEFAULT_ENDPOINT,
    apiKey,
    model = DEFAULT_MODEL,
    state,
    questions,
    timeoutMs = 20000,
    signal,
    fetchImpl = globalThis.fetch,
  } = options ?? {}

  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new DeciderError('no-api-key', '没有可用的 API key：在插件 config 里填 apiKey，或设置 apiKeyEnv 指向的环境变量')
  }
  if (typeof fetchImpl !== 'function') {
    throw new DeciderError('network', '当前运行环境没有 fetch')
  }

  const timeout = Math.max(1000, Number(timeoutMs) || 20000)
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error('decision-timeout'))
  }, timeout)
  const forwardAbort = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', forwardAbort, { once: true })
  }

  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'DSH decision-model',
      },
      body: safeJson({ model, state, questions }),
      signal: controller.signal,
    })
    const rawText = await response.text()
    if (!response.ok) {
      throw new DeciderError('http', `决策模型 HTTP ${response.status}`, {
        status: response.status,
        body: truncateText(rawText, 600),
      })
    }
    let raw
    try {
      raw = JSON.parse(rawText)
    } catch {
      throw new DeciderError('invalid-response', '决策模型返回的不是 JSON', {
        body: truncateText(rawText, 600),
      })
    }
    return normalizeResponse(raw, questions)
  } catch (error) {
    if (error instanceof DeciderError) throw error
    if (timedOut) {
      throw new DeciderError('timeout', `决策模型 ${timeout}ms 内没有响应`)
    }
    if (controller.signal.aborted || error?.name === 'AbortError') {
      throw new DeciderError('aborted', '决策模型请求被取消')
    }
    throw new DeciderError('network', `决策模型请求失败：${error?.message ?? String(error)}`)
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener?.('abort', forwardAbort)
  }
}

/**
 * @typedef {object} NormalizedDecision
 * @property {string|null} model
 * @property {string|null} provider
 * @property {string|null} id
 * @property {{ input_tokens?: number, output_tokens?: number, cost?: number }|null} usage
 * @property {Record<string, object>} answers
 */

/**
 * 把原始响应归一化。缺字段的问题会标记 `missing: true`，不会抛错。
 * @param {any} raw
 * @param {Record<string, any>} questions 已经 normalizeQuestions 过的对象
 * @returns {NormalizedDecision}
 */
export function normalizeResponse(raw, questions) {
  if (!raw || typeof raw !== 'object') {
    throw new DeciderError('invalid-response', '决策模型响应不是对象')
  }
  const rawAnswers = raw.answers && typeof raw.answers === 'object' ? raw.answers : {}
  const answers = {}

  for (const [id, question] of Object.entries(questions ?? {})) {
    const answer = rawAnswers[id]
    if (!answer || typeof answer !== 'object') {
      answers[id] = { type: question?.type, missing: true }
      continue
    }
    if (question?.type === 'noul') {
      const probability = clamp01(answer.noul)
      answers[id] = {
        type: 'noul',
        probability,
        confidence: finiteNumber(answer.confidence),
      }
      continue
    }
    if (question?.type === 'choice') {
      const probabilities = numericRecord(answer.probabilities)
      const choice = typeof answer.choice === 'string' ? answer.choice : Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
      answers[id] = {
        type: 'choice',
        choice,
        probabilities,
        confidence: finiteNumber(answer.confidence),
      }
      continue
    }
    // score
    const probabilities = numericRecord(answer.probabilities)
    const score = finiteNumber(answer.score)
    const levels = Array.isArray(question?.criteria) ? question.criteria : []
    const scale = Math.max(0, levels.length - 1)
    const levelIndex = score === null ? null : clampIndex(Math.round(score), scale)
    const legend = answer.legend && typeof answer.legend === 'object' ? answer.legend : {}
    const legendLabel = levelIndex === null ? null : legend[String(levelIndex)]
    answers[id] = {
      type: 'score',
      score,
      scale,
      levelIndex,
      levelLabel: normalizeLevelLabel(legendLabel) ?? levels[levelIndex] ?? null,
      probabilities,
      confidence: finiteNumber(answer.confidence),
    }
  }

  return {
    model: typeof raw.model === 'string' ? raw.model : null,
    provider: typeof raw.provider === 'string' ? raw.provider : null,
    id: typeof raw.id === 'string' ? raw.id : null,
    usage: raw.usage && typeof raw.usage === 'object'
      ? {
          input_tokens: finiteNumber(raw.usage.input_tokens),
          output_tokens: finiteNumber(raw.usage.output_tokens),
          cost: finiteNumber(raw.usage.cost),
        }
      : null,
    answers,
  }
}

/**
 * 生成给模型看的中文摘要（紧凑、有界）。
 * @param {NormalizedDecision} decision
 * @param {Record<string, any>} questions
 * @returns {string}
 */
export function summarizeAnswers(decision, questions) {
  const lines = [`决策模型 ${decision.model ?? '(未知模型)'} 的裁决：`]
  for (const [id, question] of Object.entries(questions ?? {})) {
    const answer = decision.answers?.[id]
    if (!answer || answer.missing) {
      lines.push(`- ${id}（${question?.type}）：模型没有给出答案`)
      continue
    }
    if (answer.type === 'noul') {
      lines.push(`- ${id}（是/否）：P(是)=${formatProbability(answer.probability)}${formatConfidence(answer.confidence)}`)
      continue
    }
    if (answer.type === 'choice') {
      lines.push(`- ${id}（选择）：${answer.choice ?? '(无)'}${formatProbabilities(answer.probabilities)}${formatConfidence(answer.confidence)}`)
      continue
    }
    lines.push(
      `- ${id}（等级）：${answer.score === null ? '(无)' : answer.score.toFixed(2)} / ${answer.scale}`
      + (answer.levelIndex === null ? '' : `（第 ${answer.levelIndex} 级${answer.levelLabel ? `「${answer.levelLabel}」` : ''}）`)
      + formatDeviation(answer.confidence),
    )
  }
  if (decision.usage?.cost !== null && decision.usage?.cost !== undefined) {
    lines.push(`本次调用成本约 $${Number(decision.usage.cost).toFixed(8)}`)
  }
  return lines.join('\n')
}

/**
 * 组织「调度前裁决」的 state。
 * @param {string} toolName
 * @param {unknown} args 调度工具的实参
 * @param {number} [maxChars]
 * @returns {Record<string, unknown>}
 */
export function buildGateState(toolName, args, maxChars = 4000) {
  const max = Math.max(200, Math.floor(Number(maxChars) || 4000))
  const fixed = {
    scene: 'DSH 即将调度子代理/队友，需要判断是否值得委派、是否该拆分。',
    tool: String(toolName ?? ''),
    instruction: '只判断这次调度：任务是否清晰、是否该现在委派。',
  }
  let callArguments = safeJson(args ?? {})
  const state = { ...fixed, call_arguments: callArguments }
  const argumentBudget = Math.max(32, Math.floor(max * 0.65))
  if (callArguments.length > argumentBudget) {
    callArguments = boundedText(callArguments, argumentBudget, '调用参数已截断')
    state.call_arguments = callArguments
  }

  // JSON escaping and unusually long tool names can add bytes beyond the field budget.
  let serialized = safeJson(state)
  while (serialized.length > max && callArguments.length > 0) {
    const excess = serialized.length - max
    const nextLength = Math.max(0, callArguments.length - excess - 8)
    if (nextLength >= callArguments.length) break
    callArguments = boundedText(callArguments, nextLength, '调用参数已截断')
    state.call_arguments = callArguments
    serialized = safeJson(state)
  }
  if (serialized.length <= max) return state
  let fallback = boundedText(serialized, max - 2, 'state 已截断')
  while (JSON.stringify(fallback).length > max) {
    fallback = boundedText(fallback, fallback.length - (JSON.stringify(fallback).length - max), 'state 已截断')
  }
  return fallback
}

function boundedText(value, maxChars, label) {
  const max = Math.max(0, Math.floor(maxChars))
  if (value.length <= max) return value
  const suffix = `…[${label}]`
  return max <= suffix.length ? suffix.slice(0, max) : `${value.slice(0, max - suffix.length)}${suffix}`
}

function boundedJsonText(value, maxChars, label) {
  let result = boundedText(value, maxChars, label)
  while (JSON.stringify(result).length > maxChars && result.length > 0) {
    const excess = JSON.stringify(result).length - maxChars
    result = boundedText(value, Math.max(0, result.length - excess - 1), label)
  }
  return result
}

/**
 * 组织「调度前裁决」的问题。
 * @param {string} toolName
 * @returns {Record<string, unknown>}
 */
export function buildGateQuestions(toolName) {
  return {
    clarity: {
      type: 'noul',
      instructions: `即将调用工具「${toolName}」把任务委派给子代理执行。就当前这一步的信息而言，任务描述、上下文和验收标准是否已经足够清晰，可以直接委派而不会返工？`,
    },
    dispatch: {
      type: 'choice',
      instructions: '这次调度应当如何进行？',
      criteria: {
        dispatch: '直接调度一个子代理执行',
        split: '先把任务拆成更小的并行子任务，再分别调度',
        defer: '暂不调度：先补充上下文、澄清需求，或由主代理自己完成',
      },
    },
  }
}

/**
 * 把裁决结果变成「拦不拦」的判断。
 * @param {NormalizedDecision} decision
 * @param {{ threshold?: number }} [options]
 * @returns {{ blocked: boolean, reasons: string[], clarity: number|null, route: string|null }}
 */
export function evaluateGate(decision, options = {}) {
  const threshold = clamp01(options.threshold ?? 0.5)
  const clarity = decision.answers?.clarity?.type === 'noul' ? decision.answers.clarity.probability : null
  const route = decision.answers?.dispatch?.type === 'choice' ? decision.answers.dispatch.choice : null
  const reasons = []

  if (clarity !== null && clarity < threshold) {
    reasons.push(`任务清晰度 P(是)=${formatProbability(clarity)} 低于阈值 ${threshold}`)
  }
  if (route === 'defer') {
    reasons.push('决策模型建议暂不调度')
  }
  return { blocked: reasons.length > 0, reasons, clarity, route }
}

/**
 * 生成一段附在调度结果里的「决策意见」（供 advisory / enforce 使用）。
 * @param {string} toolName
 * @param {NormalizedDecision} decision
 * @param {ReturnType<typeof evaluateGate>} gate
 * @returns {string}
 */
export function formatGateAdvice(toolName, decision, gate) {
  const routeText = gate.route === 'dispatch'
    ? '直接调度'
    : gate.route === 'split'
      ? '建议先拆分为更小的并行子任务'
      : gate.route === 'defer'
        ? '建议暂缓本次调度'
        : '未给出路线'
  return [
    `[decision-model] 调度「${toolName}」前咨询了决策模型：`,
    summarizeAnswers(decision, {
      clarity: { type: 'noul' },
      dispatch: { type: 'choice' },
    }),
    `路线建议：${routeText}`,
    gate.blocked ? `风险提示：${gate.reasons.join('；')}` : '判定：可以继续本次调度。',
  ].join('\n')
}

/* ── 小工具 ─────────────────────────────────────────────────────────────── */

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function clamp01(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(1, Math.max(0, value))
}

function clampIndex(value, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(max, Math.max(0, Math.trunc(value)))
}

function normalizeLevelLabel(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  return value.trim() === '?' ? null : value.trim()
}

function numericRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'number' && Number.isFinite(item)) out[String(key)] = item
  }
  return out
}

function formatProbability(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '未知'
}

function formatProbabilities(probabilities) {
  const entries = Object.entries(probabilities ?? {})
  if (entries.length === 0) return ''
  return `（${entries.map(([label, value]) => `${label} ${(value * 100).toFixed(1)}%`).join(' / ')}）`
}

function formatConfidence(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `，置信度 ${value.toFixed(3)}` : ''
}

/**
 * score 的 confidence 是「期望下标偏离中点」的绝对值，不是置信度：
 * 越接近 0 越中庸，越接近 1 越极端；方向只能看 score 本身。
 */
function formatDeviation(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `，偏离中点 ${value.toFixed(3)}` : ''
}
