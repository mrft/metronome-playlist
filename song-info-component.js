/**
 * Metronome Playlist — song-info-component.js
 *
 * Song info + navigation custom element built with Preact + HTM.
 * Exposed as <song-info>.
 *
 * Settable properties:
 *   name        {string}   song title
 *   tempo       {number}   BPM
 *   beats       {number}   beats per bar
 *   subdivision {number}   subdivision per beat
 *   order       {string}   position label, e.g. "[1/5]"
 *   position    {string}   position text,  e.g. "1 / 5"
 *   hasPrev     {boolean}
 *   hasNext     {boolean}
 *   canMoveUp   {boolean}
 *   canMoveDown {boolean}
 *   mode        {string}   'play' | 'edit'
 *
 * Dispatched events (all bubble):
 *   prev          – ◀ button clicked
 *   next          – ▶ button clicked
 *   move-up       – ↑ button clicked
 *   move-down     – ↓ button clicked
 *   insert-before – insert-before button clicked
 *   insert-after  – insert-after button clicked
 *   delete        – delete button clicked
 *   song-change   – edit-field blur with valid data  {detail: Song}
 *   song-input    – edit-field input with all-valid data {detail: Song}
 */

import { html }                       from 'htm/preact';
import { useState, useEffect, useCallback } from 'preact/hooks';
import { preactComponent }            from './utils.js';

/* ── Field validation ──────────────────────────────────────────────── */

/**
 * Validate all four song edit fields together.
 * @returns {{ name:string, tempo:number, beats:number, subdivision:number }|null}
 */
function validateSongFields(name, tempo, beats, subdivision) {
  const n = typeof name === 'string' ? name.trim() : '';
  const t = parseFloat(tempo);
  const b = parseInt(beats, 10);
  const s = parseInt(subdivision, 10);
  if (
    !n ||
    isNaN(t) || t < 20 || t > 400 ||
    isNaN(b) || b < 1  || b > 32  ||
    isNaN(s) || s < 1  || s > 8
  ) return null;
  return { name: n, tempo: t, beats: b, subdivision: s };
}

/* ══════════════════════════════════════════════════════════════════════
   SongInfo — Preact functional component
   ══════════════════════════════════════════════════════════════════════ */

/**
 * @param {{
 *   name:string, tempo:number, beats:number, subdivision:number,
 *   order:string, position:string,
 *   hasPrev:boolean, hasNext:boolean,
 *   canMoveUp:boolean, canMoveDown:boolean,
 *   mode:'play'|'edit',
 *   onPrev:()=>void, onNext:()=>void,
 *   onMoveUp:()=>void, onMoveDown:()=>void,
 *   onInsertBefore:()=>void, onInsertAfter:()=>void,
 *   onDelete:()=>void,
 *   onSongChange:(d:object)=>void,
 *   onSongInput:(d:object)=>void,
 * }} props
 */
function SongInfo({
  name        = '',
  tempo       = 100,
  beats       = 4,
  subdivision = 1,
  order       = '',
  position    = '',
  hasPrev     = false,
  hasNext     = false,
  canMoveUp   = false,
  canMoveDown = false,
  mode        = 'play',
  onPrev, onNext,
  onMoveUp, onMoveDown,
  onInsertBefore, onInsertAfter,
  onDelete,
  onSongChange,
  onSongInput,
}) {
  const hasData = !!order;
  const isEdit  = mode === 'edit';

  /* ── Local editable copies ─────────────────────────────────────────── */
  const [editName,        setEditName]        = useState(String(name));
  const [editTempo,       setEditTempo]       = useState(tempo);
  const [editBeats,       setEditBeats]       = useState(beats);
  const [editSubdivision, setEditSubdivision] = useState(subdivision);

  /* ── Sync edit state when the song changes via prop update ─────────── */
  useEffect(() => {
    setEditName(String(name));
    setEditTempo(tempo);
    setEditBeats(beats);
    setEditSubdivision(subdivision);
  }, [name, tempo, beats, subdivision]);

  /* ── Static display values ─────────────────────────────────────────── */
  const subdivLabel = subdivision > 1 ? ` · ×${subdivision} subdivision` : '';
  const metaText = hasData ? `${tempo} BPM · ${beats} beats/bar${subdivLabel}` : '';

  /* ── Blur: validate all fields; revert to props if any are invalid ──── */
  const handleBlur = useCallback(() => {
    const detail = validateSongFields(editName, editTempo, editBeats, editSubdivision);
    if (detail) {
      onSongChange?.(detail);
    } else {
      setEditName(String(name));
      setEditTempo(tempo);
      setEditBeats(beats);
      setEditSubdivision(subdivision);
    }
  }, [editName, editTempo, editBeats, editSubdivision,
      name, tempo, beats, subdivision, onSongChange]);

  /* ── Input: emit immediately when every field currently holds a valid value */
  const handleInput = useCallback((n, t, b, s) => {
    const detail = validateSongFields(n, t, b, s);
    if (detail) onSongInput?.(detail);
  }, [onSongInput]);

  /* ── Render ────────────────────────────────────────────────────────── */
  return html`
    <div id="song-name-row">
      <span id="song-order" class="song-order">${order}</span>
      ${isEdit ? html`
        <input id="edit-name" class="edit-field" type="text"
          value=${editName} disabled=${!hasData}
          aria-label="Song name"
          onInput=${(e) => setEditName(e.target.value)}
          onBlur=${handleBlur}
        />
        <button id="delete-song-btn" class="nav-btn delete-btn"
          title="Delete current song" aria-label="Delete current song"
          disabled=${!hasData} onClick=${onDelete}
        >🗑</button>
      ` : html`
        <span id="song-name">${name || 'No playlist loaded'}</span>
      `}
    </div>

    ${isEdit ? html`
      <div id="song-edit-meta">
        <label class="edit-label">BPM
          <input id="edit-tempo" class="edit-field" type="number"
            min="20" max="400" step="1"
            value=${editTempo} disabled=${!hasData}
            aria-label="Tempo (BPM)"
            onInput=${(e) => {
              const v = e.target.value;
              setEditTempo(v);
              handleInput(editName, v, editBeats, editSubdivision);
            }}
            onBlur=${handleBlur}
          />
        </label>
        <label class="edit-label">Beats
          <input id="edit-beats" class="edit-field" type="number"
            min="1" max="32" step="1"
            value=${editBeats} disabled=${!hasData}
            aria-label="Beats per bar"
            onInput=${(e) => {
              const v = e.target.value;
              setEditBeats(v);
              handleInput(editName, editTempo, v, editSubdivision);
            }}
            onBlur=${handleBlur}
          />
        </label>
        <label class="edit-label">Subdiv
          <input id="edit-subdivision" class="edit-field" type="number"
            min="1" max="8" step="1"
            value=${editSubdivision} disabled=${!hasData}
            aria-label="Subdivision"
            onInput=${(e) => {
              const v = e.target.value;
              setEditSubdivision(v);
              handleInput(editName, editTempo, editBeats, v);
            }}
            onBlur=${handleBlur}
          />
        </label>
      </div>
    ` : html`
      <div id="song-meta">${metaText}</div>
    `}

    <div id="song-nav">
      ${isEdit ? html`
        <button id="insert-before-btn" class="nav-btn"
          title="Insert new song before current" aria-label="Insert song before"
          onClick=${onInsertBefore}>+</button>
        <button id="move-up-btn" class="nav-btn"
          title="Move song up in playlist" aria-label="Move song up"
          disabled=${!canMoveUp} onClick=${onMoveUp}>↑</button>
      ` : null}
      <button id="prev-song-btn" class="nav-btn"
        title="Previous song" aria-label="Previous song"
        disabled=${!hasPrev} onClick=${onPrev}>◀</button>
      <span id="song-position">${position}</span>
      <button id="next-song-btn" class="nav-btn"
        title="Next song" aria-label="Next song"
        disabled=${!hasNext} onClick=${onNext}>▶</button>
      ${isEdit ? html`
        <button id="move-down-btn" class="nav-btn"
          title="Move song down in playlist" aria-label="Move song down"
          disabled=${!canMoveDown} onClick=${onMoveDown}>↓</button>
        <button id="insert-after-btn" class="nav-btn"
          title="Insert new song after current" aria-label="Insert song after"
          onClick=${onInsertAfter}>+</button>
      ` : null}
    </div>
  `;
}

/* ══════════════════════════════════════════════════════════════════════
   SongInfoElement — Custom element wrapper (via preactComponent)
   ══════════════════════════════════════════════════════════════════════ */

const _SongInfoBase = preactComponent(SongInfo, { define: false });

class SongInfoElement extends _SongInfoBase {
  constructor() {
    super();
    Object.assign(this._props, {
      name:        '',
      tempo:       100,
      beats:       4,
      subdivision: 1,
      order:       '',
      position:    '',
      hasPrev:     false,
      hasNext:     false,
      canMoveUp:   false,
      canMoveDown: false,
      mode:        'play',
      onPrev:         () => this.#emit('prev'),
      onNext:         () => this.#emit('next'),
      onMoveUp:       () => this.#emit('move-up'),
      onMoveDown:     () => this.#emit('move-down'),
      onInsertBefore: () => this.#emit('insert-before'),
      onInsertAfter:  () => this.#emit('insert-after'),
      onDelete:       () => this.#emit('delete'),
      onSongChange:   (d) => this.#emit('song-change', d),
      onSongInput:    (d) => this.#emit('song-input',  d),
    });
  }

  /** Dispatch a CustomEvent, optionally with detail. */
  #emit(name, detail) {
    const init = { bubbles: true };
    if (detail !== undefined) init.detail = detail;
    this.dispatchEvent(new CustomEvent(name, init));
  }

  /* ── Settable properties ─────────────────────────────────────────── */

  get name()           { return this._props.name; }
  set name(val)        { this.setProp('name', String(val)); }

  get tempo()          { return this._props.tempo; }
  set tempo(val)       { this.setProp('tempo', Number(val)); }

  get beats()          { return this._props.beats; }
  set beats(val)       { this.setProp('beats', Number(val)); }

  get subdivision()    { return this._props.subdivision; }
  set subdivision(val) { this.setProp('subdivision', Number(val)); }

  get order()          { return this._props.order; }
  set order(val)       { this.setProp('order', String(val)); }

  get position()       { return this._props.position; }
  set position(val)    { this.setProp('position', String(val)); }

  get hasPrev()        { return this._props.hasPrev; }
  set hasPrev(val)     { this.setProp('hasPrev', Boolean(val)); }

  get hasNext()        { return this._props.hasNext; }
  set hasNext(val)     { this.setProp('hasNext', Boolean(val)); }

  get canMoveUp()      { return this._props.canMoveUp; }
  set canMoveUp(val)   { this.setProp('canMoveUp', Boolean(val)); }

  get canMoveDown()    { return this._props.canMoveDown; }
  set canMoveDown(val) { this.setProp('canMoveDown', Boolean(val)); }

  get mode()           { return this._props.mode; }
  set mode(val)        { this.setProp('mode', val); }
}

customElements.define('song-info', SongInfoElement);
