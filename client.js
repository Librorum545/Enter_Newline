/**
 * Browser half of the bundle.
 *
 * 1. Composer key remap, driven by a per-gesture binding the Settings page
 *    edits:
 *      Enter          (default: line break)
 *      Ctrl/Cmd+Enter (default: steer)
 *      Shift+Enter    (default: queue)
 *
 *    Every gesture resolves to one of three actions: insert a line break,
 *    steer (join the running turn), or queue (wait for the turn to finish).
 *    The actions replay into the composer's own event path, so its keymap, IME
 *    guard, menu arbitration, undo history and submit policy stay authoritative:
 *    - a line break becomes a Shift+Enter keydown; the composer's keymap leaves
 *      Shift+Enter to Lexical's plain-text plugin, which inserts the break node
 *      inside that same keydown.
 *    - a send becomes a plain Enter keydown (the composer's preferred delivery)
 *      or a Ctrl+Enter keydown (its opposite), chosen from the live busy-send
 *      preference: the composer resolves plain Enter to the preferred mode and
 *      the accelerated chord to the other one.
 *
 *    Only one event is dispatched per gesture: adding a second insertion path
 *    (for example a synthetic `beforeinput`) inserts a second line break, because
 *    Lexical commits the keydown-path DOM update after the dispatch returns.
 *
 * 2. Settings page ("Enter 换行"): three gestures, one select each, plus Save
 *    and Discard. Saving refuses a mapping with no line-break key and one where
 *    every key breaks the line, because either leaves the composer unusable.
 *    The page is a `settings.section` this plugin owns; the built-in "busy send"
 *    row belongs to ui-conversation and its copy cannot be replaced by another
 *    plugin, so the explanation lives here.
 *
 *    Bindings persist in localStorage (`composer-enter-newline:bindings:v1`):
 *    a key map belongs to the browser that presses the keys, not to the shared
 *    settings document.
 */
window.__ModuleLoader__.load({
  id: '@local/composer-enter-newline',
  factory(require) {
    const React = require('react')
    const { useState } = React
    const h = React.createElement

    /** The composer's Lexical contenteditable host (rendered with this marker). */
    const COMPOSER_SELECTOR = '[data-composer-input]'
    /** The completion popups ("/" commands, "@" references) carry the listbox role. */
    const MENU_SELECTOR = '[role="listbox"]'
    /** Replayed events, so the capture listener ignores its own dispatches. */
    const replayed = new WeakSet()

    // --- bindings -----------------------------------------------------------

    /** Storage key for the saved key map. */
    const STORAGE_KEY = 'composer-enter-newline:bindings:v1'
    /** Actions a gesture can perform. */
    const ACTIONS = ['newline', 'steer', 'queue']
    /** Gestures the page configures, in display order. */
    const GESTURES = [
      { id: 'enter', keyCap: 'Enter' },
      { id: 'ctrlEnter', keyCap: 'Ctrl/Cmd+Enter' },
      { id: 'shiftEnter', keyCap: 'Shift+Enter' },
    ]
    /** Factory default: Enter breaks the line, Ctrl/Cmd+Enter steers, Shift+Enter queues. */
    const DEFAULT_BINDINGS = Object.freeze({ enter: 'newline', ctrlEnter: 'steer', shiftEnter: 'queue' })

    /**
     * Keep only known gestures and actions, filling the rest from the defaults.
     * @param raw - whatever the storage or a draft holds.
     * @returns a complete, valid binding map.
     */
    function normalizeBindings(raw) {
      const next = { ...DEFAULT_BINDINGS }
      if (raw !== null && typeof raw === 'object') {
        for (const gesture of GESTURES) {
          const value = raw[gesture.id]
          if (ACTIONS.includes(value)) next[gesture.id] = value
        }
      }
      return next
    }

    /**
     * @returns whether two binding maps agree on every configured gesture.
     * @param a - one map.
     * @param b - the other map.
     */
    function sameBindings(a, b) {
      return GESTURES.every(gesture => a[gesture.id] === b[gesture.id])
    }

    /**
     * @returns the saved bindings, or the defaults when storage is unavailable.
     */
    function readBindings() {
      try {
        return normalizeBindings(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null'))
      } catch {
        return { ...DEFAULT_BINDINGS }
      }
    }

    /**
     * Persist a binding map and make it live for the next keystroke.
     * @param next - the map to save.
     * @returns the saved map.
     */
    function writeBindings(next) {
      bindings = normalizeBindings(next)
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings))
      } catch {
        // Private mode or a disabled store: the mapping still applies this session.
      }
      return bindings
    }

    /** Live binding map the keydown listener reads. */
    let bindings = readBindings()

    // --- composer key remap -------------------------------------------------

    /** Conversation config form, read for the live busy-send preference. */
    let conversationForm = null

    /**
     * The behavior the composer gives plain Enter: its busy-send preference.
     * @returns 'steer' or 'queue'; queue matches the shipped default.
     */
    function preferredBusyBehavior() {
      let value
      try {
        value = conversationForm?.getSnapshot()?.value
      } catch {
        value = undefined
      }
      return value?.busyEnter === 'steer' ? 'steer' : 'queue'
    }

    /**
     * @returns the composer root containing the keydown target, if any.
     * @param node - the keydown target.
     */
    function composerRoot(node) {
      if (!(node instanceof Element)) return null
      return node.closest(COMPOSER_SELECTOR)
    }

    /**
     * @returns whether a completion popup is visibly open.
     */
    function completionMenuOpen() {
      for (const menu of document.querySelectorAll(MENU_SELECTOR)) {
        if (menu.getClientRects().length > 0) return true
      }
      return false
    }

    /**
     * Dispatch one replayed event on the composer.
     * @param composer - the composer root that owns the gesture.
     * @param event - the event to dispatch.
     * @returns the dispatched event.
     */
    function dispatchReplay(composer, event) {
      replayed.add(event)
      composer.dispatchEvent(event)
      return event
    }

    /**
     * Insert a soft line break through the composer's own Enter path.
     * @param composer - the composer root that owns the caret.
     */
    function insertLineBreak(composer) {
      dispatchReplay(composer, new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
        cancelable: true,
        composed: true,
        shiftKey: true,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
      }))
    }

    /**
     * Replay an Enter keydown so the composer's submit gesture runs.
     * @param event - the user's Enter keydown.
     * @param composer - the composer root that owns the gesture.
     * @param accelerated - true for the Ctrl/Cmd chord (the composer's opposite delivery mode).
     */
    function submitDraft(event, composer, accelerated) {
      dispatchReplay(composer, new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
        cancelable: true,
        composed: true,
        shiftKey: false,
        ctrlKey: accelerated,
        metaKey: false,
        altKey: false,
        repeat: event.repeat,
      }))
    }

    /**
     * Run one configured action on the composer.
     * @param action - 'newline', 'steer' or 'queue'.
     * @param event - the user's keydown, for its repeat flag.
     * @param composer - the composer root that owns the gesture.
     */
    function runAction(action, event, composer) {
      if (action === 'newline') {
        insertLineBreak(composer)
        return
      }
      // Plain Enter delivers the preferred mode; the chord delivers the other one.
      submitDraft(event, composer, preferredBusyBehavior() !== action)
    }

    /**
     * @param event - any keydown seen on the window capture phase.
     */
    function onKeyDown(event) {
      if (replayed.has(event)) return
      if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return
      const composer = composerRoot(event.target)
      if (composer === null) return
      // An IME composition owns this Enter (candidate pick), and a read-only
      // composer refuses input: let the composer handle both unchanged.
      if (composer.hasAttribute('data-composer-composing') || !composer.isContentEditable) return
      if (event.altKey) return
      if (typeof event.getModifierState === 'function' && event.getModifierState('AltGraph')) return
      // Both primary modifiers, or a primary modifier plus Shift, keep their
      // zero behavior in the composer.
      if (event.ctrlKey && event.metaKey) return
      const chord = event.ctrlKey || event.metaKey
      if (chord && event.shiftKey) return
      const gesture = chord ? 'ctrlEnter' : event.shiftKey ? 'shiftEnter' : 'enter'
      // An open completion menu owns Enter (pick the highlight), as before.
      if (completionMenuOpen()) return
      const action = bindings[gesture]
      // Shift+Enter mapped to a line break is already the composer's behavior.
      if (gesture === 'shiftEnter' && action === 'newline') return
      event.preventDefault()
      event.stopImmediatePropagation()
      runAction(action, event, composer)
    }

    // --- settings page ------------------------------------------------------

    /** Locale namespace owned by this plugin (settings copy only). */
    const NS = 'composer-enter-newline'

    const DICT = {
      zh: {
        'nav': 'Enter 换行',
        'page.title': 'Enter 换行',
        'action.newline': '插入换行',
        'action.steer': '插话发送',
        'action.queue': '排队发送',
        'select.aria': '{key} 按键行为',
        'button.save': '保存',
        'button.discard': '放弃',
        'status.saved': '已保存',
        'error.noNewline': '至少要有一个按键用于插入换行，否则草稿无法换行。',
        'error.allNewline': '三个按键都设为插入换行，将无法用键盘发送草稿。',
        'note': '插话与排队只在智能体运行时不同：插话立即进入当前回合，排队等本轮结束；空闲时两者都直接发送。补全菜单打开时 Enter 仍用于选中候选项，输入法组合中的 Enter 交给输入法。在 设置 → 插件 中禁用「Enter 换行」即可恢复原生行为。',
      },
      en: {
        'nav': 'Enter newline',
        'page.title': 'Enter newline',
        'action.newline': 'Insert line break',
        'action.steer': 'Steer',
        'action.queue': 'Queue',
        'select.aria': '{key} behavior',
        'button.save': 'Save',
        'button.discard': 'Discard',
        'status.saved': 'Saved',
        'error.noNewline': 'At least one key must insert a line break, or the draft can never break a line.',
        'error.allNewline': 'All three keys insert a line break, so the draft could never be sent from the keyboard.',
        'note': 'Steer and Queue differ only while an agent runs: Steer joins the running turn, Queue waits for it to finish, and both just send while idle. An open completion menu keeps Enter for picking items, and Enter inside an IME composition stays with the IME. Disable "Enter newline" under Settings → Plugins to restore the native behavior.',
      },
    }

    /** Gestures in display order, with the option list every row shares. */
    const ACTION_OPTIONS = [
      { value: 'newline', key: 'action.newline' },
      { value: 'steer', key: 'action.steer' },
      { value: 'queue', key: 'action.queue' },
    ]

    /**
     * Save-time rule: a usable map keeps at least one line break and one send.
     * @param map - the draft bindings.
     * @returns the refusal's translation key, or null when the map is usable.
     */
    function validateBindings(map) {
      const values = GESTURES.map(gesture => map[gesture.id])
      const breaks = values.filter(value => value === 'newline').length
      if (breaks === 0) return 'error.noNewline'
      if (breaks === values.length) return 'error.allNewline'
      return null
    }

    /** Page chrome mirrors the host settings pages, using host theme tokens. */
    const STYLE = {
      page: {
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        paddingTop: '4px',
      },
      pageTitle: {
        margin: '0',
        fontSize: '18px',
        fontWeight: '600',
        lineHeight: '26px',
        color: 'var(--dsw-alias-label-primary)',
      },
      rows: {
        marginTop: '12px',
      },
      row: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '16px',
        padding: '14px 0',
        borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
      },
      key: {
        flex: 'none',
        minWidth: '132px',
        padding: '2px 8px',
        borderRadius: 'var(--dsw-radius-sm)',
        background: 'var(--dsw-alias-bg-module-platform)',
        color: 'var(--dsw-alias-label-secondary)',
        fontFamily: 'var(--ds-font-family-code)',
        fontSize: '12px',
        lineHeight: '16px',
        textAlign: 'center',
        whiteSpace: 'nowrap',
      },
      select: {
        flex: 'none',
        minWidth: '148px',
        height: '32px',
        padding: '0 10px',
        border: 'none',
        borderRadius: 'var(--dsw-radius-md)',
        background: 'var(--dsw-alias-bg-module-platform)',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: '13px',
        lineHeight: '20px',
        cursor: 'pointer',
      },
      actions: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: '8px',
        paddingTop: '16px',
      },
      status: {
        marginRight: 'auto',
        fontSize: '12px',
        lineHeight: '18px',
        color: 'var(--dsw-alias-state-success-primary)',
      },
      error: {
        margin: '14px 0 0',
        fontSize: '12px',
        lineHeight: '18px',
        color: 'var(--dsw-alias-state-error-primary)',
      },
      button: {
        height: '32px',
        padding: '0 14px',
        border: 'none',
        borderRadius: 'var(--dsw-radius-md)',
        font: 'inherit',
        fontSize: '13px',
        lineHeight: '20px',
        cursor: 'pointer',
      },
      secondary: {
        background: 'var(--dsw-alias-bg-module-platform)',
        color: 'var(--dsw-alias-label-primary)',
      },
      primary: {
        background: 'var(--dsw-alias-brand-primary-new-colorprimary-new-color, #4d6bfe)',
        color: '#fff',
      },
      primaryDisabled: {
        background: 'var(--dsw-alias-bg-module-platform)',
        color: 'var(--dsw-alias-label-tertiary)',
        cursor: 'default',
      },
      note: {
        margin: '16px 0 0',
        fontSize: '12px',
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-tertiary)',
      },
    }

    /**
     * One gesture row: key cap on the left, action select on the right.
     * @param props - key cap, selected action, localized options and change handler.
     * @returns the row element.
     */
    function GestureRow({ keyCap, value, label, options, onChange }) {
      return h('div', { style: STYLE.row },
        h('kbd', { style: STYLE.key }, keyCap),
        h('select', {
          style: STYLE.select,
          value,
          'aria-label': label,
          onChange,
        }, options.map(option => h('option', { key: option.value, value: option.value }, option.label))))
    }

    /**
     * The Settings page: three gesture selects, Save/Discard, and the save-time check.
     * @param props - slot props; `t` is bound to this plugin's namespace.
     * @returns the section content.
     */
    function SettingsPage({ t }) {
      const [draft, setDraft] = useState(() => ({ ...bindings }))
      const [error, setError] = useState('')
      const [saved, setSaved] = useState(false)
      const options = ACTION_OPTIONS.map(option => ({ value: option.value, label: t(option.key) }))
      // Saving is only meaningful while the draft differs from the live map.
      const dirty = !sameBindings(draft, bindings)

      const change = (gesture, value) => {
        setDraft(current => ({ ...current, [gesture]: value }))
        setError('')
        setSaved(false)
      }

      const discard = () => {
        setDraft({ ...bindings })
        setError('')
        setSaved(false)
      }

      const save = () => {
        const refusal = validateBindings(draft)
        if (refusal !== null) {
          setError(t(refusal))
          setSaved(false)
          return
        }
        writeBindings(draft)
        setError('')
        setSaved(true)
      }

      return h('div', { style: STYLE.page },
        h('h2', { style: STYLE.pageTitle }, t('page.title')),
        h('div', { style: STYLE.rows },
          GESTURES.map(gesture => h(GestureRow, {
            key: gesture.id,
            keyCap: gesture.keyCap,
            value: draft[gesture.id],
            label: t('select.aria', { key: gesture.keyCap }),
            options,
            onChange: (event) => { change(gesture.id, event.target.value) },
          }))),
        error === '' ? null : h('p', { style: STYLE.error, role: 'alert' }, error),
        h('div', { style: STYLE.actions },
          saved && error === '' ? h('span', { style: STYLE.status, role: 'status' }, t('status.saved')) : null,
          h('button', {
            type: 'button',
            style: { ...STYLE.button, ...STYLE.secondary },
            onClick: discard,
          }, t('button.discard')),
          h('button', {
            type: 'button',
            style: { ...STYLE.button, ...(dirty ? STYLE.primary : STYLE.primaryDisabled) },
            disabled: !dirty,
            onClick: save,
          }, t('button.save'))),
        h('p', { style: STYLE.note }, t('note')))
    }

    /**
     * Navigation icon for this settings section; inherits the row colour.
     * @param props - requested square edge in pixels.
     * @returns the icon element.
     */
    function SettingsIcon({ size = 16 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 36 36',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block' },
      },
      h('path', { d: 'M25.5 9.5V19.5H13.5' }),
      h('path', { d: 'M18.5 14.5L13.5 19.5L18.5 24.5' }))
    }

    return {
      inject: ['slots', 'locale'],
      // Exposed for the bundled check (`npm test`); nothing in DSH reads it.
      __test: { DEFAULT_BINDINGS, GESTURES, normalizeBindings, validateBindings },
      apply(ctx) {
        ctx.effect(() => {
          window.addEventListener('keydown', onKeyDown, true)
          return () => { window.removeEventListener('keydown', onKeyDown, true) }
        }, 'composer-enter-newline: composer keydown remap')

        // The busy-send preference decides which gesture carries which mode;
        // without the settings service every send falls back to plain Enter.
        if (typeof ctx.inject === 'function') {
          ctx.inject(['configForms'], (scope) => {
            try {
              conversationForm = scope.configForms.get('ui-conversation')
            } catch {
              conversationForm = null
            }
          })
        }

        ctx.effect(() => ctx.locale.register(NS, DICT), 'composer-enter-newline: dictionaries')
        const t = ctx.locale.bind(NS)

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'composer-enter-newline',
          order: 5,
          label: () => t('nav'),
          locale: NS,
        }, SettingsPage))

        ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
          name: 'settings.section.icon',
          id: 'composer-enter-newline',
        }, SettingsIcon))
      },
    }
  },
})
