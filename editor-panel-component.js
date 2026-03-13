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
 *   useFallback     {boolean}  when true, shows textarea instead of Monaco
 *   recentPlaylists {Array}    list of {name, savedAt, playlist} objects
 *
 * Dispatched events (all bubble):
 *   apply         – user clicked "Apply ↵"
 *   close         – user clicked "✕"
 *   save-playlist – user clicked "💾 Save"
 *   load-file     – user selected a JSON file  {detail: {name, content}}
 *   load-recent   – user clicked a recent entry {detail: index}
 *
 * Notes:
 *   The Monaco editor container (#monaco-editor-container) and the fallback
 *   textarea (#fallback-editor) are rendered as empty placeholders.
 *   app.js continues to own Monaco initialisation and targets those elements
 *   by ID (which remains accessible because the component renders into the
 *   element's light DOM, not a shadow root).
 */

import { html }           from 'htm/preact';
import { useRef }         from 'preact/hooks';
import { preactComponent } from './utils.js';

/* ── Date formatting helper ────────────────────────────────────────── */
function formatDate(iso) {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric',
    });
  } catch (_) {
    return iso;
  }
}

/* ══════════════════════════════════════════════════════════════════════
   EditorPanel — Preact functional component
   ══════════════════════════════════════════════════════════════════════ */

/**
 * @param {{
 *   validationMsg:string, validationState:string,
 *   applyFeedback:boolean, useFallback:boolean,
 *   recentPlaylists:Array<{name:string,savedAt:string}>,
 *   onApply:()=>void, onClose:()=>void,
 *   onSave:()=>void,
 *   onLoadFile:(d:{name:string,content:string})=>void,
 *   onLoadRecent:(index:number)=>void,
 * }} props
 */
function EditorPanel({
  validationMsg   = '',
  validationState = '',
  applyFeedback   = false,
  useFallback     = false,
  recentPlaylists = [],
  onApply,
  onClose,
  onSave,
  onLoadFile,
  onLoadRecent,
}) {
  const fileInputRef = useRef(null);

  const validationClass =
    'validation-msg' + (validationState ? ' ' + validationState : '');

  const applyStyle = applyFeedback
    ? 'background: var(--success); border-color: var(--success);'
    : '';

  function handleFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      onLoadFile?.({ name: file.name, content: ev.target.result });
    };
    reader.readAsText(file);
    // Reset so the same file can be re-selected without a page reload
    e.target.value = '';
  }

  return html`
    <header class="panel-header editor-header">
      <div class="editor-header-left">
        <span class="editor-title">Playlist Editor <small>(JSON)</small></span>
        <button class="header-btn file-btn" title="Open playlist JSON file"
          onClick=${() => fileInputRef.current?.click()}>📂 Open</button>
        <button class="header-btn file-btn" title="Save playlist as JSON file"
          onClick=${onSave}>💾 Save</button>
        <input ref=${fileInputRef} type="file" accept=".json"
          style="display:none" onChange=${handleFileChange} />
      </div>
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
    ${recentPlaylists.length > 0 ? html`
      <div id="recent-playlists" aria-label="Recent playlists">
        <span class="recent-label">📋 Recent</span>
        ${recentPlaylists.map((r, i) => html`
          <button key=${r.savedAt + i} class="recent-item"
            title="Load: ${r.name}" onClick=${() => onLoadRecent?.(i)}>
            <span class="recent-name">${r.name}</span>
            <span class="recent-date">${formatDate(r.savedAt)}</span>
          </button>
        `)}
      </div>
    ` : null}
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
      recentPlaylists: [],
      onApply:      () => this.dispatchEvent(new CustomEvent('apply',         { bubbles: true })),
      onClose:      () => this.dispatchEvent(new CustomEvent('close',         { bubbles: true })),
      onSave:       () => this.dispatchEvent(new CustomEvent('save-playlist', { bubbles: true })),
      onLoadFile:   (d) => this.dispatchEvent(new CustomEvent('load-file',    { bubbles: true, detail: d })),
      onLoadRecent: (i) => this.dispatchEvent(new CustomEvent('load-recent',  { bubbles: true, detail: i })),
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

  get recentPlaylists()    { return this._props.recentPlaylists; }
  set recentPlaylists(val) { this.setProp('recentPlaylists', Array.isArray(val) ? val : []); }
}

customElements.define('editor-panel', EditorPanelElement);
