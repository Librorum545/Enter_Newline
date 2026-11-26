import { readFileSync } from 'node:fs'
import assert from 'node:assert'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

// Minimal React stand-in: elements become plain descriptor objects, and useState
// keeps a per-component hook store so the Settings page can be driven like a
// real render (change a preset, edit a select, click Save, render again).
const hooks = { index: 0, store: [] }
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

const mount = ({ bindings, preset, busyEnter } = {}) => {
  listeners = []
  hooks.index = 0
  hooks.store.length = 0
  fakeDocument.composers = []
  fakeDocument.menus = []
  if (bindings === undefined) storage.delete(STORAGE_KEY)
  else storage.set(STORAGE_KEY, JSON.stringify(bindings))
  if (preset === undefined) storage.delete(PRESET_KEY)
  else storage.set(PRESET_KEY, preset)

  const plugin = createPlugin()
  const registrations = []
  const dictionaries = []
  const conversationForm = {
    getSnapshot: () => ({ value: busyEnter === undefined ? undefined : { busyEnter } }),
  }
  const ctx = {
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') dispose() },
    inject(deps, callback) {
      if (!deps.includes('configForms')) return
      callback({
        configForms: { get: namespace => {
          assert.equal(namespace, 'ui-conversation')
          return conversationForm
        } },
        effect() {},
      })
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
  return { plugin, registrations, dictionaries }
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
  'error.allNewline', 'error.noNewline',
  'io.badFormat', 'io.badJson', 'io.badPlugin', 'io.copy', 'io.copyFailed', 'io.copied',
  'io.export', 'io.import', 'io.imported', 'io.title',
  'nav', 'page.title',
  'preset.dsh', 'preset.dsh.desc', 'preset.plugin', 'preset.plugin.desc', 'preset.title',
  'select.aria', 'status.dsh', 'status.plugin', 'status.saved',
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

// --- menu scoping ----------------------------------------------------------
// A visible listbox elsewhere on the page no longer disables the composer.
mount()
const ownCard = makeCard()
const scoped = makeComposer({ card: ownCard })
fakeDocument.menus = [new FakeElement()]
;({ event, replay } = press(scoped))
assert.ok(event.defaultPrevented, 'a listbox outside the composer card does not block the keys')
assert.equal(replay.shiftKey, true)

// The composer's own completion menu still owns Enter.
ownCard.querySelectorAll = () => [new FakeElement()]
;({ event, replay } = press(scoped))
assert.ok(!event.defaultPrevented, 'the composer card menu keeps Enter')
assert.equal(replay, undefined)

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

// --- anchor diagnostic ------------------------------------------------------
mount()
const editableCard = makeCard()
const editableTarget = Object.assign(new FakeElement(), {
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
rows[0].props.onChange({ target: { value: 'newline' } })
tree = suite.render()
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

// --- parse/build helpers ---------------------------------------------------
assert.deepEqual(first.plugin.__test.parseImportDocument('null'), { error: 'io.badJson' })
assert.deepEqual(first.plugin.__test.parseImportDocument('[]'), { error: 'io.badJson' })
assert.equal(first.plugin.__test.parseImportDocument(JSON.stringify({ enter: 'newline' })).bindings.enter, 'newline')
assert.equal(first.plugin.__test.buildExportDocument().includes('"plugin": "dsh-enter-newline"'), true)

// --- icon ------------------------------------------------------------------
const iconTree = icon.component({ size: 20, active: true })
assert.equal(iconTree.props.width, 20)
assert.equal(iconTree.props.stroke, 'currentColor')

console.log('client.js harness: all assertions passed')
