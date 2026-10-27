import assert from 'node:assert/strict'
import test from 'node:test'
import { createSettingsController, STATUS_PATH, TEST_PATH } from '../lib/settings.js'

function fakeCtx({ credentials, connection } = {}) {
  const routes = []
  const connectionService = connection ? {
    fetch: { register(route) { routes.push(route); return () => {} } },
  } : undefined
  return {
    logger: { info() {}, warn() {} },
    get(name) { return name === 'credentials' ? credentials : name === 'connection' ? connectionService : undefined },
    effect(fn) { fn() },
    routes,
  }
}

const cfg = {
  endpoint: 'https://example.invalid/decisions', model: 'test/model', apiKey: '',
  apiKeyEnv: 'DECISION_TEST_KEY', timeoutMs: 20000,
}

test('status never includes the credential value', async () => {
  const credentials = {
    async describe() { return { configured: true, source: 'stored-file', writable: true } },
    async resolve() { return { value: 'secret-value', source: 'stored-file' } },
  }
  const ctx = fakeCtx({ credentials })
  const controller = createSettingsController(ctx, cfg)
  const status = await controller.status()
  assert.equal(status.configured, true)
  assert.equal(status.source, 'stored')
  assert.equal(status.writable, true)
  assert.equal(JSON.stringify(status).includes('secret-value'), false)
})

test('connectivity test uses the resolved credential and returns no key material', async () => {
  const credentials = { async resolve() { return { value: 'secret-value' } } }
  let received
  const controller = createSettingsController(fakeCtx({ credentials }), cfg, {
    call: async (options) => {
      received = options
      return { model: 'test/model-1', usage: { cost: 0.1 } }
    },
  })
  const result = await controller.test()
  assert.equal(result.ok, true)
  assert.equal(received.apiKey, 'secret-value')
  assert.equal(JSON.stringify(result).includes('secret-value'), false)
})

test('connectivity test accepts a transient key without persisting it', async () => {
  let received
  const controller = createSettingsController(fakeCtx(), cfg, {
    call: async (options) => { received = options; return { model: 'test/model-1', usage: {} } },
  })
  const result = await controller.test('sk-or-v1-' + 'a'.repeat(36))
  assert.equal(result.ok, true)
  assert.match(received.apiKey, /^sk-or-v1-/)
})

test('upstream failures are mapped to fixed codes without response bodies', async () => {
  const controller = createSettingsController(fakeCtx(), cfg, {
    call: async () => { throw Object.assign(new Error('raw upstream text'), { details: { status: 401, body: 'secret echo' } }) },
  })
  const result = await controller.test('sk-or-v1-' + 'a'.repeat(36))
  assert.deepEqual(result, { ok: false, error: 'invalid-key', status: 502 })
})

test('connective tests are rate limited', async () => {
  const controller = createSettingsController(fakeCtx(), cfg, {
    call: async () => ({ model: 'test/model-1', usage: {} }),
  })
  const key = 'sk-or-v1-' + 'a'.repeat(36)
  assert.equal((await controller.test(key)).ok, true)
  assert.equal((await controller.test(key)).error, 'rate-limited')
})

test('registers authenticated status and test routes', () => {
  const ctx = fakeCtx({ connection: {} })
  createSettingsController(ctx, cfg)
  assert.deepEqual(ctx.routes.map((route) => [route.path, route.methods]), [
    [STATUS_PATH, ['GET']],
    [TEST_PATH, ['POST']],
  ])
})

test('resolves the stored credential before the config fallback', async () => {
  const credentials = { async resolve() { return { value: 'stored-key' } } }
  const controller = createSettingsController(fakeCtx({ credentials }), { ...cfg, apiKey: 'config-key' })
  assert.equal(await controller.resolveKey(), 'stored-key')
})

test('migrates a legacy config key only when no credential is configured', async () => {
  const writes = []
  const credentials = {
    async describe() { return { configured: false, writable: true } },
    async set(ref, value) { writes.push([ref, value]) },
    async resolve() { return { value: writes[0]?.[1] } },
  }
  const controller = createSettingsController(fakeCtx({ credentials }), { ...cfg, apiKey: 'legacy-key' })
  assert.equal(await controller.resolveKey(), 'legacy-key')
  assert.deepEqual(writes, [['DECISION_TEST_KEY', 'legacy-key']])
})
