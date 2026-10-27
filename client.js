window.__ModuleLoader__.load({
  id: '@local/decision-model',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const DICT = {
      zh: {
        title: '决策模型 API', keyLabel: 'OpenRouter API Key', keyPlaceholder: '粘贴 API Key',
        save: '保存密钥', clear: '清除已保存密钥', test: '测试连接', configured: '已配置', missing: '未配置',
        source: '来源', writable: '可由此页面管理', readonly: '由环境提供，不能在此修改',
        model: '模型', endpoint: '接口', saved: '密钥已安全保存。', cleared: '已清除托管密钥。',
        savedKey: '密钥不会再次显示。', testOk: '连接成功', testing: '正在测试…',
        errorMissingKey: '请先输入并保存 API Key，或为本进程配置环境变量。',
        errorInvalidKey: 'API Key 无效或已过期。',
        errorUpstreamRateLimit: '上游服务限流，请稍后重试。',
        errorTimeout: '请求超时。',
        errorNetwork: '无法连接上游服务。',
        errorUpstreamError: '上游服务返回错误。',
        errorRateLimited: '操作过于频繁，请稍后再试。',
        errorInvalidKeyFormat: 'API Key 格式不正确。',
        errorBadRequest: '请求格式无效。',
        errorUnknown: '请求失败，请稍后重试。',
        confirmClear: '清除保存的 API Key？这不会影响环境变量中的密钥。',
      },
      en: {
        title: 'Decision Model API', keyLabel: 'OpenRouter API Key', keyPlaceholder: 'Paste API key',
        save: 'Save key', clear: 'Clear saved key', test: 'Test connection', configured: 'Configured', missing: 'Not configured',
        source: 'Source', writable: 'Managed here', readonly: 'Provided by environment; not editable here',
        model: 'Model', endpoint: 'Endpoint', saved: 'Key stored securely.', cleared: 'Managed key cleared.',
        savedKey: 'The key will not be shown again.', testOk: 'Connection successful', testing: 'Testing…',
        errorMissingKey: 'Enter and save an API key, or configure the process environment.',
        errorInvalidKey: 'The API key is invalid or expired.',
        errorUpstreamRateLimit: 'The upstream service is rate limiting requests.',
        errorTimeout: 'The request timed out.',
        errorNetwork: 'Could not reach the upstream service.',
        errorUpstreamError: 'The upstream service returned an error.',
        errorRateLimited: 'Please wait before trying again.',
        errorInvalidKeyFormat: 'The API key format is invalid.',
        errorBadRequest: 'The request was invalid.',
        errorUnknown: 'The request failed. Try again.',
        confirmClear: 'Clear the saved API key? This does not affect environment credentials.',
      },
    }
    const ERROR_KEYS = {
      'missing-key': 'errorMissingKey',
      'invalid-key': 'errorInvalidKey',
      'upstream-rate-limit': 'errorUpstreamRateLimit',
      timeout: 'errorTimeout',
      network: 'errorNetwork',
      'upstream-error': 'errorUpstreamError',
      'rate-limited': 'errorRateLimited',
      'invalid-key-format': 'errorInvalidKeyFormat',
      'bad-request': 'errorBadRequest',
    }
    const css = {
      root: { maxWidth: 720, padding: '24px 28px', color: 'var(--dsw-alias-label-primary)', font: 'inherit' },
      heading: { fontSize: 18, fontWeight: 600, margin: '0 0 22px' },
      section: { borderTop: '1px solid var(--dsw-alias-border-l1)', padding: '18px 0' },
      label: { display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 8 },
      field: { display: 'flex', gap: 8, flexWrap: 'wrap' },
      input: { flex: '1 1 320px', minWidth: 0, height: 38, boxSizing: 'border-box', padding: '0 10px', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 4, font: 'inherit' },
      button: { minHeight: 36, padding: '0 14px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 4, color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-1)', cursor: 'pointer', font: 'inherit' },
      primary: { borderColor: 'var(--dsw-alias-brand-primary)', background: 'var(--dsw-alias-brand-primary)', color: 'white' },
      meta: { marginTop: 10, color: 'var(--dsw-alias-label-secondary)', fontSize: 13, lineHeight: 1.6, overflowWrap: 'anywhere' },
      feedback: { marginTop: 12, fontSize: 13, lineHeight: 1.5 },
    }

    function SettingsPage({ ctx, t }) {
      const [status, setStatus] = React.useState(null)
      const [draft, setDraft] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [message, setMessage] = React.useState(null)
      const [messageError, setMessageError] = React.useState(false)
      const say = (text, failed = false) => { setMessage(text); setMessageError(failed) }
      const refresh = React.useCallback(async () => {
        try {
          const response = await window.fetch('/api/decision-model/status', { credentials: 'same-origin', cache: 'no-store' })
          if (!response.ok) throw new Error('unknown')
          const next = await response.json()
          setStatus(next)
        } catch { say(t('errorUnknown'), true) }
      }, [t])
      React.useEffect(() => { refresh() }, [refresh])
      const save = async () => {
        if (!status?.ref || !draft.trim() || draft.length > 4096 || !/^sk-or-v1-[A-Za-z0-9_-]{32,}$/.test(draft.trim())) {
          say(t('errorInvalidKeyFormat'), true); return
        }
        setBusy(true); setMessage(null)
        try {
          const result = await ctx.remote.credentials.set(status.ref, draft.trim())
          if (result && result.ok === false) throw new Error(result.error?.code ?? 'credential-rejected')
          setDraft(''); await refresh(); say(`${t('saved')} ${t('savedKey')}`)
        } catch { say(t('errorUnknown'), true) }
        finally { setBusy(false) }
      }
      const clear = async () => {
        if (!status?.ref || !window.confirm(t('confirmClear'))) return
        setBusy(true); setMessage(null)
        try {
          const result = await ctx.remote.credentials.unset(status.ref)
          if (result && result.ok === false) throw new Error(result.error?.code ?? 'credential-rejected')
          await refresh(); say(t('cleared'))
        } catch { say(t('errorUnknown'), true) }
        finally { setBusy(false) }
      }
      const test = async () => {
        setBusy(true); setMessage(null)
        try {
          const response = await window.fetch('/api/decision-model/test', {
            method: 'POST', credentials: 'same-origin', cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ apiKey: draft.trim() }),
          })
          const result = await response.json()
          if (!result.ok) throw new Error(result.error || 'unknown')
          say(`${t('testOk')} · ${result.model} · ${result.latencyMs} ms`)
        } catch (error) {
          const kind = typeof error?.message === 'string' && Object.hasOwn(ERROR_KEYS, error.message) ? error.message : 'unknown'
          say(t(ERROR_KEYS[kind] ?? 'errorUnknown'), true)
        } finally { setBusy(false) }
      }
      const sourceText = (source) => ({ stored: 'credential store', credential: 'credential provider', environment: 'environment', 'legacy-config': 'legacy configuration', missing: '—' })[source] || source || '—'
      return h('div', { style: css.root },
        h('h2', { style: css.heading }, t('title')),
        h('section', { style: css.section },
          h('label', { htmlFor: 'decision-model-key', style: css.label }, t('keyLabel')),
          h('div', { style: css.field },
            h('input', { id: 'decision-model-key', type: 'password', autoComplete: 'new-password', spellCheck: false, maxLength: 4096, value: draft,
              placeholder: t('keyPlaceholder'), onChange: (event) => setDraft(event.target.value), style: css.input, disabled: busy }),
            h('button', { type: 'button', style: { ...css.button, ...css.primary }, onClick: save, disabled: busy || !draft.trim() || Boolean(status && !status.writable) }, t('save')),
            h('button', { type: 'button', style: css.button, onClick: clear, disabled: busy || !status?.writable }, t('clear')),
            h('button', { type: 'button', style: css.button, onClick: test, disabled: busy }, busy ? t('testing') : t('test'))),
          h('div', { style: css.meta },
            `${t('source')}: ${status ? sourceText(status.source) : '…'} · `,
            status?.configured ? t('configured') : t('missing'),
            status && !status.writable && status.configured ? ` · ${t('readonly')}` : status?.writable ? ` · ${t('writable')}` : '',
            status ? h('div', null, `${t('model')}: ${status.model}`, h('br'), `${t('endpoint')}: ${status.endpoint}`) : null),
          message ? h('div', { role: 'status', style: { ...css.feedback, color: messageError ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)' } }, message) : null))
    }

    return {
      inject: ['slots', 'locale', 'remote', 'remote.credentials'],
      apply(ctx) {
        const t = ctx.locale.bind('settings.decisionModel')
        const injected = () => ({ ctx, t })
        ctx.effect(() => ctx.locale.register('settings.decisionModel', DICT), 'decision-model: settings locale')
        // Top-level Settings entry: visible in both the Desktop app and the Web GUI.
        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'decision-model', order: 45,
          label: () => t('title'), locale: 'settings.decisionModel',
          inject: injected,
        }, SettingsPage)), 'decision-model: settings section')
        // Also keep the Plugins-page entry for users who manage plugins there.
        ctx.effect(() => ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
          name: 'settings.plugins.tab', id: 'decision-model', order: 30,
          label: () => t('title'), locale: 'settings.decisionModel',
          inject: injected,
        }, SettingsPage)), 'decision-model: plugins tab')
      },
    }
  },
})
