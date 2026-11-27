import { readFileSync } from 'node:fs'
import assert from 'node:assert'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

// Minimal React stand-in: elements become plain descriptor objects, and useState
// keeps a per-component hook store so the Settings page can be driven like a
// real render (change a preset, edit a select, click Save, render again).
const hooks = { index: 0, store: [], effects: new Set(), cleanups: [] }
const React = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.filter(c => c !== undefined && c !== null) } }
  },
  useState(initial) {
    const slot = hooks.index++
    if (!(slot in hooks.store)) hooks.store[slot] = typeof initial === 'function' ? initial() : initial
    const set = value => {
      hooks.store[slot] = typeof value === 'function' ? value(hooks.store[slot]) : value
    }
    return [hooks.store[slot], set]
  },
  // The page subscribes to the side-chat store; a stand-in runs the effect once
  // per mount (the harness re-renders by calling the component again).
  useEffect(fn) {
    const slot = `effect-${hooks.index++}`
    if (hooks.effects.has(slot)) return
    hooks.effects.add(slot)
    const dispose = fn()
    if (typeof dispose === 'function') hooks.cleanups.push(dispose)
  },
}

class FakeElement {
  constructor() {
    this.rects = [{}]
    this.connected = true
  }

  getClientRects() {
    return this.rects
  }

  get isConnected() {
    return this.connected
  }

  /** No attributes unless a stub overrides this (menus read the highlight here). */
  getAttribute() {
    return null
  }

  /** Only the popup listbox claims a role; everything else matches nothing. */
  matches() {
    return false
  }

  /** No children unless a stub overrides this. */
  querySelectorAll() {
    return []
  }
}

class FakeKeyboardEvent {
  constructor(type, init = {}) {
    this.type = type
    this.defaultPrevented = false
    this.propagationStopped = false
    this.repeat = false
    Object.assign(this, init)
  }

  preventDefault() { this.defaultPrevented = true }
  stopImmediatePropagation() { this.propagationStopped = true }
  getModifierState() { return false }
}

const storage = new Map()
const fakeDocument = {
  composers: [],
  menus: [],
  querySelectorAll(selector) {
    return selector === '[data-composer-input]' ? this.composers : this.menus
  },
}

let listeners = []
const disposers = []
const fakeWindow = {
  __ModuleLoader__: {
    load(registration) { fakeWindow.registration = registration },
  },
  addEventListener(type, fn) { listeners.push({ type, fn }) },
  removeEventListener() {},
  localStorage: {
    getItem: key => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)) },
  },
}

const run = new Function('window', 'document', 'Element', 'KeyboardEvent', source)
run(fakeWindow, fakeDocument, FakeElement, FakeKeyboardEvent)

const registration = fakeWindow.registration
assert.equal(registration.id, 'dsh-enter-newline')

const STORAGE_KEY = 'composer-enter-newline:bindings:v1'
const PRESET_KEY = 'composer-enter-newline:preset'
const SIDE_CHAT_KEY = 'composer-enter-newline:sidechat-sync'

// Capture the plugin's console diagnostics instead of printing them.
const logs = { info: [], warn: [] }
const realInfo = console.info
const realWarn = console.warn
console.info = (...args) => { logs.info.push(args) }
console.warn = (...args) => { logs.warn.push(args) }
process.on('exit', () => {
  console.info = realInfo
  console.warn = realWarn
})

const createPlugin = () => registration.factory(name => {
  if (name === 'react') return React
  throw new Error(`unexpected require: ${name}`)
})

const mount = ({ bindings, preset, busyEnter, sidebar, sidechatFollow } = {}) => {
  listeners = []
  disposers.length = 0
  hooks.index = 0
  hooks.store.length = 0
  hooks.effects.clear()
  hooks.cleanups.length = 0
  fakeDocument.composers = []
  fakeDocument.menus = []
  if (bindings === undefined) storage.delete(STORAGE_KEY)
  else storage.set(STORAGE_KEY, JSON.stringify(bindings))
  if (preset === undefined) storage.delete(PRESET_KEY)
  else storage.set(PRESET_KEY, preset)
  if (sidechatFollow === undefined) storage.delete(SIDE_CHAT_KEY)
  else storage.set(SIDE_CHAT_KEY, sidechatFollow ? 'on' : 'off')

  const plugin = createPlugin()
  const registrations = []
  const dictionaries = []
  const conversationForm = {
    getSnapshot: () => ({ value: busyEnter === undefined ? undefined : { busyEnter } }),
  }
  const sidebarForm = sidebar === undefined
    ? null
    : makeForm({ value: { pluginSettings: { sidechat: { submitKey: sidebar } } } })
  const held = {
    form: sidebarForm,
    namespaces: sidebarForm === null
      ? []
      : [{
        ns: 'better-sidebar',
        // The wire schema is schemastery's compressed envelope: the root node
        // lives at refs[uid], not on the envelope.
        schema: {
          uid: 15,
          refs: {
            15: { type: 'object', dict: { pluginSettings: 13, tabsEnabled: 14 } },
            13: { type: 'dict', inner: 1 },
            14: { type: 'dict', inner: 6 },
          },
        },
      }],
  }
  const mirrorListeners = new Set()
  const mirror = {
    getSnapshot: () => ({ status: 'ready', view: { namespaces: held.namespaces, writable: true, hasDocument: true }, error: null }),
    subscribe(fn) { mirrorListeners.add(fn); return () => mirrorListeners.delete(fn) },
    ensure: async () => {},
    acceptView() {},
    setNamespaces(namespaces) {
      held.namespaces = namespaces
      for (const fn of [...mirrorListeners]) fn()
    },
  }
  const configForms = {
    get(namespace) {
      if (namespace === 'ui-conversation') return conversationForm
      if (namespace === 'better-sidebar' && sidebarForm !== null) return sidebarForm
      throw new Error(`unexpected namespace: ${namespace}`)
    },
    describe: () => mirror,
  }
  const ctx = {
    // Keep the disposers instead of running them at once: the real ctx.effect()
    // returns a teardown that DSH calls on disable/reload, and one test below
    // exercises that teardown (the diagnostics API must disappear with it).
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
    inject(deps, callback) {
      if (!deps.includes('configForms')) return
      callback({ configForms, effect() {} })
    },
    locale: {
      register(ns, dicts) {
        assert.equal(ns, 'composer-enter-newline')
        assert.ok(dicts.zh && dicts.en)
        dictionaries.push(dicts)
        return () => {}
      },
      bind: () => key => dictionaries[0].zh[key] ?? `!!${key}`,
    },
    slots: {
      inject(name, fn) { fn() },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  plugin.apply(ctx)
  return { plugin, registrations, dictionaries, disposers, sidebarForm, mirror }
}

/** Apply one settings path op the way the Host does (creating maps as needed). */
const applySet = (value, path, next) => {
  if (path.length === 0) return next
  const [head, ...rest] = path
  const base = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return { ...base, [head]: applySet(base[head], rest, next) }
}

/** A settings form stand-in: snapshots, subscriptions, and Host-like echoes. */
const makeForm = ({ status = 'ready', value = undefined } = {}) => {
  const subscribers = new Set()
  const form = {
    calls: [],
    accept: true,
    hold: null,
    snapshot: { status, value, base: {}, user: {}, revision: 1, writable: true },
    getSnapshot: () => form.snapshot,
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn) },
    emit(patch) {
      form.snapshot = { ...form.snapshot, ...patch }
      for (const fn of [...subscribers]) fn()
    },
    async mutate(ops) {
      form.calls.push(ops)
      if (form.hold !== null) await form.hold
      if (!form.accept) return false
      let next = form.snapshot.value
      for (const op of ops) next = applySet(next, op.path, op.value)
      // The real Host answers with the accepted namespace view.
      form.emit({ value: next, revision: form.snapshot.revision + 1 })
      return true
    },
  }
  return form
}

/** One popup: a shell that contains a listbox carrying (or not) the highlight. */
const makeMenu = ({ highlight = false } = {}) => {
  const listbox = Object.assign(new FakeElement(), {
    matches: selector => selector === '[role="listbox"]',
    getAttribute: name => (name === 'aria-activedescendant' && highlight ? 'dsh-slash-option-commands-0' : null),
  })
  return Object.assign(new FakeElement(), {
    querySelectorAll: selector => (selector === '[role="listbox"]' ? [listbox] : []),
  })
}

const makeCard = (menus = []) => ({
  querySelectorAll: () => menus,
})

const makeComposer = ({ card = null, phase = 'plain', editable = true } = {}) => {
  const composer = Object.assign(new FakeElement(), {
    isContentEditable: editable,
    hasAttribute: () => false,
    getAttribute: name => (name === 'data-phase' ? phase : null),
    events: [],
    dispatchEvent(event) { this.events.push(event); return true },
    closest(selector) {
      if (selector === '[data-composer-input]') return composer
      if (selector === '[data-composer-card]') return card
      return null
    },
  })
  return composer
}

const makeTarget = composer => Object.assign(new FakeElement(), {
  closest(selector) {
    if (selector === '[data-composer-input]') return composer
    if (selector === '[data-composer-card]') return composer.closest('[data-composer-card]')
    return null
  },
})

const fire = type => {
  for (const listener of listeners.filter(l => l.type === type)) listener.fn()
}

const press = (composer, init = {}, target = null) => {
  composer.events.length = 0
  const event = new FakeKeyboardEvent('keydown', {
    key: 'Enter',
    keyCode: 13,
    target: target ?? makeTarget(composer),
    ...init,
  })
  for (const listener of listeners.filter(l => l.type === 'keydown')) listener.fn(event)
  return { event, replay: composer.events[0] }
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Flatten a React stand-in tree to elements and text. */
const flatten = (node, out = []) => {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) { node.forEach(child => flatten(child, out)); return out }
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (typeof node.type === 'function') {
    const rendered = node.type({ ...node.props, children: undefined })
    flatten(rendered, out)
    return out
  }
  out.push(node)
  flatten(node.props?.children, out)
  return out
}
const textOf = node => flatten(node).filter(item => typeof item === 'string').join('')
const elementsOf = (node, type) => flatten(node).filter(item => typeof item === 'object' && item.type === type)

// --- registration ----------------------------------------------------------
const first = mount()
assert.deepEqual([...first.plugin.inject], ['slots', 'locale'])
const section = first.registrations.find(r => r.options.name === 'settings.section')
const icon = first.registrations.find(r => r.options.name === 'settings.section.icon')
assert.ok(section, 'registers a settings.section')
assert.ok(icon, 'registers a settings.section.icon')
assert.equal(section.options.id, 'composer-enter-newline')
assert.equal(icon.options.id, 'composer-enter-newline')
assert.equal(section.options.locale, 'composer-enter-newline')
assert.equal(section.options.order, 5)
assert.equal(section.options.label(), 'Enter 换行')

// The page configures these three gestures in this order, with these defaults.
const { DEFAULT_BINDINGS, GESTURES, normalizeBindings, validateBindings } = first.plugin.__test
assert.deepEqual(GESTURES.map(g => g.keyCap), ['Enter', 'Ctrl/Cmd+Enter', 'Shift+Enter'])
assert.deepEqual(DEFAULT_BINDINGS, { enter: 'newline', ctrlEnter: 'steer', shiftEnter: 'queue' })

// Save-time rule: keep at least one line break and one send.
assert.equal(validateBindings({ enter: 'steer', ctrlEnter: 'queue', shiftEnter: 'queue' }), 'error.noNewline')
assert.equal(validateBindings({ enter: 'newline', ctrlEnter: 'newline', shiftEnter: 'newline' }), 'error.allNewline')
assert.equal(validateBindings({ enter: 'newline', ctrlEnter: 'steer', shiftEnter: 'steer' }), null)
assert.equal(validateBindings({ enter: 'steer', ctrlEnter: 'queue', shiftEnter: 'newline' }), null)

// A partial or malformed map completes from the defaults.
assert.deepEqual(normalizeBindings({ enter: 'queue' }), { enter: 'queue', ctrlEnter: 'steer', shiftEnter: 'queue' })
assert.deepEqual(normalizeBindings(null), { ...DEFAULT_BINDINGS })

// Dictionaries stay key-for-key balanced, and cover the page's copy.
const zh = first.dictionaries[0].zh
const en = first.dictionaries[0].en
assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
assert.deepEqual(Object.keys(zh).sort(), [
  'action.newline', 'action.queue', 'action.steer',
  'anchor.found', 'anchor.missing', 'anchor.unknown',
  'button.discard', 'button.restoreDefault', 'button.save',
  'diagnostics.copy',
  'error.allNewline', 'error.noNewline',
  'io.badFormat', 'io.badJson', 'io.badPlugin', 'io.copy', 'io.copyFailed', 'io.copied',
  'io.export', 'io.import', 'io.imported', 'io.title',
  'nav', 'page.title',
  'preset.dsh', 'preset.dsh.desc', 'preset.plugin', 'preset.plugin.desc', 'preset.title',
  'select.aria',
  'sideChat.conflict', 'sideChat.follow', 'sideChat.limit',
  'sideChat.loading', 'sideChat.missing', 'sideChat.mode.enter', 'sideChat.mode.modEnter',
  'sideChat.rejected', 'sideChat.synced', 'sideChat.title',
  'status.draft', 'status.dsh', 'status.plugin', 'status.saved',
  'storage.volatile',
].sort())
assert.equal(zh['action.newline'], '换行', 'the action is called 换行, not 插入换行')
assert.equal(zh['nav'], 'Enter 换行')

// --- activation log --------------------------------------------------------
const activeLog = logs.info.find(args => args[0] === '[dsh-enter-newline]' && args[1] === 'active')
assert.ok(activeLog, 'apply logs an active line with the package prefix')
assert.equal(activeLog[2].preset, 'plugin')
assert.deepEqual(activeLog[2].bindings, { ...DEFAULT_BINDINGS })

// --- default bindings ------------------------------------------------------
mount({ busyEnter: undefined })

let { event, replay } = press(makeComposer())
assert.ok(event.defaultPrevented, 'Enter is intercepted')
assert.equal(replay.shiftKey, true, 'Enter (newline) replays as Shift+Enter')

;({ event, replay } = press(makeComposer(), { ctrlKey: true }))
assert.ok(event.defaultPrevented, 'Ctrl+Enter is intercepted')
assert.equal(replay.ctrlKey, true, 'Ctrl+Enter (steer) replays the accelerated chord')
assert.equal(replay.shiftKey, false)

;({ event, replay } = press(makeComposer(), { shiftKey: true }))
assert.ok(event.defaultPrevented, 'Shift+Enter (queue) is intercepted')
assert.equal(replay.ctrlKey, false, 'Shift+Enter (queue) replays plain Enter')
assert.equal(replay.shiftKey, false)

;({ event, replay } = press(makeComposer(), { ctrlKey: true, shiftKey: true }))
assert.ok(!event.defaultPrevented, 'Ctrl+Shift+Enter stays untouched')
assert.equal(replay, undefined)

;({ event } = press(makeComposer(), { ctrlKey: true, metaKey: true }))
assert.ok(!event.defaultPrevented, 'Ctrl+Cmd+Enter stays untouched')

;({ event } = press(makeComposer(), { isComposing: true }))
assert.ok(!event.defaultPrevented, 'IME composition Enter stays untouched')

// --- steering preference flips the chord -----------------------------------
mount({ busyEnter: 'steer' })
;({ replay } = press(makeComposer(), { ctrlKey: true }))
assert.equal(replay.ctrlKey, false, 'with steer preferred, a steer action uses plain Enter')
;({ replay } = press(makeComposer(), { shiftKey: true }))
assert.equal(replay.ctrlKey, true, 'with steer preferred, a queue action uses the chord')

// --- a saved map drives the gestures --------------------------------------
mount({ bindings: { enter: 'queue', ctrlEnter: 'newline', shiftEnter: 'newline' }, busyEnter: 'queue' })
;({ replay } = press(makeComposer()))
assert.equal(replay.ctrlKey, false, 'saved Enter=queue replays plain Enter')
;({ replay } = press(makeComposer(), { ctrlKey: true }))
assert.equal(replay.shiftKey, true, 'saved Ctrl+Enter=newline replays Shift+Enter')
;({ event } = press(makeComposer(), { shiftKey: true }))
assert.ok(!event.defaultPrevented, 'Shift+Enter mapped to a line break keeps the native path')

// An invalid stored map falls back to the defaults instead of breaking input.
mount({ bindings: { enter: 'explode', ctrlEnter: 42 } })
;({ replay } = press(makeComposer()))
assert.equal(replay.shiftKey, true, 'unknown actions fall back to the defaults')

// --- default preset (follow DSH) ------------------------------------------
mount({ preset: 'dsh' })
for (const init of [{}, { ctrlKey: true }, { shiftKey: true }]) {
  ;({ event, replay } = press(makeComposer(), init))
  assert.ok(!event.defaultPrevented, 'default preset lets every gesture through')
  assert.equal(replay, undefined, 'default preset dispatches nothing')
}

// --- menu arbitration (three states) ---------------------------------------
// A visible listbox elsewhere on the page no longer disables the composer.
mount()
const ownCard = makeCard()
const scoped = makeComposer({ card: ownCard })
fakeDocument.menus = [new FakeElement()]
;({ event, replay } = press(scoped))
assert.ok(event.defaultPrevented, 'a listbox outside the composer card does not block the keys')
assert.equal(replay.shiftKey, true)

// A highlight means the popup owns Enter: the key passes through untouched.
ownCard.querySelectorAll = () => [makeMenu({ highlight: true })]
;({ event, replay } = press(scoped))
assert.ok(!event.defaultPrevented, 'a highlighted candidate keeps Enter')
assert.equal(replay, undefined)

// A popup without a highlight would fall through to DSH's submit, so the
// plugin swallows the gesture: no send, no line break.
ownCard.querySelectorAll = () => [makeMenu()]
;({ event, replay } = press(scoped))
assert.ok(event.defaultPrevented, 'a popup without a highlight swallows Enter')
assert.ok(event.propagationStopped, 'the swallowed Enter never reaches the composer keymap')
assert.equal(replay, undefined, 'nothing is replayed while the popup has no highlight')

// The same popup state swallows the accelerated send chord too.
;({ event, replay } = press(scoped, { ctrlKey: true }))
assert.ok(event.defaultPrevented, 'a popup without a highlight swallows Ctrl+Enter')
assert.equal(replay, undefined)

// Shift+Enter never sends, so it keeps the native line break.
;({ event, replay } = press(scoped, { shiftKey: true }))
assert.ok(!event.defaultPrevented, 'Shift+Enter keeps the native line break in a highlight-less popup')
assert.equal(replay, undefined)

// Highlight appearing later flips the decision back to "popup owns it".
ownCard.querySelectorAll = () => [makeMenu({ highlight: true })]
;({ event, replay } = press(scoped))
assert.ok(!event.defaultPrevented, 'the highlight state is read per keystroke')

// A skin that exposes the listbox itself as the popup is read directly.
const directListbox = Object.assign(new FakeElement(), {
  matches: selector => selector === '[role="listbox"]',
  getAttribute: name => (name === 'aria-activedescendant' ? 'dsh-slash-option-commands-0' : null),
})
ownCard.querySelectorAll = () => [directListbox]
;({ event, replay } = press(scoped))
assert.ok(!event.defaultPrevented, 'a bare listbox with a highlight keeps Enter')
directListbox.getAttribute = () => null
;({ event } = press(scoped))
assert.ok(event.defaultPrevented, 'a bare listbox without a highlight swallows Enter')

// The block decision is observable through the diagnostics API.
ownCard.querySelectorAll = () => [makeMenu()]
press(scoped)
let api = fakeWindow.__dshEnterNewline
assert.equal(api.getStatus().lastKey.decision, 'menu-blocked')
assert.ok(api.getStatus().menuBlocks >= 1, 'swallowed menu gestures are counted')

// Without a card (layout change) the old page-wide fallback survives.
mount()
fakeDocument.menus = [new FakeElement()]
;({ event } = press(makeComposer({ card: null })))
assert.ok(!event.defaultPrevented, 'page-wide fallback still yields to a visible listbox')
fakeDocument.menus = []
;({ event } = press(makeComposer({ card: null })))
assert.ok(event.defaultPrevented, 'page-wide fallback intercepts when no popup is visible')

// --- IME grace -------------------------------------------------------------
mount({ busyEnter: 'queue' })
const composer = makeComposer()
fire('compositionstart')
;({ event, replay } = press(composer, { ctrlKey: true }))
assert.ok(!event.defaultPrevented, 'Enter during a composition stays with the IME')
assert.equal(replay, undefined)

fire('compositionend')
;({ event, replay } = press(composer, { ctrlKey: true }))
assert.ok(event.defaultPrevented, 'a post-composition send is intercepted')
assert.equal(replay, undefined, 'the send is deferred until DSH has passed its 10ms window')
await wait(30)
assert.equal(composer.events.length, 1, 'exactly one deferred send is dispatched')
assert.equal(composer.events[0].ctrlKey, true, 'the deferred send keeps the chord')
assert.equal(composer.events[0].key, 'Enter')

// A line break is safe inside the same window and stays immediate.
const lineComposer = makeComposer()
fire('compositionstart')
fire('compositionend')
;({ replay } = press(lineComposer))
assert.equal(replay?.shiftKey, true, 'a line break is replayed immediately after compositionend')

// Esc calls the deferred send off; any other key leaves it queued.
const escComposer = makeComposer()
fire('compositionstart')
fire('compositionend')
;({ event } = press(escComposer, { ctrlKey: true }))
assert.ok(event.defaultPrevented, 'the post-composition send is held inside the window')
press(escComposer, { key: 'Escape', keyCode: 27 })
await wait(30)
assert.equal(escComposer.events.length, 0, 'Escape cancels the deferred send')
assert.equal(logs.info.some(args => args[1] === 'deferred send cancelled by Escape'), true, 'the cancel is logged')

const keepComposer = makeComposer()
fire('compositionstart')
fire('compositionend')
;({ event } = press(keepComposer, { ctrlKey: true }))
press(keepComposer, { key: 'a', keyCode: 65 })
await wait(30)
assert.equal(keepComposer.events.length, 1, 'an unrelated key does not cancel the deferred send')

// --- diagnostics API --------------------------------------------------------
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
mount()
api = fakeWindow.__dshEnterNewline
assert.ok(api, 'apply installs window.__dshEnterNewline')
assert.equal(api.version, pkg.version, 'the API version matches package.json')
assert.equal(first.plugin.__test.VERSION, pkg.version, 'the bundled VERSION constant matches package.json')
assert.deepEqual(Object.keys(api.getStatus()).sort(), [
  'anchor', 'bindings', 'busyEnter', 'composers', 'lastKey',
  'menuBlocks', 'plugin', 'preset', 'sideChat', 'storage', 'version',
])
assert.deepEqual(api.getStatus().sideChat, {
  present: false,
  mode: null,
  follow: false,
  namespaces: 0,
  sync: 'off',
})
assert.equal(api.getStatus().preset, 'plugin')
assert.equal(api.getStatus().busyEnter, 'unknown', 'no settings service means unknown')
// Every mount is a fresh factory closure, so nothing has been seen yet.
assert.equal(api.getStatus().anchor, 'unknown')
assert.equal(api.getStatus().lastKey, null)
assert.equal(api.getStatus().storage, 'local')

// The binding copy must not be a live reference.
const copy = api.getBindings()
copy.enter = 'steer'
assert.equal(api.getBindings().enter, 'newline', 'getBindings returns a snapshot')
assert.ok(api.inspect().includes('"version"'))
assert.equal(JSON.parse(api.inspect()).plugin, 'dsh-enter-newline')

// Every exit records its decision for the shared bug-report snapshot.
press(makeComposer())
assert.equal(api.getStatus().anchor, 'found', 'a composer press marks the anchor as found')
assert.equal(api.getStatus().lastKey.decision, 'newline', 'a line break replay is recorded')
assert.equal(api.getStatus().lastKey.gesture, 'enter')
press(makeComposer(), { ctrlKey: true })
assert.equal(api.getStatus().lastKey.decision, 'steer')
press(makeComposer(), { shiftKey: true })
assert.equal(api.getStatus().lastKey.decision, 'queue')
press(makeComposer(), { altKey: true })
assert.equal(api.getStatus().lastKey.decision, 'reserved', 'Alt+Enter is left to the composer')
assert.equal(api.getStatus().lastKey.gesture, null, 'a reserved chord records no gesture')
press(makeComposer({ editable: false }))
assert.equal(api.getStatus().lastKey.decision, 'readonly')
assert.equal(api.getStatus().composers, 0, 'no composer in the stub document')
mount({ preset: 'dsh' })
press(makeComposer())
assert.equal(fakeWindow.__dshEnterNewline.getStatus().lastKey.decision, 'preset-dsh')

// Disabling the plugin removes the API again.
const disposed = mount()
assert.ok(fakeWindow.__dshEnterNewline, 'the API is installed by apply')
for (const fn of [...disposed.disposers].reverse()) fn()
assert.equal(fakeWindow.__dshEnterNewline, undefined, 'dispose removes the API')

// --- anchor diagnostic and fail-safe --------------------------------------
mount()
const editableCard = makeCard()
const editableTarget = Object.assign(new FakeElement(), {
  isContentEditable: true,
  closest(selector) {
    if (selector === '[data-composer-card]') return editableCard
    if (selector === '[contenteditable]') return editableTarget
    return null
  },
})
logs.warn.length = 0
press(makeComposer(), {}, editableTarget)
assert.equal(logs.warn.length, 1, 'a missing anchor warns once')
assert.ok(String(logs.warn[0][0]).includes('composer anchor missing'))
press(makeComposer(), {}, editableTarget)
assert.equal(logs.warn.length, 1, 'the anchor warning is not repeated')

// Fail safe: with the anchor gone, a send must never reach the host.
const missingPress = (init = {}, target = editableTarget) => {
  const ev = new FakeKeyboardEvent('keydown', { key: 'Enter', keyCode: 13, target, ...init })
  for (const listener of listeners.filter(l => l.type === 'keydown')) listener.fn(ev)
  return ev
}
let missing = missingPress()
assert.ok(missing.defaultPrevented, 'a send Enter on a renamed anchor is swallowed')
assert.ok(missing.propagationStopped, 'and never reaches the host keymap')
missing = missingPress({ ctrlKey: true })
assert.ok(missing.defaultPrevented, 'the accelerated send is swallowed as well')
missing = missingPress({ shiftKey: true })
assert.ok(!missing.defaultPrevented, 'Shift+Enter keeps the native line break')
missing = missingPress({ altKey: true })
assert.ok(!missing.defaultPrevented, 'Alt+Enter stays with the composer')

// A non-editable card target (workspace trigger) is not touched.
const readonlyTarget = Object.assign(new FakeElement(), {
  isContentEditable: false,
  closest(selector) {
    if (selector === '[data-composer-card]') return editableCard
    if (selector === '[contenteditable]') return readonlyTarget
    return null
  },
})
missing = missingPress({}, readonlyTarget)
assert.ok(!missing.defaultPrevented, 'a read-only card does not swallow Enter')

// Outside a composer card nothing is swallowed.
const outsideTarget = Object.assign(new FakeElement(), {
  isContentEditable: true,
  closest: () => null,
})
missing = missingPress({}, outsideTarget)
assert.ok(!missing.defaultPrevented, 'an editable outside a composer card is left alone')

// A highlighted popup inside the missing-anchor card still owns Enter.
editableCard.querySelectorAll = () => [makeMenu({ highlight: true })]
missing = missingPress()
assert.ok(!missing.defaultPrevented, 'the popup highlight wins even on a renamed anchor')
editableCard.querySelectorAll = () => []

// The default preset never intervenes, even with a missing anchor.
mount({ preset: 'dsh' })
missing = missingPress()
assert.ok(!missing.defaultPrevented, 'the default preset does not swallow anything')
assert.equal(fakeWindow.__dshEnterNewline.getStatus().anchor, 'missing', 'the status reports the broken anchor')

// --- settings page harness -------------------------------------------------
const mountPage = (options) => {
  const mounted = mount(options)
  const page = mounted.registrations.find(r => r.options.name === 'settings.section').component
  const dict = mounted.dictionaries[0].zh
  const render = () => {
    hooks.index = 0
    const t = (key, params) => (dict[key] ?? `!!${key}`)
      .replace(/\{(\w+)\}/g, (match, name) => (params?.[name] === undefined ? match : String(params[name])))
    return page({ t })
  }
  return { ...mounted, page, dict, render }
}
const selects = tree => elementsOf(tree, 'select')
const buttons = tree => elementsOf(tree, 'button')
const button = (tree, label) => buttons(tree).find(el => textOf(el) === label)
const radio = (tree, label) => buttons(tree).find(el => el.props.role === 'radio' && textOf(el).includes(label))
const statusTexts = tree => elementsOf(tree, 'span')
  .filter(el => el.props.role === 'status')
  .map(el => textOf(el))

// --- the settings page -----------------------------------------------------
let suite = mountPage({ busyEnter: 'queue' })
let tree = suite.render()
let dict = suite.dict
assert.equal(textOf(tree).includes('!!'), false, 'every rendered key exists')

// The preset cards, the one-line effective summary, and no extra copy.
let text = textOf(tree)
assert.ok(text.includes('当前生效：Enter = 换行 · Ctrl/Cmd+Enter = 插话发送 · Shift+Enter = 排队发送'))
assert.ok(text.includes('默认配置'))
assert.ok(text.includes('热关闭插件，恢复当前DSH设置'))
assert.ok(text.includes('插件配置'))
assert.ok(text.includes('用户自定义配置，可在下方逐键调整'))
assert.equal(text.includes('繁忙时 Enter'), false, 'the busy-Enter paragraph is gone')
assert.equal(text.includes('「导出」写入当前已保存的方案'), false, 'the export hint is gone')
assert.equal(text.includes('插话与排队只在智能体运行时不同'), false, 'the long trailing note is gone')
assert.equal(textOf(tree).includes('输入框锚点：尚未检测到'), true)
assert.equal(radio(tree, '默认配置').props['aria-checked'], false)
assert.equal(radio(tree, '插件配置').props['aria-checked'], true)

// Defaults render in the requested order with the requested values.
const rows = selects(tree)
assert.deepEqual(rows.map(el => el.props['aria-label']), ['Enter 按键行为', 'Ctrl/Cmd+Enter 按键行为', 'Shift+Enter 按键行为'])
assert.deepEqual(rows.map(el => el.props.value), ['newline', 'steer', 'queue'])
assert.deepEqual(rows.map(el => elementsOf(el, 'option').map(option => textOf(option))), [
  ['换行', '插话发送', '排队发送'],
  ['换行', '插话发送', '排队发送'],
  ['换行', '插话发送', '排队发送'],
])

// Save starts disabled and grey while the draft equals the saved map.
const saveButton = pageTree => button(pageTree, '保存')
assert.equal(saveButton(tree).props.disabled, true, 'save is disabled without changes')
assert.equal(saveButton(tree).props.style.background, 'var(--dsw-alias-bg-module-platform)', 'disabled save is grey')

// Any change arms the button with the brand colour.
rows[0].props.onChange({ target: { value: 'steer' } })
tree = suite.render()
assert.equal(saveButton(tree).props.disabled, false, 'save is enabled after a change')
assert.ok(
  textOf(tree).includes('当前生效：Enter = 换行 · Ctrl/Cmd+Enter = 插话发送 · Shift+Enter = 排队发送'),
  'the live line keeps describing the saved map',
)
assert.ok(textOf(tree).includes('未保存：Enter = 插话发送'), 'the draft line names the edited mapping')
rows[0].props.onChange({ target: { value: 'newline' } })
tree = suite.render()
assert.equal(textOf(tree).includes('未保存：'), false, 'reverting the draft drops the draft line')
assert.equal(saveButton(tree).props.disabled, true, 'reverting to the saved map disables save again')

// All-newline is refused on Save, and nothing is persisted.
for (const el of rows) el.props.onChange({ target: { value: 'newline' } })
tree = suite.render()
assert.equal(textOf(tree).includes(dict['error.allNewline']), false, 'no warning while editing')
button(tree, '保存').props.onClick()
tree = suite.render()
assert.ok(textOf(tree).includes(dict['error.allNewline']), 'the refusal survives the render')
assert.equal(storage.has(STORAGE_KEY), false, 'refused save writes nothing')

// A usable map saves, persists and reports success.
const valid = ['steer', 'queue', 'newline']
selects(tree).forEach((el, index) => { el.props.onChange({ target: { value: valid[index] } }) })
tree = suite.render()
assert.equal(saveButton(tree).props.disabled, false, 'dirty map arms save')
button(tree, '保存').props.onClick()
tree = suite.render()
assert.ok(statusTexts(tree).includes(dict['status.saved']), 'saved status appears')
assert.deepEqual(JSON.parse(storage.get(STORAGE_KEY)), { enter: 'steer', ctrlEnter: 'queue', shiftEnter: 'newline' })
assert.ok(textOf(tree).includes('当前生效：Enter = 插话发送 · Ctrl/Cmd+Enter = 排队发送 · Shift+Enter = 换行'))
assert.equal(textOf(tree).includes('未保存：'), false, 'saving clears the draft line')
assert.equal(saveButton(tree).props.disabled, true, 'a saved map disables save again')
assert.ok(logs.info.some(args => args[1] === 'bindings saved'), 'save logs the new bindings')

// Discard returns the draft to the saved map.
selects(tree)[0].props.onChange({ target: { value: 'newline' } })
tree = suite.render()
assert.equal(saveButton(tree).props.disabled, false, 'discard target is dirty')
button(tree, '放弃').props.onClick()
tree = suite.render()
assert.deepEqual(selects(tree).map(el => el.props.value), ['steer', 'queue', 'newline'])
assert.equal(statusTexts(tree).includes(dict['status.saved']), false, 'discard clears the saved status')

// --- preset switching ------------------------------------------------------
radio(tree, '默认配置').props.onClick()
assert.equal(storage.get(PRESET_KEY), 'dsh', 'switching preset persists immediately')
tree = suite.render()
assert.equal(selects(tree).length, 0, 'the plugin-preset selects are hidden')
assert.equal(button(tree, '保存'), undefined)
assert.ok(textOf(tree).includes('当前生效：Enter = 排队发送 · Ctrl/Cmd+Enter = 插话发送 · Shift+Enter = 换行'))
;({ event } = press(makeComposer()))
assert.ok(!event.defaultPrevented, 'the default preset takes effect without a save')

radio(tree, '插件配置').props.onClick()
assert.equal(storage.get(PRESET_KEY), 'plugin')
tree = suite.render()
assert.deepEqual(selects(tree).map(el => el.props.value), ['steer', 'queue', 'newline'], 'the saved map returns')

// --- busy-Enter drives the default-configuration summary -------------------
suite = mountPage({ preset: 'dsh', busyEnter: 'steer' })
tree = suite.render()
dict = suite.dict
assert.ok(textOf(tree).includes('当前生效：Enter = 插话发送 · Ctrl/Cmd+Enter = 排队发送 · Shift+Enter = 换行'))
suite = mountPage({ preset: 'dsh', busyEnter: undefined })
tree = suite.render()
dict = suite.dict
assert.ok(textOf(tree).includes('当前生效：Enter = 排队发送 · Ctrl/Cmd+Enter = 插话发送 · Shift+Enter = 换行'))

// --- restore the plugin default --------------------------------------------
suite = mountPage()
tree = suite.render()
dict = suite.dict
const restoreButton = pageTree => button(pageTree, '恢复插件预设')
assert.equal(restoreButton(tree).props.disabled, true, 'restore is disabled on the plugin default')
selects(tree)[0].props.onChange({ target: { value: 'queue' } })
tree = suite.render()
assert.equal(restoreButton(tree).props.disabled, false, 'a non-default draft arms restore')
restoreButton(tree).props.onClick()
tree = suite.render()
assert.deepEqual(selects(tree).map(el => el.props.value), ['newline', 'steer', 'queue'], 'restore writes the plugin default')
assert.deepEqual(JSON.parse(storage.get(STORAGE_KEY)), { enter: 'newline', ctrlEnter: 'steer', shiftEnter: 'queue' }, 'restore persists immediately')
assert.equal(restoreButton(tree).props.disabled, true, 'restore disables again')
assert.ok(statusTexts(tree).includes(dict['status.saved']), 'restore reports saved')

suite = mountPage({ bindings: { enter: 'steer', ctrlEnter: 'queue', shiftEnter: 'newline' } })
tree = suite.render()
dict = suite.dict
assert.equal(restoreButton(tree).props.disabled, false, 'a non-default saved map arms restore')
restoreButton(tree).props.onClick()
tree = suite.render()
assert.deepEqual(JSON.parse(storage.get(STORAGE_KEY)), { enter: 'newline', ctrlEnter: 'steer', shiftEnter: 'queue' }, 'restore from a saved map')

// --- export / import -------------------------------------------------------
suite = mountPage()
tree = suite.render()
dict = suite.dict
button(tree, '导出').props.onClick()
tree = suite.render()
const textareas = elementsOf(tree, 'textarea')
assert.equal(textareas.length, 1, 'the export textarea renders')
const exportedDoc = JSON.parse(textareas[0].props.value)
assert.deepEqual(exportedDoc, {
  plugin: 'dsh-enter-newline',
  format: 1,
  preset: 'plugin',
  bindings: { enter: 'newline', ctrlEnter: 'steer', shiftEnter: 'queue' },
})

// Import an envelope with the default preset + a valid map.
const envelope = JSON.stringify({
  plugin: 'dsh-enter-newline',
  format: 1,
  preset: 'dsh',
  bindings: { enter: 'queue', ctrlEnter: 'newline', shiftEnter: 'queue' },
})
elementsOf(tree, 'textarea')[0].props.onChange({ target: { value: envelope } })
tree = suite.render()
button(tree, '导入').props.onClick()
tree = suite.render()
assert.equal(storage.get(PRESET_KEY), 'dsh', 'import applies the preset')
assert.deepEqual(JSON.parse(storage.get(STORAGE_KEY)), { enter: 'queue', ctrlEnter: 'newline', shiftEnter: 'queue' })
assert.ok(textOf(tree).includes(dict['io.imported']))
;({ event } = press(makeComposer()))
assert.ok(!event.defaultPrevented, 'the imported default preset is live')

// Import a bare map keeps the current preset.
radio(tree, '插件配置').props.onClick()
tree = suite.render()
elementsOf(tree, 'textarea')[0].props.onChange({
  target: { value: JSON.stringify({ enter: 'newline', ctrlEnter: 'steer', shiftEnter: 'queue' }) },
})
tree = suite.render()
button(tree, '导入').props.onClick()
tree = suite.render()
assert.equal(storage.get(PRESET_KEY), 'plugin', 'a bare map does not change the preset')
assert.deepEqual(JSON.parse(storage.get(STORAGE_KEY)), { enter: 'newline', ctrlEnter: 'steer', shiftEnter: 'queue' })

// Invalid imports are refused and write nothing.
const before = storage.get(STORAGE_KEY)
for (const [bad, key] of [
  ['not json', 'io.badJson'],
  [JSON.stringify({ format: 2, bindings: { enter: 'newline' } }), 'io.badFormat'],
  [JSON.stringify({ plugin: 'someone-else', format: 1, bindings: { enter: 'newline' } }), 'io.badPlugin'],
  [JSON.stringify({ plugin: 'dsh-enter-newline', format: 1, bindings: { enter: 'steer', ctrlEnter: 'steer', shiftEnter: 'steer' } }), 'error.noNewline'],
]) {
  elementsOf(tree, 'textarea')[0].props.onChange({ target: { value: bad } })
  tree = suite.render()
  button(tree, '导入').props.onClick()
  tree = suite.render()
  assert.ok(textOf(tree).includes(dict[key]), `import reports ${key}`)
  assert.equal(storage.get(STORAGE_KEY), before, 'refused import writes nothing')
}

// Copy without a clipboard API reports the failure instead of lying.
button(tree, '复制').props.onClick()
tree = suite.render()
assert.ok(textOf(tree).includes(dict['io.copyFailed']), 'copy failure is surfaced')

// --- copy diagnostics ------------------------------------------------------
suite = mountPage()
tree = suite.render()
dict = suite.dict
button(tree, '复制诊断').props.onClick()
tree = suite.render()
const diagnostic = JSON.parse(elementsOf(tree, 'textarea')[0].props.value)
assert.equal(diagnostic.plugin, 'dsh-enter-newline', 'the diagnostics button writes the status JSON')
assert.equal(diagnostic.version, pkg.version)
assert.ok(textOf(tree).includes(dict['io.copyFailed']), 'no clipboard: the JSON lands in the box for manual copy')

// --- parse/build helpers ---------------------------------------------------
assert.deepEqual(first.plugin.__test.parseImportDocument('null'), { error: 'io.badJson' })
assert.deepEqual(first.plugin.__test.parseImportDocument('[]'), { error: 'io.badJson' })
assert.equal(first.plugin.__test.parseImportDocument(JSON.stringify({ enter: 'newline' })).bindings.enter, 'newline')
assert.equal(first.plugin.__test.buildExportDocument().includes('"plugin": "dsh-enter-newline"'), true)

// --- icon ------------------------------------------------------------------
const iconTree = icon.component({ size: 20, active: true })
assert.equal(iconTree.props.width, 20)
assert.equal(iconTree.props.stroke, 'currentColor')

// --- side chat (dsh-better-sidebar) ---------------------------------------
const switcher = pageTree => buttons(pageTree).find(el => el.props.role === 'switch')
const sideModeOf = () => fakeWindow.__dshEnterNewline.getStatus().sideChat

// Units: namespace discovery by schema shape, and the projection rule.
const { findSideChatNamespace, projectSideChatMode, readSideChatMode } = first.plugin.__test
assert.equal(findSideChatNamespace(undefined), null)
assert.equal(findSideChatNamespace({ namespaces: [{ ns: 'ui-chat', schema: { dict: { busyEnter: {} } } }] }), null)
// The Host sends schemastery's compressed envelope, so the root node is refs[uid].
assert.equal(
  findSideChatNamespace({
    namespaces: [
      { ns: 'ui-chat', schema: { uid: 1, refs: { 1: { type: 'object', dict: { busyEnter: 2 } } } } },
      {
        ns: 'web-ui-better-sidebar',
        schema: { uid: 15, refs: { 15: { type: 'object', dict: { pluginSettings: 13, tabsEnabled: 14 } } } },
      },
    ],
  }),
  'web-ui-better-sidebar',
  'the compressed envelope is read at refs[uid], and a re-mounted row id is still found',
)
// A plain (uncompressed) schema is still understood, for defensive parity.
assert.equal(
  findSideChatNamespace({ namespaces: [{ ns: 'better-sidebar', schema: { dict: { pluginSettings: {}, tabsEnabled: {} } } }] }),
  'better-sidebar',
)
assert.equal(findSideChatNamespace({ namespaces: [{ ns: 'x', schema: { uid: 9, refs: {} } }] }), null)
// Second pass: the resolved side-chat blob identifies the row even when the
// schema field names change.
assert.equal(
  findSideChatNamespace({
    namespaces: [
      { ns: 'ui-chat', schema: { dict: {} }, value: { busyEnter: 'queue' } },
      { ns: 'renamed-sidebar', schema: { dict: { other: 1 } }, value: { pluginSettings: { sidechat: { submitKey: 'enter' } } } },
    ],
  }),
  'renamed-sidebar',
)
assert.equal(readSideChatMode(undefined), null, 'an unresolved section reports nothing')
assert.equal(readSideChatMode({}), 'enter', 'the side card treats an absent value as enter')
assert.equal(readSideChatMode({ pluginSettings: { sidechat: { submitKey: 'mod-enter' } } }), 'mod-enter')
assert.equal(projectSideChatMode(), 'mod-enter', 'Enter=newline projects onto the chord mode')
assert.equal(first.plugin.__test.SIDE_CHAT_KEY, 'composer-enter-newline:sidechat-sync')

// Without the side card the section explains itself and offers no switch.
suite = mountPage()
tree = suite.render()
dict = suite.dict
assert.ok(textOf(tree).includes(dict['sideChat.missing']), 'a missing side card is stated')
assert.equal(switcher(tree), undefined, 'no switch without a side card')
assert.deepEqual(sideModeOf(), { present: false, mode: null, follow: false, namespaces: 0, sync: 'off' })

// A detected side card shows its own mode, read-only, while following is off.
suite = mountPage({ sidebar: 'enter' })
tree = suite.render()
dict = suite.dict
let sideForm = suite.sidebarForm
assert.equal(sideForm.calls.length, 0, 'a fresh page writes nothing')
assert.ok(textOf(tree).includes(dict['sideChat.mode.enter']), 'the side card mode is shown')
assert.ok(textOf(tree).includes(dict['sideChat.limit']), 'the third-key limitation is stated')
assert.equal(switcher(tree).props['aria-checked'], false, 'following starts off')
assert.equal(sideModeOf().present, true)
assert.equal(sideModeOf().mode, 'enter')

// Turning it on projects our Enter mapping into the side card's own mode.
switcher(tree).props.onClick()
await wait(0)
tree = suite.render()
assert.deepEqual(sideForm.calls[0], [
  { op: 'set', path: ['pluginSettings', 'sidechat', 'submitKey'], value: 'mod-enter' },
], 'enabling writes the projected mode through the declared settings seam')
assert.equal(sideModeOf().sync, 'on')
assert.equal(sideModeOf().mode, 'mod-enter')
assert.ok(textOf(tree).includes(dict['sideChat.mode.modEnter']), 'the read-only line follows the side card')
assert.ok(statusTexts(tree).includes(dict['sideChat.synced']))

// A change the user makes on the side card's own page stops following.
sideForm.emit({ value: { pluginSettings: { sidechat: { submitKey: 'enter' } } } })
await wait(0)
tree = suite.render()
assert.equal(sideModeOf().follow, false, 'a manual side-card change turns following off')
assert.equal(sideModeOf().sync, 'conflict')
assert.ok(textOf(tree).includes(dict['sideChat.conflict']))
assert.equal(sideForm.calls.length, 1, 'and it does not fight that choice')

// Our own mapping change re-projects instead of looking like a user edit.
suite = mountPage({ sidebar: 'mod-enter' })
tree = suite.render()
dict = suite.dict
sideForm = suite.sidebarForm
switcher(tree).props.onClick()
await wait(0)
assert.equal(sideForm.calls.length, 0, 'nothing to write when both sides already agree')
assert.equal(sideModeOf().follow, true)
selects(suite.render())[0].props.onChange({ target: { value: 'steer' } })
tree = suite.render()
selects(tree)[1].props.onChange({ target: { value: 'newline' } })
tree = suite.render()
button(tree, '保存').props.onClick()
await wait(0)
tree = suite.render()
assert.deepEqual(sideForm.calls.at(-1), [
  { op: 'set', path: ['pluginSettings', 'sidechat', 'submitKey'], value: 'enter' },
], 'Enter now sending re-projects onto the side card enter mode')
assert.equal(sideModeOf().follow, true, 'our own re-projection never turns following off')
assert.equal(sideModeOf().sync, 'on')

// The default preset means "native everywhere", so the side card sends with Enter.
suite = mountPage({ sidebar: 'mod-enter' })
tree = suite.render()
dict = suite.dict
sideForm = suite.sidebarForm
switcher(tree).props.onClick()
await wait(0)
radio(tree, '默认配置').props.onClick()
await wait(0)
tree = suite.render()
assert.deepEqual(sideForm.calls.at(-1), [
  { op: 'set', path: ['pluginSettings', 'sidechat', 'submitKey'], value: 'enter' },
], 'the default preset projects onto the side card enter mode')
assert.equal(sideModeOf().follow, true, 'a preset switch is our own change, not a conflict')
assert.equal(sideModeOf().mode, 'enter')

// A snapshot that arrives while the write is in flight is not a user edit.
suite = mountPage({ sidebar: 'enter' })
tree = suite.render()
dict = suite.dict
sideForm = suite.sidebarForm
let release = null
sideForm.hold = new Promise((resolve) => { release = resolve })
switcher(tree).props.onClick()
await wait(0)
assert.equal(sideModeOf().follow, true, 'an in-flight write keeps the switch on')
sideForm.emit({ value: { pluginSettings: { sidechat: { submitKey: 'enter' } } } })
await wait(0)
assert.equal(sideModeOf().follow, true, 'a stale snapshot during the write is not a user edit')
sideForm.hold = null
release()
await wait(0)
tree = suite.render()
assert.equal(sideModeOf().mode, 'mod-enter', 'the accepted write becomes the live mode')
assert.equal(sideModeOf().follow, true)
assert.equal(sideForm.calls.length, 1)

// A refused write keeps the local switch on and says so.
suite = mountPage({ sidebar: 'enter' })
tree = suite.render()
dict = suite.dict
sideForm = suite.sidebarForm
sideForm.accept = false
switcher(tree).props.onClick()
await wait(0)
tree = suite.render()
assert.equal(sideModeOf().sync, 'rejected')
assert.equal(sideModeOf().follow, true, 'a refusal does not silently disable following')
assert.ok(textOf(tree).includes(dict['sideChat.rejected']))
assert.equal(sideForm.calls.length, 1)

// A persisted "on" re-projects on the next boot.
suite = mountPage({ sidebar: 'enter', sidechatFollow: true })
tree = suite.render()
await wait(0)
assert.equal(suite.sidebarForm.calls.length, 1, 'booting with following on re-projects')
assert.equal(suite.sidebarForm.calls[0][0].value, 'mod-enter')
assert.equal(sideModeOf().follow, true)
assert.equal(sideModeOf().mode, 'mod-enter')

// --- storage failure is reported, then cleared once writes work again ------
// Runs last: it leaves the fake store's setItem swapped out for two renders.
const realSetItem = fakeWindow.localStorage.setItem
fakeWindow.localStorage.setItem = () => { throw new Error('quota exceeded') }
suite = mountPage()
tree = suite.render()
dict = suite.dict
selects(tree)[2].props.onChange({ target: { value: 'newline' } })
tree = suite.render()
button(tree, '保存').props.onClick()
tree = suite.render()
assert.ok(textOf(tree).includes(dict['storage.volatile']), 'a failed write is surfaced on the page')
assert.equal(fakeWindow.__dshEnterNewline.getStatus().storage, 'volatile', 'the API reports the volatile store')
assert.equal(
  logs.warn.filter(args => String(args[1] ?? '').includes('localStorage write failed')).length,
  1,
  'the failure is logged once',
)

// A later successful write clears the warning instead of keeping it forever.
fakeWindow.localStorage.setItem = realSetItem
selects(tree)[0].props.onChange({ target: { value: 'queue' } })
tree = suite.render()
button(tree, '保存').props.onClick()
tree = suite.render()
assert.equal(textOf(tree).includes(dict['storage.volatile']), false, 'the warning clears after a successful write')
assert.equal(fakeWindow.__dshEnterNewline.getStatus().storage, 'local', 'the API reports persistence again')
assert.equal(
  logs.info.filter(args => String(args[1] ?? '').includes('localStorage recovered')).length,
  1,
  'the recovery is logged once',
)

console.log('client.js harness: all assertions passed')
