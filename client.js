/**
 * Browser half of the bundle.
 *
 * 1. Composer key remap, driven by two whole presets the Settings page offers:
 *      default preset ("follow DSH") — every gesture passes through untouched;
 *        the page reads the live busy-Enter preference and shows what DSH does.
 *      plugin preset — Enter / Ctrl·Cmd+Enter / Shift·Enter are remapped to
 *        line break / steer / queue (each gesture editable on the page).
 *
 *    Every plugin-preset gesture resolves to one of three actions: insert a
 *    line break, steer (join the running turn), or queue (wait for the turn to
 *    finish). The actions replay into the composer's own event path, so its
 *    keymap, IME guard, menu arbitration, undo history and submit policy stay
 *    authoritative:
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
 *    The completion popup is arbitrated in three states instead of "visible or
 *    not": a highlight lets the popup keep Enter, a popup with no highlight
 *    swallows it (DSH would otherwise answer "pass" and submit the draft), and
 *    no popup means the mapping applies. The failure direction is deliberate:
 *    "Enter does nothing" is always better than "half a draft was sent", so a
 *    renamed composer anchor also swallows send gestures instead of falling
 *    back to the host's send path.
 *
 * 2. IME grace. DSH's composer keymap treats Enter as "still composing" for
 *    10ms after `compositionend` (Safari delivers the closing keydown after
 *    it). A replayed send inside that window would be swallowed, so a send
 *    gesture seen there is deferred until the window has passed; a line-break
 *    replay is dispatched immediately because the keymap checks Shift+Enter
 *    before its IME guard.
 *
 * 3. Diagnostics: `window.__dshEnterNewline.getStatus()` reports the live
 *    preset, bindings, busy-Enter value, anchor state and the last decision the
 *    keydown handler took; `inspect()` returns it as JSON. The Settings page
 *    copies it, so a report can be attached to a bug without reading DevTools.
 *
 * 4. Settings page ("Enter 换行"): the effective mapping summary, the two
 *    presets, the three gesture selects (plugin preset only), Save/Discard,
 *    export/import of the saved configuration, a runtime self-check, and the
 *    optional side-chat follow switch.
 *
 * 5. Side chat (dsh-better-sidebar): its composer is a plain textarea with its
 *    own two-mode keymap (Enter sends, or Ctrl/Cmd+Enter sends), so it cannot
 *    carry three absolute actions. Instead of intercepting its keys, the page
 *    shows that mode read-only and live, and an opt-in switch projects this
 *    plugin's Enter mapping onto it by writing the side card's own
 *    `pluginSettings.sidechat.submitKey` through the settings forms service —
 *    the side card keeps native textarea editing, its undo stack and its IME
 *    guard. The namespace is found by its schema shape (the row id is a mount
 *    choice), and the switch turns itself off when the observed mode can only
 *    have come from the user editing the side card's page.
 *
 *    Bindings persist in localStorage (`composer-enter-newline:bindings:v1`)
 *    and the preset in `composer-enter-newline:preset`: a key map belongs to
 *    the browser that presses the keys, not to the shared settings document.
 *    The storage keys, the locale namespace and the slot ids keep their
 *    original `composer-enter-newline` spelling on purpose: they are internal
 *    identities, so renaming them with the package would orphan saved
 *    bindings and re-register dictionaries for no user-visible gain.
 */
window.__ModuleLoader__.load({
  id: 'dsh-enter-newline',
  factory(require) {
    const React = require('react')
    const { useState, useEffect } = React
    const h = React.createElement

    /** Package name used in console diagnostics. */
    const PLUGIN_NAME = 'dsh-enter-newline'
    /** Single console prefix, so the plugin is easy to filter in DevTools. */
    const LOG = `[${PLUGIN_NAME}]`
    /** The composer's Lexical contenteditable host (rendered with this marker). */
    const COMPOSER_SELECTOR = '[data-composer-input]'
    /** The composer card that owns the editable surface and its overlays. */
    const CARD_SELECTOR = '[data-composer-card]'
    /** Completion popups ("/" commands, "@" references) carry this marker. */
    const MENU_SELECTOR = '[data-trigger-menu]'
    /** Older skins exposed the listbox through the input overlay. */
    const OVERLAY_MENU_SELECTOR = '[data-composer-overlay] [role="listbox"]'
    /** Fallback used only when the composer card is missing (DSH layout change). */
    const FALLBACK_MENU_SELECTOR = '[data-trigger-menu], [role="listbox"]'
    /** Any editable host, used by the "anchor missing" diagnostic. */
    const EDITABLE_SELECTOR = '[contenteditable]'
    /** The popup listbox that carries the keyboard highlight. */
    const LISTBOX_SELECTOR = '[role="listbox"]'
    /** The highlight reaches the DOM only through this attribute. */
    const HIGHLIGHT_ATTR = 'aria-activedescendant'
    /** Package version exposed by the diagnostics API (`npm test` keeps it honest). */
    const VERSION = '1.4.0'
    /** Mirrors DSH's own `composingUntil = Date.now() + 10`, with a 2ms margin. */
    const COMPOSITION_GRACE_MS = 12
    /** Replayed events, so the capture listener ignores its own dispatches. */
    const replayed = new WeakSet()

    // --- bindings -----------------------------------------------------------

    /** Storage key for the saved key map. */
    const STORAGE_KEY = 'composer-enter-newline:bindings:v1'
    /** Storage key for the selected preset ("plugin" | "dsh"). */
    const PRESET_KEY = 'composer-enter-newline:preset'
    /** Actions a gesture can perform in the plugin preset. */
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

    /** Whether a write failed at least once (surfaced by the page and the API). */
    let storageFailed = false

    /**
     * Persist one value, remembering a failure so the page can say
     * "this session only" instead of a false "Saved". A later successful write
     * clears the flag again: quota and private-mode failures are often
     * transient, and a permanent warning would keep lying after recovery.
     * @param key - the storage key.
     * @param value - the serialized value.
     * @returns whether the value reached the store.
     */
    function persist(key, value) {
      try {
        window.localStorage.setItem(key, value)
        if (storageFailed) {
          storageFailed = false
          console.info(LOG, 'localStorage recovered; the setting is persisted again')
        }
        return true
      } catch {
        // Log the transition only, so a full quota does not flood the console.
        if (!storageFailed) {
          storageFailed = true
          console.warn(LOG, 'localStorage write failed; the setting only applies to this session')
        }
        return false
      }
    }

    /**
     * Persist a binding map and make it live for the next keystroke.
     * @param next - the map to save.
     * @returns the saved map.
     */
    function writeBindings(next) {
      bindings = normalizeBindings(next)
      const stored = persist(STORAGE_KEY, JSON.stringify(bindings))
      console.info(LOG, stored ? 'bindings saved' : 'bindings saved (not persisted)', { ...bindings })
      // The side card's mode is a projection of this map: re-project on change.
      reconcileSideChat()
      return bindings
    }

    /** Live binding map the keydown listener reads. */
    let bindings = readBindings()

    /**
     * @returns the selected preset, defaulting to the plugin preset.
     */
    function readPreset() {
      try {
        return window.localStorage.getItem(PRESET_KEY) === 'dsh' ? 'dsh' : 'plugin'
      } catch {
        return 'plugin'
      }
    }

    /**
     * Switch presets; the change applies and persists immediately.
     * @param next - "plugin" or "dsh".
     * @returns the applied preset.
     */
    function writePreset(next) {
      preset = next === 'dsh' ? 'dsh' : 'plugin'
      persist(PRESET_KEY, preset)
      console.info(LOG, 'preset', preset)
      // The default preset means "native everywhere", which the side card also
      // conceals as its own `enter` default.
      reconcileSideChat()
      return preset
    }

    /** Live preset the keydown listener reads ("dsh" = leave everything native). */
    let preset = readPreset()

    // --- side chat (dsh-better-sidebar) -------------------------------------

    /*
     * The side card's own composer is a plain textarea with its own two-mode
     * keymap (`submitKey`: Enter sends, or Ctrl/Cmd+Enter sends). Two modes
     * cannot carry three absolute actions, so this integration does not
     * intercept its keys: while the switch is on, this plugin's Enter mapping
     * is PROJECTED onto that mode and written into the side card's own
     * settings. Everything else keeps running in the side card's code, which
     * keeps native textarea editing, its undo stack and its IME guard intact.
     *
     * The page always shows the mode the side card currently holds, read-only
     * and live, whether the switch is on or off. The switch turns itself off
     * when the mode it sees can only have come from the user editing the side
     * card's page — never merely because a write is still in flight.
     */

    /** Storage key of the follow switch (independent of the binding map). */
    const SIDE_CHAT_KEY = 'composer-enter-newline:sidechat-sync'
    /** Config fields only the side card's row schema declares. */
    const SIDE_CHAT_SIGNATURE = ['pluginSettings', 'tabsEnabled']
    /** The side card's settings namespace (its Loader row id), once discovered. */
    let sideChatNamespace = null
    /** The side card's settings form, once the namespace is served. */
    let sideChatForm = null
    /** Mode the side card reports: 'enter' | 'mod-enter', or null when unreadable. */
    let sideChatMode = null
    /** How many namespaces the settings document reports (detection diagnostics). */
    let sideChatNamespaces = null
    /** The mode this plugin last wrote or adopted; a different one is a user edit. */
    let sideChatOwnedMode = null
    /** Whether the follow switch is on; off by default and persisted. */
    let sideChatFollow = readSideChatFollow()
    /** A write is in flight, so observations until it settles are not user edits. */
    let sideChatPending = false
    /** The last write was refused or failed. */
    let sideChatRejected = false
    /** The switch turned itself off because the side card holds another mode. */
    let sideChatConflict = false
    /** Mounted settings pages, re-rendered whenever the side card changes. */
    const pageListeners = new Set()

    /** @returns whether a listener was added. */
    function subscribePage(listener) {
      pageListeners.add(listener)
      return () => { pageListeners.delete(listener) }
    }

    /** Re-render every mounted settings page. */
    function notifyPage() {
      for (const listener of [...pageListeners]) {
        try {
          listener()
        } catch { /* one page must not break the sync */ }
      }
    }

    /** @returns whether the follow switch was persisted on. */
    function readSideChatFollow() {
      try {
        return window.localStorage.getItem(SIDE_CHAT_KEY) === 'on'
      } catch {
        return false
      }
    }

    /**
     * Locate the side card's namespace by its schema shape: the row id is a
     * mount choice (`better-sidebar`, `web-ui-better-sidebar`, …), so an id
     * search would miss re-mounted deployments. The wire schema is schemastery's
     * compressed envelope — `{ uid, refs }` with the root node at
     * `refs[uid]` — so the shape lives there, not on the envelope itself.
     * @param view - the settings mirror's describe view.
     * @returns the namespace, or null when no row carries that schema.
     */
    function findSideChatNamespace(view) {
      const namespaces = view?.namespaces
      if (!Array.isArray(namespaces)) return null
      for (const namespace of namespaces) {
        const schema = namespace?.schema
        if (schema === null || typeof schema !== 'object') continue
        const refs = schema.refs
        const root = refs !== null && typeof refs === 'object'
          ? refs[String(schema.uid)]
          : schema
        const dict = root?.dict
        if (dict === null || typeof dict !== 'object') continue
        if (SIDE_CHAT_SIGNATURE.every(field => Object.hasOwn(dict, field))) return namespace.ns
      }
      // Second pass on the resolved value: a `pluginSettings.sidechat` blob is
      // unambiguous, and survives a future rename of the schema fields.
      for (const namespace of namespaces) {
        const blob = namespace?.value?.pluginSettings
        if (blob === null || typeof blob !== 'object') continue
        const sidechat = blob.sidechat
        if (sidechat !== null && typeof sidechat === 'object') return namespace.ns
      }
      return null
    }

    /**
     * The mode the side card reports, mirroring its own parser (anything that
     * is not `mod-enter` reads as `enter`).
     * @param value - the resolved settings section.
     * @returns the mode, or null when the section has not resolved yet.
     */
    function readSideChatMode(value) {
      if (value === null || value === undefined) return null
      return value.pluginSettings?.sidechat?.submitKey === 'mod-enter' ? 'mod-enter' : 'enter'
    }

    /**
     * The side card mode this plugin's own mapping projects onto. Its two modes
     * only answer "which key sends", so Enter's meaning is the one carried over.
     * @returns 'mod-enter' when Enter means a line break, else 'enter'.
     */
    function projectSideChatMode() {
      if (preset === 'dsh') return 'enter'
      return bindings.enter === 'newline' ? 'mod-enter' : 'enter'
    }

    /**
     * Write one mode into the side card's own settings blob (a declared open
     * map, so this is the plugin's supported cross-plugin seam).
     * @param mode - 'enter' or 'mod-enter'.
     * @returns whether the side card accepted it.
     */
    async function writeSideChat(mode) {
      if (sideChatForm === null) return false
      sideChatPending = true
      try {
        const accepted = await sideChatForm.mutate([
          { op: 'set', path: ['pluginSettings', 'sidechat', 'submitKey'], value: mode },
        ])
        sideChatRejected = accepted === false
        if (accepted !== false) sideChatOwnedMode = mode
        return accepted !== false
      } catch {
        sideChatRejected = true
        return false
      } finally {
        sideChatPending = false
        notifyPage()
      }
    }

    /**
     * Keep the side card's mode equal to this plugin's projection while the
     * switch is on, and stop following when the difference can only be the
     * user's own edit on the side card's page.
     */
    function reconcileSideChat() {
      if (!sideChatFollow || sideChatPending || sideChatMode === null) return
      const target = projectSideChatMode()
      if (sideChatMode === target) {
        sideChatOwnedMode = sideChatMode
        sideChatRejected = false
        return
      }
      // Our own projection moved (mapping or preset change, or the first write
      // after enabling): adopt the observed mode first, so the snapshot that
      // follows our write cannot be mistaken for a user edit.
      if (sideChatOwnedMode === null || sideChatMode === sideChatOwnedMode) {
        sideChatOwnedMode = sideChatMode
        void writeSideChat(target)
        return
      }
      // Neither what we wrote nor what our mapping asks for: the user picked
      // another mode there. Stop following instead of fighting their choice.
      sideChatFollow = false
      sideChatConflict = true
      persist(SIDE_CHAT_KEY, 'off')
      notifyPage()
    }

    /**
     * Adopt one side-card snapshot into the live state.
     */
    function adoptSideChat() {
      let value
      try {
        value = sideChatForm?.getSnapshot()?.value
      } catch {
        value = undefined
      }
      sideChatMode = readSideChatMode(value)
      reconcileSideChat()
      notifyPage()
    }

    /**
     * Turn the follow switch on or off.
     * @param next - the requested state.
     */
    function setSideChatFollow(next) {
      sideChatConflict = false
      sideChatRejected = false
      if (!next) {
        sideChatFollow = false
        persist(SIDE_CHAT_KEY, 'off')
        notifyPage()
        return
      }
      // Adopt what the side card holds now: only a LATER change we did not
      // write may count as the user editing it.
      sideChatOwnedMode = sideChatMode
      sideChatFollow = true
      persist(SIDE_CHAT_KEY, 'on')
      const target = projectSideChatMode()
      if (sideChatMode !== null && sideChatMode !== target) void writeSideChat(target)
      notifyPage()
    }

    /**
     * Follow one side-card namespace: subscribe to its form and adopt snapshots.
     * @param configForms - the settings forms service.
     * @param namespace - the side card's Loader row id.
     * @returns the subscription teardown.
     */
    function attachSideChat(configForms, namespace) {
      sideChatNamespace = namespace
      try {
        sideChatForm = configForms.get(namespace)
      } catch {
        // A served row whose form cannot be opened stays "not detected": the
        // page must not claim a mode it cannot read.
        sideChatForm = null
        sideChatNamespace = null
        return () => {}
      }
      const off = sideChatForm.subscribe(adoptSideChat)
      adoptSideChat()
      return () => {
        off()
        sideChatForm = null
        sideChatNamespace = null
        sideChatMode = null
        notifyPage()
      }
    }

    /**
     * Discover the side card from the settings mirror and (re)attach when the
     * document reports it, because describe only lists live plugin rows.
     * @param configForms - the settings forms service.
     * @returns the teardown for both subscriptions.
     */
    function watchSideChat(configForms) {
      let offForm = null
      let offMirror = null
      const discover = () => {
        let view
        try {
          view = configForms.describe().getSnapshot().view
        } catch {
          view = undefined
        }
        const namespace = findSideChatNamespace(view)
        sideChatNamespaces = Array.isArray(view?.namespaces) ? view.namespaces.length : null
        if (namespace === null) {
          if (offForm !== null) {
            offForm()
            offForm = null
            notifyPage()
          }
          return
        }
        if (namespace === sideChatNamespace && sideChatForm !== null) return
        if (offForm !== null) offForm()
        offForm = attachSideChat(configForms, namespace)
      }
      discover()
      try {
        offMirror = configForms.describe().subscribe(discover)
      } catch {
        offMirror = null
      }
      return () => {
        if (offForm !== null) offForm()
        if (offMirror !== null) offMirror()
      }
    }

    // --- composer key remap -------------------------------------------------

    /** Conversation config form, read for the live busy-send preference. */
    let conversationForm = null

    /**
     * The busy-Enter preference DSH currently holds.
     * @returns 'steer', 'queue', or undefined when unreadable.
     */
    function readBusyEnter() {
      let value
      try {
        value = conversationForm?.getSnapshot()?.value
      } catch {
        value = undefined
      }
      if (value?.busyEnter === 'steer') return 'steer'
      if (value?.busyEnter === 'queue') return 'queue'
      return undefined
    }

    /**
     * The behavior the composer gives plain Enter: its busy-send preference.
     * @returns 'steer' or 'queue'; queue matches the shipped default.
     */
    function preferredBusyBehavior() {
      return readBusyEnter() === 'steer' ? 'steer' : 'queue'
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
     * @returns whether the element is laid out (same check the menu uses).
     * @param element - candidate menu or popup.
     */
    function isVisible(element) {
      return element.getClientRects().length > 0
    }

    /**
     * Arbitrate the completion popup for this composer.
     * @param scope - the composer card, or the document in the no-card fallback.
     * @param card - the composer card, or null when the layout has no card.
     * @returns 'pick' when a highlight exists (the popup owns Enter), 'block'
     *   when the popup is open without one (Enter must not reach the submit
     *   gesture), or 'none'.
     */
    function menuState(scope, card) {
      const selector = card === null ? FALLBACK_MENU_SELECTOR : `${MENU_SELECTOR}, ${OVERLAY_MENU_SELECTOR}`
      const menus = []
      for (const menu of scope.querySelectorAll(selector)) {
        if (isVisible(menu)) menus.push(menu)
      }
      if (menus.length === 0) return 'none'
      // Without a card a page-wide popup cannot be attributed to this composer,
      // so the old "any visible popup wins" behaviour stays (it never blocks).
      if (card === null) return 'pick'
      for (const menu of menus) {
        const listboxes = typeof menu.matches === 'function' && menu.matches(LISTBOX_SELECTOR)
          ? [menu]
          : [...menu.querySelectorAll(LISTBOX_SELECTOR)]
        for (const listbox of listboxes) {
          if ((listbox.getAttribute(HIGHLIGHT_ATTR) ?? '') !== '') return 'pick'
        }
        // A skin that carries the highlight on the popup shell itself.
        if ((menu.getAttribute(HIGHLIGHT_ATTR) ?? '') !== '') return 'pick'
      }
      return 'block'
    }

    /**
     * Classify the Enter a keydown carries.
     * @param event - the keydown event.
     * @returns 'enter' | 'ctrlEnter' | 'shiftEnter', or null for a gesture the
     *   composer keeps for itself (Alt, AltGraph, both primaries, chord+Shift).
     */
    function gestureOf(event) {
      if (event.altKey) return null
      if (typeof event.getModifierState === 'function' && event.getModifierState('AltGraph')) return null
      if (event.ctrlKey && event.metaKey) return null
      const chord = event.ctrlKey || event.metaKey
      if (chord && event.shiftKey) return null
      return chord ? 'ctrlEnter' : event.shiftKey ? 'shiftEnter' : 'enter'
    }

    /**
     * @returns whether a keydown landed on a composer-shaped editable surface:
     *   a card whose editable host is actually editable. The card scope is what
     *   keeps this safe — DSH has exactly one contenteditable in the client.
     * @param target - the keydown target.
     */
    function isComposerShaped(target) {
      if (!(target instanceof Element)) return false
      if (target.closest(CARD_SELECTOR) === null) return false
      const editable = target.closest(EDITABLE_SELECTOR)
      return editable !== null && editable.isContentEditable === true
    }

    /** Whether a composer has been seen, used by the settings-page self-check. */
    let sawComposer = false
    /** Whether the "anchor missing" warning was already emitted. */
    let anchorWarningShown = false
    /** The last Enter this plugin saw: its gesture and the exit that was taken. */
    let lastKey = null
    /** How many Enters were swallowed because the popup had no highlight. */
    let menuBlocks = 0

    /**
     * Record one keydown decision for the diagnostics API.
     * @param decision - the exit the handler took.
     * @param gesture - the gesture, or null for a reserved chord.
     * @returns the stored record.
     */
    function decided(decision, gesture) {
      lastKey = { at: Date.now(), gesture: gesture ?? null, decision }
      return lastKey
    }

    /**
     * Warn once when an editable composer card no longer owns a
     * `[data-composer-input]` host, which means the selectors were renamed.
     * @param target - the keydown target that missed the composer.
     */
    function warnMissingAnchor(target) {
      if (anchorWarningShown || !(target instanceof Element)) return
      if (target.closest(CARD_SELECTOR) === null) return
      if (target.closest(EDITABLE_SELECTOR) === null) return
      if (target.closest(COMPOSER_SELECTOR) !== null) return
      anchorWarningShown = true
      console.warn(
        `${LOG} composer anchor missing: no ${COMPOSER_SELECTOR} host was found on a keydown in a composer card.`
        + ' DSH may have changed; the remap is inactive for this composer.',
      )
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
     * @param event - the user's Enter keydown (only its repeat flag is used).
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

    // --- IME composition grace ---------------------------------------------

    /** True while a composition is running (set by the window listeners). */
    let composing = false
    /** Wall-clock end of DSH's post-composition guard window. */
    let composingUntil = 0
    /** Pending deferred send replay, cleared on dispose and on a newer key. */
    let pendingReplay = null

    /** A composition started; every Enter until it ends belongs to the IME. */
    function onCompositionStart() {
      composing = true
    }

    /** The composition ended; hold the send path for DSH's grace window. */
    function onCompositionEnd() {
      composing = false
      composingUntil = Date.now() + COMPOSITION_GRACE_MS
    }

    /** Forget composition state (window blur, listener teardown). */
    function resetComposition() {
      composing = false
      composingUntil = 0
      if (pendingReplay !== null) {
        clearTimeout(pendingReplay)
        pendingReplay = null
      }
    }

    /**
     * Defers one send replay until DSH's post-composition window has passed.
     * @param composer - the composer root that owns the gesture.
     * @param action - 'steer' or 'queue'.
     * @param repeat - the user's repeat flag.
     * @param until - the end of the guard window (milliseconds).
     */
    function deferSend(composer, action, repeat, until) {
      if (pendingReplay !== null) {
        clearTimeout(pendingReplay)
        pendingReplay = null
      }
      const wait = Math.max(4, until - Date.now() + 2)
      pendingReplay = setTimeout(() => {
        pendingReplay = null
        if (!composer.isConnected) return
        submitDraft({ repeat }, composer, preferredBusyBehavior() !== action)
      }, wait)
    }

    /**
     * @param event - any keydown seen on the window capture phase.
     */
    function onKeyDown(event) {
      if (replayed.has(event)) return
      // Escape abandons a send still waiting out the composition window. The
      // user is dismissing a popup or cancelling, not sending: replaying the
      // deferred Enter after that would post a draft they meant to keep.
      if (event.key === 'Escape') {
        if (pendingReplay !== null) {
          clearTimeout(pendingReplay)
          pendingReplay = null
          console.info(LOG, 'deferred send cancelled by Escape')
        }
        return
      }
      if (event.key !== 'Enter') return
      const target = event.target
      const gesture = gestureOf(event)
      const composer = composerRoot(target)
      if (composer === null) {
        warnMissingAnchor(target)
        // Without the anchor the gesture cannot be mapped. Failing safe means
        // swallowing a send, never letting the host send half a draft.
        if (gesture === null || preset !== 'plugin') return
        if (composing || event.isComposing || event.keyCode === 229) return
        // A line break never sends, so Shift+Enter keeps its native path.
        if (gesture === 'shiftEnter') return
        if (!isComposerShaped(target)) return
        const missingCard = target.closest(CARD_SELECTOR)
        if (menuState(missingCard, missingCard) === 'pick') return
        event.preventDefault()
        event.stopImmediatePropagation()
        decided('anchor-missing-blocked', gesture)
        return
      }
      sawComposer = true
      // The default preset leaves every gesture to DSH itself.
      if (preset === 'dsh') { decided('preset-dsh', gesture); return }
      // A real composition owns this Enter (candidate pick): let the IME have it.
      if (composing || event.isComposing || event.keyCode === 229) { decided('composing', gesture); return }
      // A read-only composer refuses input: leave it alone.
      if (!composer.isContentEditable) { decided('readonly', gesture); return }
      // Both primary modifiers, or a primary modifier plus Shift, keep their
      // zero behavior in the composer.
      if (gesture === null) { decided('reserved', gesture); return }
      const card = composer.closest(CARD_SELECTOR)
      const menu = menuState(card ?? document, card)
      // A highlight means the popup owns Enter and picks the candidate.
      if (menu === 'pick') { decided('menu-pick', gesture); return }
      if (menu === 'block') {
        // The popup is open without a highlight: DSH's arbitration answers
        // "pass" and the key would fall through to a submit. Nobody asked for a
        // send here, so swallow it; Shift+Enter still breaks the line.
        if (gesture === 'shiftEnter') { decided('native-newline', gesture); return }
        event.preventDefault()
        event.stopImmediatePropagation()
        menuBlocks += 1
        if (menuBlocks === 1) {
          console.info(LOG, 'enter blocked: the completion menu is open without a highlight')
        }
        decided('menu-blocked', gesture)
        return
      }
      const action = bindings[gesture]
      // Shift+Enter mapped to a line break is already the composer's behavior.
      if (gesture === 'shiftEnter' && action === 'newline') { decided('native-newline', gesture); return }
      event.preventDefault()
      event.stopImmediatePropagation()
      // A send replayed inside DSH's post-composition window would be swallowed
      // by the composer's own IME guard; delay it. A line-break replay is safe:
      // the composer's keymap handles Shift+Enter before its IME check.
      if (action !== 'newline' && Date.now() < composingUntil) {
        deferSend(composer, action, event.repeat, composingUntil)
        decided('ime-deferred', gesture)
        return
      }
      decided(action, gesture)
      runAction(action, event, composer)
    }

    // --- diagnostics --------------------------------------------------------

    /**
     * The live state of the plugin, for the console API and the Settings page.
     * @returns a JSON-friendly snapshot.
     */
    function getStatus() {
      const composers = document.querySelectorAll(COMPOSER_SELECTOR).length
      return {
        plugin: PLUGIN_NAME,
        version: VERSION,
        preset,
        bindings: { ...bindings },
        busyEnter: readBusyEnter() ?? 'unknown',
        anchor: anchorWarningShown ? 'missing' : composers > 0 || sawComposer ? 'found' : 'unknown',
        composers,
        lastKey,
        menuBlocks,
        storage: storageFailed ? 'volatile' : 'local',
        sideChat: {
          present: sideChatNamespace !== null,
          mode: sideChatMode,
          follow: sideChatFollow,
          namespaces: sideChatNamespaces,
          sync: sideChatConflict ? 'conflict' : sideChatRejected ? 'rejected' : sideChatFollow ? 'on' : 'off',
        },
      }
    }

    /**
     * @returns a copy of the live binding map.
     */
    function getBindings() {
      return { ...bindings }
    }

    /**
     * @returns the status snapshot as pretty-printed JSON (for bug reports).
     */
    function inspect() {
      return JSON.stringify(getStatus(), null, 2)
    }

    /** The object installed on `window` while the plugin is applied. */
    const DIAGNOSTICS = { version: VERSION, getStatus, getBindings, inspect }

    // --- settings page ------------------------------------------------------

    /** Locale namespace owned by this plugin (settings copy only). */
    const NS = 'composer-enter-newline'

    const DICT = {
      zh: {
        'nav': 'Enter 换行',
        'page.title': 'Enter 换行',
        'action.newline': '换行',
        'action.steer': '插话发送',
        'action.queue': '排队发送',
        'select.aria': '{key} 按键行为',
        'preset.title': '按键方案',
        'preset.dsh': '默认配置',
        'preset.dsh.desc': '热关闭插件，恢复当前DSH设置',
        'preset.plugin': '插件配置',
        'preset.plugin.desc': '用户自定义配置，可在下方逐键调整',
        'status.plugin': '当前生效：Enter = {enter} · Ctrl/Cmd+Enter = {ctrl} · Shift+Enter = {shift}',
        'status.dsh': '当前生效：Enter = {enter} · Ctrl/Cmd+Enter = {ctrl} · Shift+Enter = 换行',
        'status.draft': '未保存：Enter = {enter} · Ctrl/Cmd+Enter = {ctrl} · Shift+Enter = {shift}（保存后生效）',
        'anchor.found': '输入框锚点：已检测到',
        'anchor.missing': '输入框锚点：未检测到（DSH 可能改版，详见控制台）',
        'anchor.unknown': '输入框锚点：尚未检测到（打开一个会话后回到此页可复查）',
        'sideChat.title': '侧边对话（dsh-better-sidebar）',
        'sideChat.missing': '未检测到 dsh-better-sidebar：安装并启用它之后，这里会显示侧边对话的发送键。',
        'sideChat.loading': '正在读取侧边栏设置…',
        'sideChat.mode.enter': '侧边对话发送键：Enter 发送 · Shift+Enter 换行',
        'sideChat.mode.modEnter': '侧边对话发送键：Ctrl/Cmd+Enter 发送 · Enter 与 Shift+Enter 换行',
        'sideChat.follow': '跟随本插件的映射',
        'sideChat.limit': '当前版本的侧边栏插件只支持「发送 / 换行」两态，因此不会修改 Shift+Enter 的行为。',
        'sideChat.synced': '已同步',
        'sideChat.rejected': '侧边栏拒绝了这次写入，它仍保持原值；下次保存时会重试。',
        'sideChat.conflict': '侧边栏里被手动改成了别的模式，跟随已自动关闭。',
        'diagnostics.copy': '复制诊断',
        'storage.volatile': '浏览器存储不可用：当前设置只在本次会话生效。',
        'io.title': '导出 / 导入',
        'io.export': '导出',
        'io.copy': '复制',
        'io.import': '导入',
        'io.copied': '已复制',
        'io.copyFailed': '复制失败，请手动全选复制',
        'io.imported': '已导入',
        'io.badJson': 'JSON 解析失败，请检查粘贴内容。',
        'io.badFormat': '无法识别的格式：只支持 format 1。',
        'io.badPlugin': '这不是本插件的配置（plugin 字段不匹配）。',
        'button.save': '保存',
        'button.restoreDefault': '恢复插件预设',
        'button.discard': '放弃',
        'status.saved': '已保存',
        'error.noNewline': '至少要有一个按键用于换行，否则草稿无法换行。',
        'error.allNewline': '三个按键都设为换行，将无法用键盘发送草稿。',
      },
      en: {
        'nav': 'Enter newline',
        'page.title': 'Enter newline',
        'action.newline': 'Line break',
        'action.steer': 'Steer',
        'action.queue': 'Queue',
        'select.aria': '{key} behavior',
        'preset.title': 'Key scheme',
        'preset.dsh': 'Default configuration',
        'preset.dsh.desc': 'Disables the plugin on the spot and restores the current DSH settings',
        'preset.plugin': 'Plugin configuration',
        'preset.plugin.desc': 'User-defined configuration; adjust each key below',
        'status.plugin': 'Active: Enter = {enter} · Ctrl/Cmd+Enter = {ctrl} · Shift+Enter = {shift}',
        'status.dsh': 'Active: Enter = {enter} · Ctrl/Cmd+Enter = {ctrl} · Shift+Enter = line break',
        'status.draft': 'Unsaved: Enter = {enter} · Ctrl/Cmd+Enter = {ctrl} · Shift+Enter = {shift} (applies after saving)',
        'anchor.found': 'Composer anchor: detected',
        'anchor.missing': 'Composer anchor: not detected (DSH may have changed; see the console)',
        'anchor.unknown': 'Composer anchor: not detected yet (open a session and revisit this page)',
        'sideChat.title': 'Side chat (dsh-better-sidebar)',
        'sideChat.missing': 'dsh-better-sidebar was not found; install and enable it to see its submit key here.',
        'sideChat.loading': 'Reading the side card settings…',
        'sideChat.mode.enter': 'Side-chat submit key: Enter sends · Shift+Enter breaks the line (read-only, always the side card\'s own setting)',
        'sideChat.mode.modEnter': 'Side-chat submit key: Ctrl/Cmd+Enter sends · Enter and Shift+Enter break the line (read-only, always the side card\'s own setting)',
        'sideChat.follow': 'Follow this plugin\'s mapping',
        'sideChat.limit': 'The side card supports only send / line break in this version, so Shift+Enter keeps its behavior.',
        'sideChat.synced': 'Synced',
        'sideChat.rejected': 'The side card refused the write and keeps its value; the next save retries.',
        'sideChat.conflict': 'The side card holds another mode you picked there; following was turned off.',
        'diagnostics.copy': 'Copy diagnostics',
        'storage.volatile': 'Browser storage is unavailable; this setting only lasts for this session.',
        'io.title': 'Export / import',
        'io.export': 'Export',
        'io.copy': 'Copy',
        'io.import': 'Import',
        'io.copied': 'Copied',
        'io.copyFailed': 'Copy failed; select the text and copy it manually',
        'io.imported': 'Imported',
        'io.badJson': 'Could not parse the JSON; check what you pasted.',
        'io.badFormat': 'Unsupported format: only format 1 is accepted.',
        'io.badPlugin': 'This is not this plugin\'s configuration (plugin field mismatch).',
        'button.save': 'Save',
        'button.restoreDefault': 'Restore plugin default',
        'button.discard': 'Discard',
        'status.saved': 'Saved',
        'error.noNewline': 'At least one key must insert a line break, or the draft can never break a line.',
        'error.allNewline': 'All three keys insert a line break, so the draft could never be sent from the keyboard.',
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
      statusBox: {
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        marginTop: '12px',
        padding: '10px 12px',
        borderRadius: 'var(--dsw-radius-md)',
        background: 'var(--dsw-alias-bg-module-platform)',
      },
      statusText: {
        fontSize: '12px',
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-secondary)',
      },
      // The unsaved draft line: same size as the live line, warning colour so
      // "not in effect yet" cannot be misread as the active mapping.
      statusDraft: {
        fontSize: '12px',
        lineHeight: '18px',
        color: 'var(--dsw-alias-state-warn-primary)',
      },
      sectionTitle: {
        margin: '18px 0 0',
        fontSize: '13px',
        fontWeight: '600',
        lineHeight: '20px',
        color: 'var(--dsw-alias-label-primary)',
      },
      presetList: {
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        marginTop: '10px',
      },
      presetCard: {
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        width: '100%',
        padding: '12px',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        borderRadius: 'var(--dsw-radius-md)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        textAlign: 'left',
        cursor: 'pointer',
      },
      presetCardActive: {
        borderColor: 'var(--dsw-alias-brand-primary-new-color, #4d6bfe)',
        background: 'var(--dsw-alias-bg-module-platform)',
      },
      presetTitle: {
        fontSize: '13px',
        fontWeight: '600',
        lineHeight: '20px',
        color: 'var(--dsw-alias-label-primary)',
      },
      presetDesc: {
        fontSize: '12px',
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-secondary)',
      },
      rows: {
        marginTop: '6px',
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
      secondaryDisabled: {
        background: 'var(--dsw-alias-bg-module-platform)',
        color: 'var(--dsw-alias-label-tertiary)',
        cursor: 'default',
      },
      smallButton: {
        height: '28px',
        padding: '0 10px',
        border: 'none',
        borderRadius: 'var(--dsw-radius-md)',
        font: 'inherit',
        fontSize: '12px',
        lineHeight: '18px',
        cursor: 'pointer',
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
      anchorRow: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '8px',
        marginTop: '14px',
      },
      anchor: {
        margin: '0',
        fontSize: '12px',
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-tertiary)',
      },
      sideChatMode: {
        margin: '6px 0 0',
        fontSize: '12px',
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-secondary)',
      },
      sideChatMissing: {
        margin: '6px 0 0',
        fontSize: '12px',
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-tertiary)',
      },
      sideChatRow: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: '10px',
        marginTop: '10px',
      },
      switch: {
        position: 'relative',
        flex: 'none',
        width: '36px',
        height: '20px',
        marginTop: '2px',
        padding: '0',
        border: 'none',
        borderRadius: '10px',
        cursor: 'pointer',
      },
      switchOn: {
        background: 'var(--dsw-alias-brand-primary-new-color, #4d6bfe)',
      },
      switchOff: {
        background: 'var(--dsw-alias-bg-module-platform)',
        boxShadow: 'inset 0 0 0 0.5px var(--dsw-alias-border-l2)',
      },
      switchKnob: {
        position: 'absolute',
        top: '2px',
        left: '2px',
        width: '16px',
        height: '16px',
        borderRadius: '50%',
        background: '#fff',
      },
      sideChatCopy: {
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
      },
      sideChatFollow: {
        margin: '0',
        fontSize: '13px',
        lineHeight: '20px',
        color: 'var(--dsw-alias-label-primary)',
      },
      sideChatNote: {
        margin: '0',
        fontSize: '12px',
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-tertiary)',
      },
      sideChatOk: {
        margin: '0',
        fontSize: '12px',
        lineHeight: '18px',
        color: 'var(--dsw-alias-state-success-primary)',
      },
      sideChatWarn: {
        margin: '0',
        fontSize: '12px',
        lineHeight: '18px',
        color: 'var(--dsw-alias-state-warn-primary)',
      },
      textarea: {
        width: '100%',
        minHeight: '96px',
        marginTop: '10px',
        boxSizing: 'border-box',
        padding: '8px',
        resize: 'vertical',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        borderRadius: 'var(--dsw-radius-md)',
        background: 'var(--dsw-alias-bg-module-platform)',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'var(--ds-font-family-code)',
        fontSize: '12px',
        lineHeight: '18px',
      },
      ioButtons: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        marginTop: '8px',
      },
    }

    /**
     * One preset card: title, live description, selected state.
     * @param props - preset copy and the selection handler.
     * @returns the card button.
     */
    function PresetCard({ title, description, selected, onSelect }) {
      return h('button', {
        type: 'button',
        role: 'radio',
        'aria-checked': selected,
        style: { ...STYLE.presetCard, ...(selected ? STYLE.presetCardActive : null) },
        onClick: onSelect,
      },
        h('span', { style: STYLE.presetTitle }, title),
        h('span', { style: STYLE.presetDesc }, description))
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
     * Build the portable export document from the saved configuration.
     * @returns pretty-printed JSON.
     */
    function buildExportDocument() {
      return JSON.stringify({ plugin: PLUGIN_NAME, format: 1, preset, bindings }, null, 2)
    }

    /**
     * Parse an exported (or hand-written) configuration.
     * @param text - JSON text from the textarea.
     * @returns `{ bindings, preset? }`, or `{ error }` with a translation key.
     */
    function parseImportDocument(text) {
      let raw
      try {
        raw = JSON.parse(text)
      } catch {
        return { error: 'io.badJson' }
      }
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'io.badJson' }
      if (raw.plugin !== undefined && raw.plugin !== PLUGIN_NAME) return { error: 'io.badPlugin' }
      if (raw.format !== undefined && raw.format !== 1) return { error: 'io.badFormat' }
      const envelope = raw.plugin !== undefined || raw.format !== undefined
        || raw.preset !== undefined || raw.bindings !== undefined
      const mapRaw = envelope ? raw.bindings : raw
      if (mapRaw === null || typeof mapRaw !== 'object' || Array.isArray(mapRaw)) return { error: 'io.badJson' }
      const next = normalizeBindings(mapRaw)
      const refusal = validateBindings(next)
      if (refusal !== null) return { error: refusal }
      const nextPreset = raw.preset === 'dsh' || raw.preset === 'plugin' ? raw.preset : undefined
      return { bindings: next, preset: nextPreset }
    }

    /**
     * The Settings page: preset cards, the one-line effective summary, gesture
     * selects, Restore plugin default / Discard / Save, self-check, and
     * export/import.
     * @param props - slot props; `t` is bound to this plugin's namespace.
     * @returns the section content.
     */
    function SettingsPage({ t }) {
      const [draft, setDraft] = useState(() => ({ ...bindings }))
      const [presetDraft, setPresetDraft] = useState(() => preset)
      const [error, setError] = useState('')
      const [saved, setSaved] = useState(false)
      const [ioText, setIoText] = useState('')
      const [ioStatus, setIoStatus] = useState('')
      const [ioError, setIoError] = useState('')
      // The side card writes its own settings, so this page cannot learn about
      // a change from its own state: it re-renders on the sync store instead.
      const [, setPageTick] = useState(0)

      useEffect(() => subscribePage(() => { setPageTick(tick => tick + 1) }), [])

      // Every hook is declared above this line, so the order is stable.
      const options = ACTION_OPTIONS.map(option => ({ value: option.value, label: t(option.key) }))
      const dirty = !sameBindings(draft, bindings)
      const busy = readBusyEnter()
      const busyMode = busy ?? 'queue'
      const dshEnter = t(busyMode === 'steer' ? 'action.steer' : 'action.queue')
      const dshChord = t(busyMode === 'steer' ? 'action.queue' : 'action.steer')
      const status = preset === 'dsh'
        ? t('status.dsh', { enter: dshEnter, ctrl: dshChord })
        : t('status.plugin', {
          enter: t(`action.${bindings.enter}`),
          ctrl: t(`action.${bindings.ctrlEnter}`),
          shift: t(`action.${bindings.shiftEnter}`),
        })
      // The first line is what a keystroke does right now (the saved map); the
      // second appears only while the draft differs, so an edited select is
      // never mistaken for a mapping that is already in effect.
      const draftStatus = dirty && presetDraft === 'plugin'
        ? t('status.draft', {
          enter: t(`action.${draft.enter}`),
          ctrl: t(`action.${draft.ctrlEnter}`),
          shift: t(`action.${draft.shiftEnter}`),
        })
        : null
      // The draft and the live map both count: either one off the factory map
      // means there is something to restore.
      const atPluginDefault = sameBindings(draft, DEFAULT_BINDINGS) && sameBindings(bindings, DEFAULT_BINDINGS)
      const anchorText = anchorWarningShown
        ? t('anchor.missing')
        : sawComposer || document.querySelectorAll(COMPOSER_SELECTOR).length > 0
          ? t('anchor.found')
          : t('anchor.unknown')

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

      const restoreDefault = () => {
        writeBindings({ ...DEFAULT_BINDINGS })
        setDraft({ ...bindings })
        setError('')
        setSaved(true)
        setIoStatus('')
        setIoError('')
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

      const choosePreset = (next) => {
        writePreset(next)
        setPresetDraft(preset)
        setError('')
        setSaved(false)
        setIoStatus('')
        setIoError('')
      }

      const exportDoc = () => {
        setIoText(buildExportDocument())
        setIoStatus('')
        setIoError('')
      }

      const copyDoc = () => {
        const text = buildExportDocument()
        setIoText(text)
        const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
        if (clipboard === undefined || typeof clipboard.writeText !== 'function') {
          setIoError(t('io.copyFailed'))
          setIoStatus('')
          return
        }
        clipboard.writeText(text).then(
          () => { setIoError(''); setIoStatus(t('io.copied')) },
          () => { setIoError(t('io.copyFailed')); setIoStatus('') },
        )
      }

      const importDoc = () => {
        const result = parseImportDocument(ioText)
        if (result.error !== undefined) {
          setIoError(t(result.error))
          setIoStatus('')
          return
        }
        writeBindings(result.bindings)
        if (result.preset !== undefined) writePreset(result.preset)
        setDraft({ ...bindings })
        setPresetDraft(preset)
        setError('')
        setSaved(false)
        setIoError('')
        setIoStatus(t('io.imported'))
      }

      // The same snapshot the console API returns: one click for bug reports.
      // Without a clipboard the JSON lands in the export box, so it can still
      // be selected and copied by hand.
      const copyDiagnostics = () => {
        const text = inspect()
        const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
        if (clipboard === undefined || typeof clipboard.writeText !== 'function') {
          setIoText(text)
          setIoError(t('io.copyFailed'))
          setIoStatus('')
          return
        }
        clipboard.writeText(text).then(
          () => { setError(''); setIoError(''); setIoStatus(t('io.copied')) },
          () => { setIoText(text); setIoError(t('io.copyFailed')); setIoStatus('') },
        )
      }

      return h('div', { style: STYLE.page },
        h('h2', { style: STYLE.pageTitle }, t('page.title')),
        h('div', { style: STYLE.statusBox, role: 'status' },
          h('div', { style: STYLE.statusText }, status),
          draftStatus === null ? null : h('div', { style: STYLE.statusDraft }, draftStatus)),
        h('div', { style: STYLE.sectionTitle }, t('preset.title')),
        h('div', { style: STYLE.presetList, role: 'radiogroup', 'aria-label': t('preset.title') },
          h(PresetCard, {
            title: t('preset.dsh'),
            description: t('preset.dsh.desc'),
            selected: presetDraft === 'dsh',
            onSelect: () => choosePreset('dsh'),
          }),
          h(PresetCard, {
            title: t('preset.plugin'),
            description: t('preset.plugin.desc'),
            selected: presetDraft === 'plugin',
            onSelect: () => choosePreset('plugin'),
          })),
        presetDraft === 'plugin' ? h('div', { style: STYLE.rows },
          GESTURES.map(gesture => h(GestureRow, {
            key: gesture.id,
            keyCap: gesture.keyCap,
            value: draft[gesture.id],
            label: t('select.aria', { key: gesture.keyCap }),
            options,
            onChange: (event) => { change(gesture.id, event.target.value) },
          }))) : null,
        presetDraft === 'plugin' && error !== '' ? h('p', { style: STYLE.error, role: 'alert' }, error) : null,
        presetDraft === 'plugin' ? h('div', { style: STYLE.actions },
          saved && error === '' ? h('span', { style: STYLE.status, role: 'status' }, t('status.saved')) : null,
          h('button', {
            type: 'button',
            style: { ...STYLE.button, ...(atPluginDefault ? STYLE.secondaryDisabled : STYLE.secondary) },
            disabled: atPluginDefault,
            onClick: restoreDefault,
          }, t('button.restoreDefault')),
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
          }, t('button.save'))) : null,
        h('div', { style: STYLE.sectionTitle }, t('sideChat.title')),
        h('p', {
          style: sideChatMode === null ? STYLE.sideChatMissing : STYLE.sideChatMode,
          role: 'status',
        }, sideChatNamespace === null
          ? t('sideChat.missing')
          : sideChatMode === null
            ? t('sideChat.loading')
            : t(sideChatMode === 'mod-enter' ? 'sideChat.mode.modEnter' : 'sideChat.mode.enter')),
        sideChatMode === null ? null : h('div', { style: STYLE.sideChatRow },
          h('button', {
            type: 'button',
            role: 'switch',
            'aria-checked': sideChatFollow,
            'aria-label': t('sideChat.follow'),
            style: { ...STYLE.switch, ...(sideChatFollow ? STYLE.switchOn : STYLE.switchOff) },
            onClick: () => { setSideChatFollow(!sideChatFollow) },
          }, h('span', {
            style: { ...STYLE.switchKnob, ...(sideChatFollow ? { transform: 'translateX(16px)' } : null) },
          })),
          h('div', { style: STYLE.sideChatCopy },
            h('p', { style: STYLE.sideChatFollow }, t('sideChat.follow')),
            h('p', { style: STYLE.sideChatNote }, t('sideChat.limit')),
            sideChatConflict ? h('p', { style: STYLE.sideChatWarn, role: 'alert' }, t('sideChat.conflict')) : null,
            sideChatFollow && sideChatRejected ? h('p', { style: STYLE.sideChatWarn, role: 'alert' }, t('sideChat.rejected')) : null,
            sideChatFollow && !sideChatRejected ? h('span', { style: STYLE.sideChatOk, role: 'status' }, t('sideChat.synced')) : null)),
        h('div', { style: STYLE.anchorRow },
          h('p', { style: STYLE.anchor }, anchorText),
          h('button', {
            type: 'button',
            style: { ...STYLE.smallButton, ...STYLE.secondary },
            onClick: copyDiagnostics,
          }, t('diagnostics.copy'))),
        storageFailed ? h('p', { style: STYLE.note, role: 'status' }, t('storage.volatile')) : null,
        h('div', { style: STYLE.sectionTitle }, t('io.title')),
        h('textarea', {
          style: STYLE.textarea,
          value: ioText,
          placeholder: 'JSON',
          'aria-label': t('io.title'),
          onChange: (event) => {
            setIoText(event.target.value)
            setIoStatus('')
            setIoError('')
          },
        }),
        h('div', { style: STYLE.ioButtons },
          h('button', {
            type: 'button',
            style: { ...STYLE.smallButton, ...STYLE.secondary },
            onClick: exportDoc,
          }, t('io.export')),
          h('button', {
            type: 'button',
            style: { ...STYLE.smallButton, ...STYLE.secondary },
            onClick: copyDoc,
          }, t('io.copy')),
          h('button', {
            type: 'button',
            style: { ...STYLE.smallButton, ...STYLE.secondary },
            onClick: importDoc,
          }, t('io.import')),
          ioStatus === '' ? null : h('span', { style: STYLE.status, role: 'status' }, ioStatus)),
        ioError === '' ? null : h('p', { style: STYLE.error }, ioError))
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
      __test: {
        DEFAULT_BINDINGS, GESTURES, PRESET_KEY, STORAGE_KEY, SIDE_CHAT_KEY, VERSION,
        normalizeBindings, sameBindings, validateBindings,
        buildExportDocument, parseImportDocument,
        menuState, gestureOf, isComposerShaped, getStatus,
        findSideChatNamespace, projectSideChatMode, readSideChatMode,
      },
      apply(ctx) {
        ctx.effect(() => {
          const onBlur = () => { resetComposition() }
          window.addEventListener('keydown', onKeyDown, true)
          window.addEventListener('compositionstart', onCompositionStart, true)
          window.addEventListener('compositionend', onCompositionEnd, true)
          window.addEventListener('blur', onBlur)
          return () => {
            window.removeEventListener('keydown', onKeyDown, true)
            window.removeEventListener('compositionstart', onCompositionStart, true)
            window.removeEventListener('compositionend', onCompositionEnd, true)
            window.removeEventListener('blur', onBlur)
            resetComposition()
          }
        }, 'composer-enter-newline: composer keydown remap')

        // The busy-send preference decides which gesture carries which mode;
        // without the settings service every send falls back to plain Enter.
        // The same service carries the side card's own settings row, which the
        // follow switch projects this plugin's mapping onto.
        let stopSideChat = null
        if (typeof ctx.inject === 'function') {
          ctx.inject(['configForms'], (scope) => {
            try {
              conversationForm = scope.configForms.get('ui-conversation')
            } catch {
              conversationForm = null
            }
            try {
              stopSideChat = watchSideChat(scope.configForms)
            } catch {
              stopSideChat = null
            }
          })
        }
        ctx.effect(() => () => {
          if (stopSideChat !== null) {
            stopSideChat()
            stopSideChat = null
          }
        }, 'composer-enter-newline: side chat follow')

        ctx.effect(() => ctx.locale.register(NS, DICT), 'composer-enter-newline: dictionaries')
        const t = ctx.locale.bind(NS)

        // Both the browser console and the Settings page read this object; it
        // is removed again on dispose only if it is still ours.
        ctx.effect(() => {
          window.__dshEnterNewline = DIAGNOSTICS
          return () => {
            if (window.__dshEnterNewline === DIAGNOSTICS) delete window.__dshEnterNewline
          }
        }, 'composer-enter-newline: diagnostics')

        console.info(LOG, 'active', { preset, bindings: { ...bindings } })

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
