import assert from 'node:assert/strict'
import test from 'node:test'

test('client half registers the settings page in both settings slots', async () => {
  const registered = new Map()
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
      inject(name, callback) { callback() },
      register(options, component) {
        registered.set(options.name, { options, component })
        return () => {}
      },
    },
  }
  module.apply(ctx)
  assert.deepEqual([...registered.keys()].sort(), ['settings.plugins.tab', 'settings.section'])

  const section = registered.get('settings.section').options
  assert.equal(section.id, 'decision-model')
  assert.equal(section.order, 45)
  assert.equal(section.locale, 'settings.decisionModel')
  assert.equal(typeof section.label(), 'string')

  const tab = registered.get('settings.plugins.tab').options
  assert.equal(tab.id, 'decision-model')
  assert.equal(tab.order, 30)
  assert.equal(tab.locale, 'settings.decisionModel')
  for (const entry of registered.values()) {
    const injected = entry.options.inject()
    assert.equal(typeof injected, 'object')
    assert.equal(injected.ctx, ctx)
    assert.equal(typeof injected.t, 'function')
    assert.equal(typeof entry.component, 'function')
  }
  delete globalThis.window
})
