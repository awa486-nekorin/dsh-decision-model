import { callDecisionModel, resolveApiKey } from './decider.js'

export const STATUS_PATH = '/api/decision-model/status'
export const TEST_PATH = '/api/decision-model/test'
const MIN_TEST_INTERVAL_MS = 3000
const NO_CACHE = { 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'" }

function json(value, status = 200) {
  return Response.json(value, { status, headers: NO_CACHE })
}

function safeSource(source) {
  const text = String(source ?? '').toLowerCase()
  if (text.includes('env')) return 'environment'
  if (text.includes('file') || text.includes('stored') || text.includes('local')) return 'stored'
  return 'credential'
}

/**
 * The browser may set a credential, but it can never read its value back.
 * A legacy config key is migrated only when the reference is unconfigured.
 */
export function createSettingsController(ctx, cfg, options = {}) {
  // Cordis services can mount after this plugin's apply; never cache the
  // credential service, or a late provider makes every lookup miss forever.
  const credentialsOf = () => ctx.get?.('credentials')
  const connection = ctx.get?.('connection')
  const logger = ctx.logger
  const ref = cfg.apiKeyEnv
  const call = options.call ?? callDecisionModel
  let lastTestAt = 0
  let testing = false

  const migration = (async () => {
    const credentials = credentialsOf()
    if (!credentials || !cfg.apiKey?.trim()) return false
    const info = await credentials.describe(ref)
    if (info.configured && !String(info.source ?? '').toLowerCase().includes('env')) return false
    await credentials.set(ref, cfg.apiKey.trim())
    logger?.info?.('[decision-model] legacy key moved to credential provider')
    return true
  })().catch(() => {
    logger?.warn?.('[decision-model] legacy credential migration unavailable; keeping existing config fallback')
    return false
  })

  async function resolveKey() {
    await migration
    const credentials = credentialsOf()
    if (credentials) {
      try {
        const entry = await credentials.resolve(ref)
        if (typeof entry?.value === 'string' && entry.value.trim()) return entry.value.trim()
      } catch {
        logger?.warn?.('[decision-model] credential lookup unavailable; checking legacy fallback')
      }
    }
    return resolveApiKey(cfg)
  }

  async function status() {
    await migration
    const credentials = credentialsOf()
    let info
    if (credentials) {
      try { info = await credentials.describe(ref) } catch { /* Report unavailable without leaking provider details. */ }
    }
    return {
      configured: Boolean(info?.configured || cfg.apiKey?.trim() || process.env[ref]?.trim()),
      source: info?.configured ? safeSource(info.source) : cfg.apiKey?.trim() ? 'legacy-config' : process.env[ref]?.trim() ? 'environment' : 'missing',
      writable: Boolean(info?.writable),
      ref,
      endpoint: cfg.endpoint,
      model: cfg.model,
    }
  }

  async function test(overrideKey = '') {
    const now = Date.now()
    if (testing || now - lastTestAt < MIN_TEST_INTERVAL_MS) return { ok: false, error: 'rate-limited', status: 429 }
    lastTestAt = now
    testing = true
    try {
      const apiKey = typeof overrideKey === 'string' && overrideKey.trim() ? overrideKey.trim() : await resolveKey()
      if (!apiKey) return { ok: false, error: 'missing-key', status: 400 }
      const started = Date.now()
      const result = await call({
        endpoint: cfg.endpoint, model: cfg.model, apiKey,
        state: 'DSH decision-model settings connectivity test.',
        questions: { connected: { type: 'noul', instructions: 'This is a connectivity test. Is the decision service responding?' } },
        timeoutMs: Math.min(cfg.timeoutMs, 8000),
      })
      return { ok: true, model: result.model, latencyMs: Date.now() - started, cost: result.usage?.cost ?? null, status: 200 }
    } catch (error) {
      const status = error?.details?.status
      const kind = status === 401 || status === 403 ? 'invalid-key'
        : status === 429 ? 'upstream-rate-limit'
          : error?.code === 'timeout' ? 'timeout'
            : error?.code === 'network' ? 'network'
              : 'upstream-error'
      // Never serialize the upstream response body, request, key, or raw exception.
      return { ok: false, error: kind, status: 502 }
    } finally { testing = false }
  }

  if (connection?.fetch?.register) {
    ctx.effect(() => connection.fetch.register({
      path: STATUS_PATH, methods: ['GET'], requestBody: 'buffered',
      fetch: async () => json(await status()),
    }), 'decision-model: credential status')
    ctx.effect(() => connection.fetch.register({
      path: TEST_PATH, methods: ['POST'], requestBody: 'buffered',
      fetch: async (request) => {
        // Only an authenticated /api caller reaches this route. Bound and validate the transient key body.
        const declared = Number(request.headers.get('content-length') ?? 0)
        if (declared > 8192) return json({ ok: false, error: 'bad-request' }, 400)
        let raw
        try {
          const reader = request.body?.getReader()
          if (!reader) return json({ ok: false, error: 'bad-request' }, 400)
          const parts = []
          let size = 0
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > 8192) { await reader.cancel(); return json({ ok: false, error: 'bad-request' }, 400) }
            parts.push(value)
          }
          const bytes = new Uint8Array(size)
          let offset = 0
          for (const part of parts) { bytes.set(part, offset); offset += part.byteLength }
          raw = JSON.parse(new TextDecoder().decode(bytes))
        } catch { return json({ ok: false, error: 'bad-request' }, 400) }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some((key) => key !== 'apiKey')) {
          return json({ ok: false, error: 'bad-request' }, 400)
        }
        const key = raw.apiKey ?? ''
        if (typeof key !== 'string' || key.length > 4096 || (key !== '' && !/^sk-or-v1-[A-Za-z0-9_-]{32,}$/.test(key))) {
          return json({ ok: false, error: 'invalid-key-format' }, 400)
        }
        const result = await test(key)
        const { status: code, ...body } = result
        return json(body, code)
      },
    }), 'decision-model: connectivity test')
  }

  return { resolveKey, status, test, migration }
}
