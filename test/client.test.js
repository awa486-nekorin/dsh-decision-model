import assert from 'node:assert/strict'
import test from 'node:test'

test('client half registers a localized settings tab with object injection', async () => {
  let registered
  const loaded = []
  globalThis.window = {
    __ModuleLoader__: {
      load(definition) { loaded.push(definition) },
    },
  }
  await import('../client.js?settings-ui-test')
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0].id, '@local/decision-model')

  const React = { createElement: () => null, useState: () => [undefined, () => {}], useEffect: () => {}, useCallback: (fn) => fn }
  const module = loaded[0].factory(() => React)
  assert.deepEqual(module.inject, ['slots', 'locale', 'remote', 'remote.credentials'])

  const ctx = {
    locale: {
      bind: () => (key) => key,
      register: () => () => {},
    },
    effect(fn) { fn() },
    slots: {
      inject(name, callback) {
        assert.equal(name, 'settings.plugins.tab')
        callback()
      },
      register(options, component) {
        registered = { options, component }
        return () => {}
      },
    },
  }
  module.apply(ctx)
  assert.equal(registered.options.id, 'decision-model')
  assert.equal(registered.options.order, 30)
  assert.equal(registered.options.locale, 'settings.decisionModel')
  assert.equal(typeof registered.options.label(), 'string')
  const injected = registered.options.inject()
  assert.equal(typeof injected, 'object')
  assert.equal(injected.ctx, ctx)
  assert.equal(typeof injected.t, 'function')
  delete globalThis.window
})
