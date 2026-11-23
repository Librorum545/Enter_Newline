import { readFileSync } from 'node:fs'
import assert from 'node:assert'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

// Minimal React stand-in: elements become plain descriptor objects, and useState
// keeps a per-component hook store so the Settings page can be driven like a
// real render (change a select, click Save, render again).
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

class FakeElement {}
class FakeKeyboardEvent {
  constructor(type, init = {}) {
    this.type = type
    this.defaultPrevented = false
    this.propagationStopped = false
    Object.assign(this, init)
  }
  preventDefault() { this.defaultPrevented = true }
  stopImmediatePropagation() { this.propagationStopped = true }
}

const storage = new Map()
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

let listeners = []
const fakeDocument = { querySelectorAll: () => [] }

const run = new Function('window', 'document', 'Element', 'KeyboardEvent', source)
run(fakeWindow, fakeDocument, FakeElement, FakeKeyboardEvent)

const registration = fakeWindow.registration
assert.equal(registration.id, '@local/composer-enter-newline')

const STORAGE_KEY = 'composer-enter-newline:bindings:v1'

const createPlugin = () => registration.factory(name => {
  if (name === 'react') return React
  throw new Error(`unexpected require: ${name}`)
})

const mount = ({ bindings, busyEnter } = {}) => {
  listeners = []
  if (bindings === undefined) storage.delete(STORAGE_KEY)
  else storage.set(STORAGE_KEY, JSON.stringify(bindings))

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

const composer = Object.assign(new FakeElement(), {
  isContentEditable: true,
  hasAttribute: () => false,
  events: [],
  dispatchEvent(event) { this.events.push(event); return true },
  closest: () => composer,
})
const target = Object.assign(new FakeElement(), {
  closest: selector => (selector === '[data-composer-input]' ? composer : null),
})

const press = (init) => {
  composer.events.length = 0
  const event = new FakeKeyboardEvent('keydown', { key: 'Enter', keyCode: 13, target, ...init })
  listeners.filter(l => l.type === 'keydown').forEach(l => l.fn(event))
  return { event, replay: composer.events[0] }
}

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
  'button.discard', 'button.save',
  'error.allNewline', 'error.noNewline',
  'nav', 'note', 'page.title', 'select.aria', 'status.saved',
].sort())

// --- default bindings ------------------------------------------------------
// No stored map, and the settings service reports no preference: plain Enter
// carries the preferred (queue) mode, so a steer action replays the chord.
mount({ busyEnter: undefined })

let { event, replay } = press({})
assert.ok(event.defaultPrevented, 'Enter is intercepted')
assert.equal(replay.shiftKey, true, 'Enter (newline) replays as Shift+Enter')

;({ event, replay } = press({ ctrlKey: true }))
assert.ok(event.defaultPrevented, 'Ctrl+Enter is intercepted')
assert.equal(replay.ctrlKey, true, 'Ctrl+Enter (steer) replays the accelerated chord')
assert.equal(replay.shiftKey, false)

;({ event, replay } = press({ shiftKey: true }))
assert.ok(event.defaultPrevented, 'Shift+Enter (queue) is intercepted')
assert.equal(replay.ctrlKey, false, 'Shift+Enter (queue) replays plain Enter')
assert.equal(replay.shiftKey, false)

;({ event, replay } = press({ ctrlKey: true, shiftKey: true }))
assert.ok(!event.defaultPrevented, 'Ctrl+Shift+Enter stays untouched')
assert.equal(replay, undefined)

;({ event } = press({ ctrlKey: true, metaKey: true }))
assert.ok(!event.defaultPrevented, 'Ctrl+Cmd+Enter stays untouched')

;({ event } = press({ ctrlKey: true, isComposing: true }))
assert.ok(!event.defaultPrevented, 'IME composition Enter stays untouched')

// --- steering preference flips the chord -----------------------------------
mount({ busyEnter: 'steer' })
;({ replay } = press({ ctrlKey: true }))
assert.equal(replay.ctrlKey, false, 'with steer preferred, a steer action uses plain Enter')
;({ replay } = press({ shiftKey: true }))
assert.equal(replay.ctrlKey, true, 'with steer preferred, a queue action uses the chord')

// --- a saved map drives the gestures --------------------------------------
mount({ bindings: { enter: 'queue', ctrlEnter: 'newline', shiftEnter: 'newline' }, busyEnter: 'queue' })
;({ replay } = press({}))
assert.equal(replay.ctrlKey, false, 'saved Enter=queue replays plain Enter')
;({ replay } = press({ ctrlKey: true }))
assert.equal(replay.shiftKey, true, 'saved Ctrl+Enter=newline replays Shift+Enter')
;({ event } = press({ shiftKey: true }))
assert.ok(!event.defaultPrevented, 'Shift+Enter mapped to a line break keeps the native path')

// An invalid stored map falls back to the defaults instead of breaking input.
mount({ bindings: { enter: 'explode', ctrlEnter: 42 } })
;({ replay } = press({}))
assert.equal(replay.shiftKey, true, 'unknown actions fall back to the defaults')

// --- the settings page -----------------------------------------------------
const { registrations, dictionaries } = mount()
const page = registrations.find(r => r.options.name === 'settings.section').component
const dict = dictionaries[0].zh

const renderPage = () => {
  hooks.index = 0
  const t = (key, params) => (dict[key] ?? `!!${key}`)
    .replace(/\{(\w+)\}/g, (match, name) => (params?.[name] === undefined ? match : String(params[name])))
  return page({ t })
}
const selects = tree => elementsOf(tree, 'select')
const button = (tree, label) => elementsOf(tree, 'button').find(el => textOf(el) === label)

// Defaults render in the requested order with the requested values.
let tree = renderPage()
assert.equal(textOf(tree).includes('!!'), false, 'every rendered key exists')
const rows = selects(tree)
assert.deepEqual(rows.map(el => el.props['aria-label']), ['Enter 按键行为', 'Ctrl/Cmd+Enter 按键行为', 'Shift+Enter 按键行为'])
assert.deepEqual(rows.map(el => el.props.value), ['newline', 'steer', 'queue'])
assert.deepEqual(rows.map(el => elementsOf(el, 'option').map(option => textOf(option))), [
  ['插入换行', '插话发送', '排队发送'],
  ['插入换行', '插话发送', '排队发送'],
  ['插入换行', '插话发送', '排队发送'],
])

// Save starts disabled and grey while the draft equals the saved map.
const saveButton = pageTree => button(pageTree, '保存')
assert.equal(saveButton(tree).props.disabled, true, 'save is disabled without changes')
assert.equal(saveButton(tree).props.style.background, 'var(--dsw-alias-bg-module-platform)', 'disabled save is grey')
assert.equal(saveButton(tree).props.style.color, 'var(--dsw-alias-label-tertiary)', 'disabled save text is muted')

// Any change arms the button with the brand colour.
rows[0].props.onChange({ target: { value: 'steer' } })
tree = renderPage()
assert.equal(saveButton(tree).props.disabled, false, 'save is enabled after a change')
assert.equal(saveButton(tree).props.style.background, 'var(--dsw-alias-brand-primary-new-colorprimary-new-color, #4d6bfe)', 'enabled save is deep')
rows[0].props.onChange({ target: { value: 'newline' } })
tree = renderPage()
assert.equal(saveButton(tree).props.disabled, true, 'reverting to the saved map disables save again')

// All-newline is refused on Save, and nothing is persisted. The warning only
// appears at save time, never while the user is still adjusting.
for (const el of rows) el.props.onChange({ target: { value: 'newline' } })
tree = renderPage()
assert.equal(textOf(tree).includes(dict['error.allNewline']), false, 'no warning while editing')
button(tree, '保存').props.onClick()
tree = renderPage()
assert.ok(textOf(tree).includes(dict['error.allNewline']), 'the refusal survives the render')
assert.equal(storage.has(STORAGE_KEY), false, 'refused save writes nothing')

// A usable map saves, persists and reports success.
const valid = ['steer', 'queue', 'newline']
selects(tree).forEach((el, index) => { el.props.onChange({ target: { value: valid[index] } }) })
tree = renderPage()
assert.equal(saveButton(tree).props.disabled, false, 'dirty map arms save')
button(tree, '保存').props.onClick()
tree = renderPage()
assert.equal(textOf(tree).includes(dict['status.saved']), true, 'saved status appears')
assert.deepEqual(JSON.parse(storage.get(STORAGE_KEY)), { enter: 'steer', ctrlEnter: 'queue', shiftEnter: 'newline' })
assert.equal(saveButton(tree).props.disabled, true, 'a saved map disables save again')

// Discard returns the draft to the saved map.
selects(tree)[0].props.onChange({ target: { value: 'newline' } })
tree = renderPage()
assert.equal(saveButton(tree).props.disabled, false, 'discard target is dirty')
button(tree, '放弃').props.onClick()
tree = renderPage()
assert.deepEqual(selects(tree).map(el => el.props.value), ['steer', 'queue', 'newline'])
assert.equal(textOf(tree).includes(dict['status.saved']), false, 'discard clears the saved status')
assert.equal(saveButton(tree).props.disabled, true, 'discard leaves save disabled')

// --- icon ------------------------------------------------------------------
const iconTree = icon.component({ size: 20, active: true })
assert.equal(iconTree.props.width, 20)
assert.equal(iconTree.props.stroke, 'currentColor')

console.log('client.js harness: all assertions passed')
