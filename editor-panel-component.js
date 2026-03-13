/**
 * Metronome Playlist — editor-panel-component.js
 *
 * Editor panel custom element built with Preact + HTM.
 * Exposed as <editor-panel>.
 *
 * Settable properties:
 *   open            {boolean}  controls panel visibility; sets aria-hidden
 *                              and toggles the editor-hidden CSS class on the
 *                              element itself — no extra JS needed in app.js
 *   validationMsg   {string}   text shown in the validation indicator
 *   validationState {string}   'valid' | 'invalid' | 'warning' | ''
 *   applyFeedback   {boolean}  when true, Apply button shows "✓ Applied!"
 *
 * Dispatched events (all bubble):
 *   apply  – user clicked "Apply ↵" (or Ctrl+Enter in app.js)
 *   close  – user clicked "✕"
 *
 * Notes:
 *   The Monaco editor container (#monaco-editor-container) and the fallback
 *   textarea (#fallback-editor) are rendered as empty placeholders.
 *   app.js continues to own Monaco initialisation and targets those elements
 *   by ID (which remains accessible because the component renders into the
 *   element's light DOM, not a shadow root).
 */

import { html }           from 'htm/preact';
import { preactComponent } from './utils.js';

/* ══════════════════════════════════════════════════════════════════════
   EditorPanel — Preact functional component
   ══════════════════════════════════════════════════════════════════════ */

/**
 * @param {{
 *   validationMsg:string, validationState:string,
 *   applyFeedback:boolean,
 *   onApply:()=>void, onClose:()=>void,
 * }} props
 */
function EditorPanel({
  validationMsg   = '',
  validationState = '',
  applyFeedback   = false,
  useFallback     = false,
  onApply,
  onClose,
}) {
  const validationClass =
    'validation-msg' + (validationState ? ' ' + validationState : '');

  const applyStyle = applyFeedback
    ? 'background: var(--success); border-color: var(--success);'
    : '';

  return html`
    <header class="panel-header editor-header">
      <span class="editor-title">Playlist Editor <small>(JSON)</small></span>
      <div class="editor-header-right">
        <span id="validation-msg" class=${validationClass}>${validationMsg}</span>
        <button id="apply-btn" class="ctrl-btn primary"
          style=${applyStyle}
          title="Apply playlist (Ctrl+Enter)"
          onClick=${onApply}
        >${applyFeedback ? '✓ Applied!' : 'Apply ↵'}</button>
        <button id="close-editor-btn" class="header-btn" title="Close editor"
          onClick=${onClose}
        >✕</button>
      </div>
    </header>
    <div id="monaco-editor-container" style=${useFallback ? 'display:none' : ''}></div>
    <textarea id="fallback-editor" class="fallback-editor"
              style=${useFallback ? '' : 'display:none'}
              aria-label="Playlist JSON editor (fallback)" spellcheck="false"></textarea>
    <div id="schema-hint">
      💡 Required: <strong>name</strong> (string) · <strong>tempo</strong> (20–400 BPM) · <strong>beats</strong> (integer).
      Optional: <strong>subdivision</strong> (1–8, default&nbsp;1).
      Press <kbd>Ctrl+Enter</kbd> to apply.
    </div>
  `;
}

/* ══════════════════════════════════════════════════════════════════════
   EditorPanelElement — Custom element wrapper (via preactComponent)
   ══════════════════════════════════════════════════════════════════════ */

const _EditorPanelBase = preactComponent(EditorPanel, { define: false });

class EditorPanelElement extends _EditorPanelBase {
  constructor() {
    super();
    Object.assign(this._props, {
      validationMsg:   '',
      validationState: '',
      applyFeedback:   false,
      useFallback:     false,
      onApply: () => this.dispatchEvent(new CustomEvent('apply', { bubbles: true })),
      onClose: () => this.dispatchEvent(new CustomEvent('close', { bubbles: true })),
    });
  }

  /* ── open: manages CSS class + aria-hidden (no Preact re-render needed) */

  /** @returns {boolean} */
  get open() { return !this.classList.contains('editor-hidden'); }

  /** @param {boolean} val */
  set open(val) {
    const isOpen = Boolean(val);
    this.classList.toggle('editor-hidden', !isOpen);
    this.setAttribute('aria-hidden', String(!isOpen));
  }

  /* ── Preact-rendered props ──────────────────────────────────────────── */

  get validationMsg()      { return this._props.validationMsg; }
  set validationMsg(val)   { this.setProp('validationMsg',   String(val)); }

  get validationState()    { return this._props.validationState; }
  set validationState(val) { this.setProp('validationState', String(val)); }

  get applyFeedback()      { return this._props.applyFeedback; }
  set applyFeedback(val)   { this.setProp('applyFeedback',   Boolean(val)); }

  get useFallback()        { return this._props.useFallback; }
  set useFallback(val)     { this.setProp('useFallback',     Boolean(val)); }
}

customElements.define('editor-panel', EditorPanelElement);
