/**
 * @local/decision-model —— JEV 类决策模型桥（Host + Client bundle）
 * ============================================================================
 * 它把 OpenRouter 的「Alpha Decisions」接口（perplexity/pplx-decider-v1.2）
 * 接进 DSH，贡献三样东西：
 *
 *   1. `decision` 工具：模型可以把 state + questions（noul/choice/score）
 *      直接丢给决策模型，拿回概率、等级与置信度；
 *   2. 调度前自动裁决：`tools/pre-execute` 在 subagent / spawn_teammate /
 *      workflow 等调度工具真正执行前问一次决策模型。
 *        - advisory（默认）：不拦截，把裁决意见附在调度结果之后；
 *        - enforce：清晰度低于 threshold 或模型建议 defer 时直接拒绝本次调度；
 *   3. 一段系统提示词：告诉模型什么时候该先问决策模型、怎么用它的答案。
 *
 * 所有网络/归一化逻辑都在 lib/decider.js（无 Cordis 依赖，可离线测试）。
 * ============================================================================
 */
import {
  DEFAULT_ENDPOINT,
  DEFAULT_GATED_TOOLS,
  DEFAULT_MODEL,
  DeciderError,
  MAX_QUESTIONS,
  buildGateQuestions,
  buildGateState,
  callDecisionModel,
  evaluateGate,
  formatGateAdvice,
  normalizeQuestions,
  normalizeState,
  safeJson,
  summarizeAnswers,
} from './lib/decider.js'
import { loadSchemastery } from './lib/schemastery.js'
import { createSettingsController } from './lib/settings.js'

/** Cordis 插件名。 */
export const name = 'decision-model'

/** 需要的宿主服务。 */
export const inject = ['tools', 'systemPrompt']

const LOG = '[decision-model]'

const DEFAULTS = {
  endpoint: DEFAULT_ENDPOINT,
  model: DEFAULT_MODEL,
  apiKey: '',
  apiKeyEnv: 'OPENROUTER_DECISION_API_KEY',
  timeoutMs: 20000,
  gateTimeoutMs: 10000,
  toolName: 'decision',
  mode: 'advisory',
  threshold: 0.5,
  onError: 'allow',
  promptSection: true,
  maxStateChars: 4000,
  gatedTools: DEFAULT_GATED_TOOLS,
}

/**
 * schemastery 拿不到时为 undefined —— loader 跳过低配校验，插件照常加载。
 * 字段由 cordis.patch.yml 的 config 提供；每个字段都有 DEFAULTS 兜底。
 */
const z = await loadSchemastery()
export const Config = z
  ? z.object({
      endpoint: z.string().default(DEFAULTS.endpoint),
      model: z.string().default(DEFAULTS.model),
      apiKey: z.string().default('').role('secret'),
      apiKeyEnv: z.string().default(DEFAULTS.apiKeyEnv),
      timeoutMs: z.natural().default(DEFAULTS.timeoutMs),
      gateTimeoutMs: z.natural().default(DEFAULTS.gateTimeoutMs),
      toolName: z.string().default(DEFAULTS.toolName),
      mode: z.string().default(DEFAULTS.mode),
      threshold: z.number().default(DEFAULTS.threshold),
      onError: z.string().default(DEFAULTS.onError),
      promptSection: z.boolean().default(DEFAULTS.promptSection),
      maxStateChars: z.natural().default(DEFAULTS.maxStateChars),
      gatedTools: z.array(z.string()).default([...DEFAULTS.gatedTools]),
    })
  : undefined

/**
 * 把行配置收敛成运行时配置。
 * @param {unknown} config
 * @returns {typeof DEFAULTS}
 */
function resolveConfig(config) {
  const raw = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const text = (value, fallback) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback)
  const finite = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)
  const mode = ['off', 'advisory', 'enforce'].includes(raw.mode) ? raw.mode : DEFAULTS.mode
  // 省略 gatedTools = 用默认清单；显式传 [] = 不门禁任何工具（彻底关闭用 mode: "off"）。
  const gated = Array.isArray(raw.gatedTools)
    ? raw.gatedTools.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
    : [...DEFAULTS.gatedTools]
  return {
    endpoint: text(raw.endpoint, DEFAULTS.endpoint),
    model: text(raw.model, DEFAULTS.model),
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : DEFAULTS.apiKey,
    apiKeyEnv: text(raw.apiKeyEnv, DEFAULTS.apiKeyEnv),
    timeoutMs: Math.max(1000, Math.floor(finite(raw.timeoutMs, DEFAULTS.timeoutMs))),
    gateTimeoutMs: Math.max(1000, Math.floor(finite(raw.gateTimeoutMs, DEFAULTS.gateTimeoutMs))),
    toolName: text(raw.toolName, DEFAULTS.toolName),
    mode,
    threshold: Math.min(1, Math.max(0, finite(raw.threshold, DEFAULTS.threshold))),
    onError: raw.onError === 'deny' ? 'deny' : 'allow',
    promptSection: raw.promptSection !== false,
    maxStateChars: Math.max(200, Math.floor(finite(raw.maxStateChars, DEFAULTS.maxStateChars))),
    gatedTools: gated,
  }
}

/**
 * 注册插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} config
 */
export function apply(ctx, config) {
  const cfg = resolveConfig(config)
  const logger = ctx.logger
  const settings = createSettingsController(ctx, cfg)
  const resolveKey = () => settings.resolveKey()

  // ── 1. decision 工具 ─────────────────────────────────────────────────────
  try {
    ctx.tools.register(decisionToolDefinition(cfg, resolveKey))
  } catch (error) {
    logger?.error?.(`${LOG} 注册工具 ${cfg.toolName} 失败：${error?.message ?? error}`)
  }

  // ── 2. 调度前自动裁决 ────────────────────────────────────────────────────
  if (cfg.mode !== 'off' && cfg.gatedTools.length > 0) registerGate(ctx, cfg, logger, resolveKey)

  // ── 3. 系统提示词 ────────────────────────────────────────────────────────
  if (cfg.promptSection) {
    ctx.systemPrompt.section({
      name: 'decision-model',
      order: 3150,
      // 提示词里出现字面量 `{{…}}` 会让整次装配抛错，这里明确关闭插值。
      interpolate: false,
      text: buildPromptText(cfg),
    })
  }

  logger?.info?.(`${LOG} 已就绪：tool=${cfg.toolName} mode=${cfg.mode} model=${cfg.model} settings=插件设置页`)
}

/* ── decision 工具 ──────────────────────────────────────────────────────── */

/**
 * @param {ReturnType<typeof resolveConfig>} cfg
 * @returns {import('@deepseek-ai/dsh-tools').ToolDefinition}
 */
function decisionToolDefinition(cfg, resolveKey) {
  return {
    name: cfg.toolName,
    description:
      '让 JEV 类决策模型对一个待决策情境给出概率化判断。传 state（当前上下文：字符串，或对象/数组）'
      + '和 questions（1~12 个问题：noul 问是/否概率、choice 在 criteria 里选一个、score 按 criteria 等级打分）。'
      + '返回每个问题的概率/等级/置信度，以及模型名和本次调用成本。'
      + '适合方案取舍、风险评级、委派前的清晰度判断；模型不可用时它会报错，不要把它当唯一依据。',
    parameters: {
      type: 'object',
      properties: {
        state: {
          description: '待决策的状态：把目标、约束、已知事实、候选方案写进去；对象/数组会原样发送。',
          anyOf: [
            { type: 'string' },
            { type: 'object', additionalProperties: true },
            { type: 'array', items: {} },
          ],
        },
        questions: {
          type: 'object',
          description:
            '要问的问题：{ 问题ID: { type, instructions, criteria? } }。'
            + 'noul 不需要 criteria；choice 的 criteria 是 { 选项: 说明|null }（至少 2 个）；'
            + 'score 的 criteria 是从低到高的级别名数组（至少 2 级）。',
          additionalProperties: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['noul', 'choice', 'score'] },
              instructions: { type: 'string' },
              criteria: {},
            },
            required: ['type', 'instructions'],
          },
        },
        model: {
          type: 'string',
          description: `可选：覆盖默认决策模型（默认 ${cfg.model}）。`,
        },
      },
      required: ['state', 'questions'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          summary: { type: 'string' },
          model: { type: 'string' },
          answers: { type: 'object', additionalProperties: true },
        },
        additionalProperties: true,
      },
      render(_args, value) {
        const summary = typeof value?.summary === 'string' ? value.summary : safeJson(value)
        return [{ type: 'text', text: summary }]
      },
    },
    timeoutMs: Math.max(15000, cfg.timeoutMs + 5000),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = args && typeof args === 'object' ? args : {}
      const questions = normalizeQuestions(input.questions)
      const state = normalizeState(input.state, cfg.maxStateChars)
      const requestedModel = typeof input.model === 'string' && input.model.trim() !== ''
        ? input.model.trim()
        : cfg.model

      let decision
      try {
        decision = await callDecisionModel({
          endpoint: cfg.endpoint,
          apiKey: await resolveKey(),
          model: requestedModel,
          state,
          questions,
          timeoutMs: cfg.timeoutMs,
          signal: exec?.signal,
        })
      } catch (error) {
        if (error instanceof DeciderError) {
          throw new Error(`决策模型调用失败（${error.code}）：${error.message}`)
        }
        throw error
      }

      return {
        ok: true,
        model: decision.model,
        provider: decision.provider,
        request_id: decision.id,
        usage: decision.usage,
        answers: decision.answers,
        summary: summarizeAnswers(decision, questions),
      }
    },
  }
}

/* ── 调度前裁决 ─────────────────────────────────────────────────────────── */

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {ReturnType<typeof resolveConfig>} cfg
 * @param {any} logger
 */
function registerGate(ctx, cfg, logger, resolveKey) {
  const gated = new Set(cfg.gatedTools)
  /** callId -> 裁决意见；只在「已裁决但还未到 post-execute」之间短暂存在。 */
  const adviceByCall = new Map()

  const remember = (callId, advice) => {
    if (callId === undefined || callId === null) return
    adviceByCall.set(String(callId), advice)
    if (adviceByCall.size > 64) {
      const oldest = adviceByCall.keys().next().value
      if (oldest !== undefined) adviceByCall.delete(oldest)
    }
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!exec || !gated.has(exec.name)) return next()

    const upstream = await next()
    if (upstream?.kind !== 'allow') return upstream

    let decision
    try {
      decision = await callDecisionModel({
        endpoint: cfg.endpoint,
        apiKey: await resolveKey(),
        model: cfg.model,
        state: buildGateState(exec.name, exec.arguments, cfg.maxStateChars),
        questions: buildGateQuestions(exec.name),
        timeoutMs: cfg.gateTimeoutMs,
        signal: exec.signal,
      })
    } catch (error) {
      const problem = error instanceof DeciderError
        ? `${error.code}: ${error.message}`
        : String(error?.message ?? error)
      logger?.warn?.(`${LOG} 调度前裁决不可用（${problem}）；mode=${cfg.mode} onError=${cfg.onError}`)
      if (cfg.mode === 'enforce' && cfg.onError === 'deny') {
        return {
          kind: 'deny',
          reason: `决策模型不可用（${problem}）。enforce 模式按 onError=deny 拒绝本次「${exec.name}」调度。`,
          info: { name: LOG, code: 'DECISION_UNAVAILABLE' },
        }
      }
      return upstream
    }

    const gate = evaluateGate(decision, { threshold: cfg.threshold })
    const advice = formatGateAdvice(exec.name, decision, gate)
    logger?.info?.(`${LOG} 调度前裁决 ${exec.name}：clarity=${gate.clarity} route=${gate.route} blocked=${gate.blocked}`)

    if (cfg.mode === 'enforce' && gate.blocked) {
      return {
        kind: 'deny',
        reason: `${advice}\n\n（decision-model enforce 模式：本次调度已拦下。请先补齐上下文、缩小任务或拆分后再重试。）`,
        info: { name: LOG, code: 'DECISION_GATE' },
      }
    }

    remember(exec.callId, advice)
    return upstream
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const key = exec?.callId === undefined || exec?.callId === null ? null : String(exec.callId)
    const advice = key === null ? undefined : adviceByCall.get(key)
    try {
      const upstream = await next()
      if (advice === undefined || upstream?.kind !== 'accept') return upstream
      const block = { type: 'text', text: `\n\n${advice}` }
      if (Array.isArray(upstream.content)) {
        return { ...upstream, kind: 'accept', content: [...upstream.content, block] }
      }
      if (upstream.value !== undefined) {
        // 下游插件把结果改写成结构化 value（accept 的 value/content 互斥），
        // 无法同时追加文本；明确记一条日志，避免意见静默丢失。
        logger?.warn?.(`${LOG} 调度前裁决意见无法附加：下游把结果改写为 value，已跳过`)
        return upstream
      }
      const base = Array.isArray(result?.content) ? result.content : []
      return { ...upstream, kind: 'accept', content: [...base, block] }
    } finally {
      if (key !== null) adviceByCall.delete(key)
    }
  })
}

/* ── 系统提示词 ─────────────────────────────────────────────────────────── */

/**
 * @param {ReturnType<typeof resolveConfig>} cfg
 * @returns {string}
 */
function buildPromptText(cfg) {
  const lines = [
    '## 决策模型（`decision` 工具）',
    '需要概率化判断时，先调用 `decision` 再行动，典型场景：',
    '- 调用 subagent / spawn_teammate / workflow 等调度工具之前，任务边界、规模或是否拆分还不确定；',
    '- 几个方案各有优劣，需要按概率取舍，而不是凭直觉定一个；',
    '- 需要给方案、风险或完成度打一个等级分。',
    '把返回的概率、等级和置信度当作参考信号：置信度低时结合你自己的判断；模型不可用时会报错，继续按你的判断执行，不要卡住。',
  ]
  if (cfg.mode !== 'off') {
    lines.push(
      '本插件还会在调度类工具真正执行前自动咨询一次决策模型：advisory 模式下裁决意见附在调度结果之后；'
      + 'enforce 模式下清晰度低于阈值时该次调度会被直接拦下，请先补齐上下文或拆分任务再重试。',
    )
  }
  return lines.join('\n')
}

export { MAX_QUESTIONS }
