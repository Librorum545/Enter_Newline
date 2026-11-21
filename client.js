/**
 * Browser-side key remap for the composer.
 *
 * Enter          -> insert a soft line break
 * Ctrl/Cmd+Enter -> submit the draft
 *
 * Both gestures are replayed into the composer's own event path, so its
 * keymap, IME guard, menu arbitration, undo history and delivery preference
 * stay authoritative:
 * - Enter becomes a Shift+Enter keydown; the composer's keymap leaves
 *   Shift+Enter to Lexical's plain-text plugin, which inserts the line break
 *   node inside that same keydown.
 * - Ctrl/Cmd+Enter becomes a plain Enter keydown, so the composer resolves it
 *   through the busy send preference (steer while a turn runs, ordinary send
 *   when idle).
 *
 * Only one event is dispatched per gesture: adding a second insertion path
 * (for example a synthetic `beforeinput`) inserts a second line break, because
 * Lexical commits the keydown-path DOM update after the dispatch returns.
 */
window.__ModuleLoader__.load({
  id: '@local/composer-enter-newline',
  factory() {
    /** The composer's Lexical contenteditable host (rendered with this marker). */
    const COMPOSER_SELECTOR = '[data-composer-input]'
    /** The completion popups ("/" commands, "@" references) carry the listbox role. */
    const MENU_SELECTOR = '[role="listbox"]'
    /** Replayed events, so the capture listener ignores its own dispatches. */
    const replayed = new WeakSet()

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
     * Replay a plain Enter keydown so the composer's submit gesture runs.
     * @param event - the user's Ctrl/Cmd+Enter keydown.
     * @param composer - the composer root that owns the gesture.
     */
    function submitDraft(event, composer) {
      dispatchReplay(composer, new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
        cancelable: true,
        composed: true,
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        repeat: event.repeat,
      }))
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
      const primary = event.ctrlKey !== event.metaKey
      // Shift plus a primary modifier keeps its zero behavior in the composer.
      if (event.shiftKey && primary) return
      // An open completion menu owns Enter (pick the highlight), as before.
      if (completionMenuOpen()) return
      if (primary) {
        event.preventDefault()
        event.stopImmediatePropagation()
        submitDraft(event, composer)
        return
      }
      // Shift+Enter already inserts a line break.
      if (event.shiftKey) return
      event.preventDefault()
      event.stopImmediatePropagation()
      insertLineBreak(composer)
    }

    return {
      apply(ctx) {
        ctx.effect(() => {
          window.addEventListener('keydown', onKeyDown, true)
          return () => { window.removeEventListener('keydown', onKeyDown, true) }
        }, 'composer-enter-newline: composer keydown remap')
      },
    }
  },
})
