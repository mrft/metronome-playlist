/**
 * Metronome Playlist — app.js
 *
 * Handles playlist management, song navigation, and the Monaco JSON editor.
 * The metronome engine, visuals, and transport controls live in the
 * <metronome-player> custom element (metronome-component.js).
 *
 * Features:
 *  - Monaco Editor with JSON Schema validation and code-completion hints
 *  - Playlist persisted in localStorage
 *  - Prev/Next song navigation
 *  - Inline edit mode (name, tempo, beats, subdivision)
 */

'use strict';

/* ─────────────────────────────────────────────────────────────────────────
   Constants & defaults
───────────────────────────────────────────────────────────────────────── */

const STORAGE_KEY = 'metronome-playlist-v1';

const DEFAULT_PLAYLIST = [
  { name: 'Slow Blues',   tempo: 60,  beats: 4, subdivision: 1 },
  { name: 'Rock Steady',  tempo: 120, beats: 4, subdivision: 2 },
  { name: 'Waltz',        tempo: 100, beats: 3, subdivision: 1 },
  { name: 'Jazz Swing',   tempo: 160, beats: 4, subdivision: 2 },
  { name: 'Metal Blast',  tempo: 200, beats: 4, subdivision: 4 },
];

/**
 * JSON Schema for the playlist — drives Monaco validation + code hints.
 * @type {object}
 */
const PLAYLIST_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Metronome Playlist',
  description: 'An ordered list of songs for the metronome player.',
  type: 'array',
  minItems: 1,
  items: {
    type: 'object',
    required: ['name', 'tempo', 'beats'],
    additionalProperties: false,
    properties: {
      name: {
        type: 'string',
        minLength: 1,
        description: 'Song or section name displayed in the player.',
      },
      tempo: {
        type: 'number',
        minimum: 20,
        maximum: 400,
        description: 'Beats per minute (BPM). Range: 20–400.',
      },
      beats: {
        type: 'integer',
        minimum: 1,
        maximum: 32,
        description: 'Number of beats per measure (time-signature numerator).',
      },
      subdivision: {
        type: 'integer',
        minimum: 1,
        maximum: 8,
        default: 1,
        description:
          'Subdivision per beat: 1 = quarter notes (no sub-ticks), ' +
          '2 = eighth notes, 3 = triplets, 4 = sixteenth notes.',
      },
    },
  },
};

/* ─────────────────────────────────────────────────────────────────────────
   Application state
───────────────────────────────────────────────────────────────────────── */

/** @type {Song[]} */
let playlist = [];
let currentSongIndex = 0;

// DOM element references (populated in init())
/** @type {HTMLElement & { tempo:number, beats:number, subdivision:number, isPlaying:boolean, isPaused:boolean, play:()=>void, stop:()=>void, pause:()=>void }|null} */
let elMetronome;
let elPrevSong, elNextSong, elSongName, elSongMeta, elSongPos, elSongOrder;
let elEditName, elEditTempo, elEditBeats, elEditSubdivision;
let elMoveUpBtn, elMoveDownBtn, elInsertBeforeBtn, elInsertAfterBtn, elDeleteSongBtn;
let elValidationMsg, elApplyBtn, elToggleEditorBtn, elCloseEditorBtn, elEditorPanel;

/** @type {import('monaco-editor').editor.IStandaloneCodeEditor|null} */
let monacoEditor = null;
/** True once we have given up waiting for Monaco to load. */
let usingFallbackEditor = false;
/** Timeout handle used to detect Monaco CDN failure. */
let monacoLoadTimeout = null;

/* ─────────────────────────────────────────────────────────────────────────
   Playlist management
───────────────────────────────────────────────────────────────────────── */

/**
 * @typedef {{ name:string, tempo:number, beats:number, subdivision?:number }} Song
 */

/**
 * Load a new playlist array, update state, and persist to localStorage.
 * @param {Song[]} songs
 */
function loadPlaylist(songs) {
  // Normalise subdivision default
  playlist = songs.map(s => ({ subdivision: 1, ...s }));
  currentSongIndex = 0;

  localStorage.setItem(STORAGE_KEY, JSON.stringify(songs));

  updateSongDisplay();
  updateUI();
}

/**
 * Navigate to a different song (stopping/restarting if needed).
 * @param {number} index
 */
function goToSong(index) {
  if (index < 0 || index >= playlist.length) return;
  const wasPlaying = elMetronome?.isPlaying ?? false;
  if (elMetronome?.isPlaying || elMetronome?.isPaused) elMetronome.stop();
  currentSongIndex = index;
  updateSongDisplay();
  updateUI();
  if (wasPlaying) elMetronome?.play();
}

function updateSongDisplay() {
  const song = playlist[currentSongIndex];
  if (song) {
    elSongOrder.textContent = `[${currentSongIndex + 1}/${playlist.length}]`;
    elSongName.textContent = song.name;
    const subdivLabel = (song.subdivision || 1) > 1
      ? ` · ×${song.subdivision} subdivision`
      : '';
    elSongMeta.textContent =
      `${song.tempo} BPM · ${song.beats} beats/bar${subdivLabel}`;
    elSongPos.textContent = `${currentSongIndex + 1} / ${playlist.length}`;

    // Populate editable fields
    elEditName.value         = song.name;
    elEditTempo.value        = song.tempo;
    elEditBeats.value        = song.beats;
    elEditSubdivision.value  = song.subdivision || 1;
    elEditName.disabled        = false;
    elEditTempo.disabled       = false;
    elEditBeats.disabled       = false;
    elEditSubdivision.disabled = false;
  } else {
    elSongOrder.textContent  = '';
    elSongName.textContent   = 'No playlist loaded';
    elSongMeta.textContent   = '';
    elSongPos.textContent    = '';

    // Clear and disable edit inputs so stale values are not shown
    elEditName.value         = '';
    elEditTempo.value        = '';
    elEditBeats.value        = '';
    elEditSubdivision.value  = '';
    elEditName.disabled        = true;
    elEditTempo.disabled       = true;
    elEditBeats.disabled       = true;
    elEditSubdivision.disabled = true;
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   UI state
───────────────────────────────────────────────────────────────────────── */

function updateUI() {
  // Push current song settings into the metronome component
  const song = playlist[currentSongIndex];
  if (elMetronome && song) {
    elMetronome.tempo       = song.tempo;
    elMetronome.beats       = song.beats;
    elMetronome.subdivision = song.subdivision || 1;
  }

  elPrevSong.disabled    = currentSongIndex <= 0;
  elNextSong.disabled    = currentSongIndex >= playlist.length - 1;
  elMoveUpBtn.disabled   = currentSongIndex <= 0;
  elMoveDownBtn.disabled = currentSongIndex >= playlist.length - 1;
}

/* ─────────────────────────────────────────────────────────────────────────
   Monaco Editor + JSON Schema
───────────────────────────────────────────────────────────────────────── */

/** Returns the current raw text from whichever editor is active. */
function getEditorValue() {
  if (usingFallbackEditor) {
    const ta = document.getElementById('fallback-editor');
    return ta ? ta.value : '';
  }
  return monacoEditor ? monacoEditor.getValue() : '';
}

/**
 * Activate the plain-textarea fallback editor.
 * Called when Monaco fails to load (CDN blocked / offline).
 */
function activateFallbackEditor() {
  if (usingFallbackEditor) return;
  usingFallbackEditor = true;
  clearTimeout(monacoLoadTimeout);

  const container = document.getElementById('monaco-editor-container');
  const fallback  = document.getElementById('fallback-editor');
  if (container) container.style.display = 'none';
  if (!fallback) return;

  fallback.style.display = 'block';

  let initialJson;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    initialJson = saved
      ? JSON.stringify(JSON.parse(saved), null, 2)
      : JSON.stringify(DEFAULT_PLAYLIST, null, 2);
  } catch (_) {
    initialJson = JSON.stringify(DEFAULT_PLAYLIST, null, 2);
  }

  fallback.value = initialJson;
  fallback.addEventListener('input', refreshValidationStatus);
  fallback.addEventListener('blur', applyPlaylistOnEditorBlur);

  // Tab key inserts two spaces instead of moving focus
  fallback.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = fallback.selectionStart;
      const end   = fallback.selectionEnd;
      fallback.value = fallback.value.substring(0, start) + '  ' + fallback.value.substring(end);
      fallback.selectionStart = fallback.selectionEnd = start + 2;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      applyPlaylist();
    }
  });

  refreshValidationStatus();
  applyPlaylist();
}

function initMonaco() {
  // Guard: if the Monaco loader script itself didn't attach `require`, bail out
  if (typeof require === 'undefined') {
    activateFallbackEditor();
    return;
  }

  // Fallback trigger if Monaco doesn't initialise within 6 seconds
  monacoLoadTimeout = setTimeout(() => {
    if (!monacoEditor) activateFallbackEditor();
  }, 6000);

  try {
    require.config({
      paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs' },
    });

    require(['vs/editor/editor.main'], function () {
      clearTimeout(monacoLoadTimeout);

      // Bail out if the fallback editor was already activated while we waited
      // (e.g., CDN timed-out then finally resolved late).
      if (usingFallbackEditor) return;

      const SCHEMA_URI = 'https://metronome-playlist/playlist-schema.json';
      const MODEL_URI  = monaco.Uri.parse('https://metronome-playlist/playlist.json');

      // Register the JSON Schema so Monaco can validate + auto-complete
      monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
        validate:             true,
        allowComments:        false,
        enableSchemaRequest:  false,
        schemas: [
          {
            uri:       SCHEMA_URI,
            fileMatch: [MODEL_URI.toString()],
            schema:    PLAYLIST_SCHEMA,
          },
        ],
      });

      // Restore saved playlist or fall back to default
      let initialJson;
      try {
        const saved = localStorage.getItem(STORAGE_KEY);
        initialJson = saved
          ? JSON.stringify(JSON.parse(saved), null, 2)
          : JSON.stringify(DEFAULT_PLAYLIST, null, 2);
      } catch (_) {
        initialJson = JSON.stringify(DEFAULT_PLAYLIST, null, 2);
      }

      const model = monaco.editor.createModel(initialJson, 'json', MODEL_URI);

      monacoEditor = monaco.editor.create(
        document.getElementById('monaco-editor-container'),
        {
          model,
          theme:                'vs-dark',
          automaticLayout:      true,
          minimap:              { enabled: false },
          scrollBeyondLastLine: false,
          fontSize:             13,
          lineNumbers:          'on',
          wordWrap:             'off',
          formatOnType:         true,
          formatOnPaste:        true,
          tabSize:              2,
        },
      );

      // Ctrl/Cmd+Enter → Apply Playlist
      monacoEditor.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
        applyPlaylist,
      );

      // Validate on every content change
      model.onDidChangeContent(() => refreshValidationStatus());

      // Apply playlist whenever the editor loses focus (editor blur)
      monacoEditor.onDidBlurEditorText(applyPlaylistOnEditorBlur);

      // Run initial validation and load playlist
      refreshValidationStatus();
      applyPlaylist();
    });
  } catch (err) {
    console.warn('Monaco failed to initialise:', err);
    activateFallbackEditor();
  }
}

/** Parse the editor value and update the validation indicator. */
function refreshValidationStatus() {
  const value = getEditorValue();
  if (!value && !monacoEditor && !usingFallbackEditor) return;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      setValidation('invalid', '✗ Root must be a JSON array');
      return;
    }
    if (parsed.length === 0) {
      setValidation('warning', '⚠ Array is empty');
      return;
    }
    setValidation('valid', `✓ ${parsed.length} song${parsed.length !== 1 ? 's' : ''}`);
  } catch (e) {
    setValidation('invalid', `✗ ${e.message}`);
  }
}

function setValidation(state, msg) {
  elValidationMsg.textContent = msg;
  elValidationMsg.className   = `validation-msg ${state}`;
}

/** Read the editor, validate, and apply as the active playlist. */
function applyPlaylist() {
  const value = getEditorValue();
  if (!value) return;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (e) {
    setValidation('invalid', `✗ ${e.message}`);
    return;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    setValidation('invalid', '✗ Must be a non-empty array');
    return;
  }

  // Stop current playback before switching
  if (elMetronome?.isPlaying || elMetronome?.isPaused) elMetronome.stop();

  loadPlaylist(parsed);

  // Brief success feedback on the button
  const prev = elApplyBtn.textContent;
  elApplyBtn.textContent = '✓ Applied!';
  elApplyBtn.style.background  = 'var(--success)';
  elApplyBtn.style.borderColor = 'var(--success)';
  setTimeout(() => {
    elApplyBtn.textContent = prev;
    elApplyBtn.style.background  = '';
    elApplyBtn.style.borderColor = '';
  }, 1400);
}

/* ─────────────────────────────────────────────────────────────────────────
   Edit-mode helpers: sync, field blur, move song
───────────────────────────────────────────────────────────────────────── */

/**
 * Push the current in-memory playlist into whichever editor is active
 * without resetting the current song index or triggering an apply loop.
 */
function syncEditorFromPlaylist() {
  const json = JSON.stringify(playlist, null, 2);
  if (usingFallbackEditor) {
    const ta = document.getElementById('fallback-editor');
    if (ta) ta.value = json;
  } else if (monacoEditor) {
    monacoEditor.setValue(json);
  }
  refreshValidationStatus();
}

/**
 * If the metronome is currently playing or paused, stop it and restart if
 * it was playing.  Used after in-place song edits to pick up new settings.
 */
function restartMetronomeIfPlaying() {
  if (elMetronome?.isPlaying || elMetronome?.isPaused) {
    const wasPlaying = elMetronome.isPlaying;
    elMetronome.stop();
    if (wasPlaying) elMetronome.play();
  }
}

/**
 * Called when any editable song field (name / tempo / beats / subdivision)
 * loses focus.  Validates the new values, updates the playlist in memory,
 * syncs the JSON editor and refreshes the metronome visuals.
 */
function onEditFieldBlur() {
  if (!playlist[currentSongIndex]) return;

  const name        = elEditName.value.trim();
  const tempo       = parseFloat(elEditTempo.value);
  const beats       = parseInt(elEditBeats.value, 10);
  const subdivision = parseInt(elEditSubdivision.value, 10);

  // Reject invalid values and restore the previous display
  if (
    !name ||
    isNaN(tempo) || tempo < 20 || tempo > 400 ||
    isNaN(beats) || beats < 1  || beats > 32  ||
    isNaN(subdivision) || subdivision < 1 || subdivision > 8
  ) {
    updateSongDisplay();
    return;
  }

  // Update in-memory playlist and persist
  playlist[currentSongIndex] = { ...playlist[currentSongIndex], name, tempo, beats, subdivision };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(playlist));

  // Sync JSON editor and refresh static display
  syncEditorFromPlaylist();
  updateSongDisplay();
  updateUI();

  restartMetronomeIfPlaying();
}

/**
 * Move the currently selected song up (-1) or down (+1) in the playlist.
 * @param {-1|1} direction
 */
function moveSong(direction) {
  const newIndex = currentSongIndex + direction;
  if (newIndex < 0 || newIndex >= playlist.length) return;

  // Swap the two songs
  [playlist[currentSongIndex], playlist[newIndex]] = [playlist[newIndex], playlist[currentSongIndex]];
  currentSongIndex = newIndex;

  // Persist and sync editor
  localStorage.setItem(STORAGE_KEY, JSON.stringify(playlist));
  syncEditorFromPlaylist();

  updateSongDisplay();
  updateUI();
}

/**
 * Insert a new song with default settings before (offset 0) or after
 * (offset 1) the current song, then navigate to it.
 * @param {0|1} offset  0 = insert before current, 1 = insert after current
 */
function insertSong(offset) {
  const newSong = { name: 'New Song', tempo: 100, beats: 4, subdivision: 1 };
  const insertIndex = playlist.length === 0 ? 0 : currentSongIndex + offset;
  playlist.splice(insertIndex, 0, newSong);
  currentSongIndex = insertIndex;

  localStorage.setItem(STORAGE_KEY, JSON.stringify(playlist));
  syncEditorFromPlaylist();

  updateSongDisplay();
  updateUI();
  restartMetronomeIfPlaying();
}

/**
 * Delete the current song from the playlist.
 * Navigates to the next song, or to the (new) last song when the last entry
 * was deleted.  Stops playback first; restarts on the new current song if
 * playback was active.
 */
function deleteSong() {
  if (playlist.length === 0) return;

  const wasPlaying = elMetronome?.isPlaying ?? false;
  if (elMetronome?.isPlaying || elMetronome?.isPaused) elMetronome.stop();

  playlist.splice(currentSongIndex, 1);

  if (playlist.length === 0) {
    currentSongIndex = 0;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(playlist));
    syncEditorFromPlaylist();
    updateSongDisplay();
    updateUI();
    return;
  }

  // Stay at the same index (now pointing to the next song), but clamp to the
  // last position when the deleted song was the last one.
  currentSongIndex = Math.min(currentSongIndex, playlist.length - 1);

  localStorage.setItem(STORAGE_KEY, JSON.stringify(playlist));
  syncEditorFromPlaylist();

  updateSongDisplay();
  updateUI();

  if (wasPlaying) elMetronome?.play();
}

/**
 * Called on `input` events for the numeric edit fields (tempo / beats /
 * subdivision).  Applies the new values immediately when all fields are valid,
 * without restoring the fields on invalid mid-typing states.
 */
function onEditFieldInput() {
  if (!playlist[currentSongIndex]) return;

  const name        = elEditName.value.trim();
  const tempo       = parseFloat(elEditTempo.value);
  const beats       = parseInt(elEditBeats.value, 10);
  const subdivision = parseInt(elEditSubdivision.value, 10);

  // Only apply when every field is currently valid; otherwise do nothing
  // (onEditFieldBlur will restore invalid values when focus leaves the field)
  if (
    !name ||
    isNaN(tempo) || tempo < 20 || tempo > 400 ||
    isNaN(beats) || beats < 1  || beats > 32  ||
    isNaN(subdivision) || subdivision < 1 || subdivision > 8
  ) {
    return;
  }

  // Update in-memory playlist and persist
  playlist[currentSongIndex] = { ...playlist[currentSongIndex], name, tempo, beats, subdivision };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(playlist));

  // Sync JSON editor (without resetting the edit fields themselves)
  syncEditorFromPlaylist();
  updateUI();

  // Restart if currently playing so the new settings take effect immediately
  restartMetronomeIfPlaying();
}

/**
 * Like applyPlaylist() but called on editor blur: applies valid JSON while
 * preserving the current song index (clamped to the new playlist length).
 * Does not show the "✓ Applied!" button feedback.
 * No-ops when the serialised content is identical to the current playlist
 * (avoids audible interruptions when the user clicks away without changing
 * anything).  Also validates required per-song fields before applying.
 */
function applyPlaylistOnEditorBlur() {
  const value = getEditorValue();
  if (!value) return;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (_) {
    return; // keep whatever is in memory; don't disrupt playback
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return;

  // Validate required per-song fields/ranges (same rules as onEditFieldBlur)
  for (const s of parsed) {
    const name        = typeof s.name === 'string' ? s.name.trim() : '';
    const tempo       = parseFloat(s.tempo);
    const beats       = parseInt(s.beats, 10);
    const subdivision = parseInt(s.subdivision ?? 1, 10);
    if (
      !name ||
      isNaN(tempo) || tempo < 20 || tempo > 400 ||
      isNaN(beats) || beats < 1  || beats > 32  ||
      isNaN(subdivision) || subdivision < 1 || subdivision > 8
    ) {
      return; // silently ignore; user will see the problem on explicit Apply
    }
  }

  // Skip stop/restart if the playlist content has not actually changed.
  // Normalise both sides identically (subdivision default first) so key
  // ordering differences don't produce false negatives.
  const normalized        = parsed.map(s => ({ subdivision: 1, ...s }));
  const normalizedCurrent = playlist.map(s => ({ subdivision: 1, ...s }));
  if (JSON.stringify(normalized) === JSON.stringify(normalizedCurrent)) return;

  const wasPlaying   = elMetronome?.isPlaying ?? false;
  const savedIndex   = currentSongIndex;
  if (elMetronome?.isPlaying || elMetronome?.isPaused) elMetronome.stop();

  playlist          = normalized;
  currentSongIndex  = Math.min(savedIndex, playlist.length - 1);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(playlist));

  updateSongDisplay();
  updateUI();
  if (wasPlaying) elMetronome?.play();
}

/* ─────────────────────────────────────────────────────────────────────────
   Editor panel toggle
───────────────────────────────────────────────────────────────────────── */

function setEditorVisible(visible) {
  if (visible) {
    elEditorPanel.classList.remove('editor-hidden');
    elEditorPanel.setAttribute('aria-hidden', 'false');
    elToggleEditorBtn.setAttribute('aria-pressed', 'true');
    elToggleEditorBtn.setAttribute('title', 'Toggle Play Mode');
    elToggleEditorBtn.textContent = '✏️ Toggle Play Mode';
    elToggleEditorBtn.setAttribute('aria-label', 'Toggle Play Mode');
    document.body.classList.add('edit-mode');
  } else {
    elEditorPanel.classList.add('editor-hidden');
    elEditorPanel.setAttribute('aria-hidden', 'true');
    elToggleEditorBtn.setAttribute('aria-pressed', 'false');
    elToggleEditorBtn.setAttribute('title', 'Toggle Edit Mode');
    elToggleEditorBtn.textContent = '▶ Toggle Edit Mode';
    elToggleEditorBtn.setAttribute('aria-label', 'Toggle Edit Mode');
    document.body.classList.remove('edit-mode');
  }

  // On mobile the editor panel is always in the DOM (overflow-scroll layout).
  // Scroll the viewport to whichever panel is now active.
  if (window.matchMedia('(max-width: 680px)').matches) {
    const target = visible ? elEditorPanel : document.getElementById('player-panel');
    const prefersReducedMotion =
      window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const scrollBehavior = prefersReducedMotion ? 'auto' : 'smooth';
    target.scrollIntoView({ behavior: scrollBehavior, block: 'start' });
  }

  // Give the CSS transition time to complete before asking Monaco to re-layout
  if (monacoEditor) {
    setTimeout(() => monacoEditor.layout(), 280);
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   Initialisation
───────────────────────────────────────────────────────────────────────── */

function init() {
  // Resolve DOM references
  elMetronome = document.getElementById('metronome-player');

  elPrevSong  = document.getElementById('prev-song-btn');
  elNextSong  = document.getElementById('next-song-btn');
  elSongName  = document.getElementById('song-name');
  elSongMeta  = document.getElementById('song-meta');
  elSongPos   = document.getElementById('song-position');
  elSongOrder = document.getElementById('song-order');

  elEditName        = document.getElementById('edit-name');
  elEditTempo       = document.getElementById('edit-tempo');
  elEditBeats       = document.getElementById('edit-beats');
  elEditSubdivision = document.getElementById('edit-subdivision');
  elMoveUpBtn       = document.getElementById('move-up-btn');
  elMoveDownBtn     = document.getElementById('move-down-btn');
  elInsertBeforeBtn = document.getElementById('insert-before-btn');
  elInsertAfterBtn  = document.getElementById('insert-after-btn');
  elDeleteSongBtn   = document.getElementById('delete-song-btn');

  elValidationMsg  = document.getElementById('validation-msg');
  elApplyBtn       = document.getElementById('apply-btn');
  elToggleEditorBtn = document.getElementById('toggle-editor-btn');
  elCloseEditorBtn  = document.getElementById('close-editor-btn');
  elEditorPanel     = document.getElementById('editor-panel');

  // Song navigation
  elPrevSong.addEventListener('click', () => goToSong(currentSongIndex - 1));
  elNextSong.addEventListener('click', () => goToSong(currentSongIndex + 1));

  // Edit-mode field changes → sync to editor on blur
  [elEditName, elEditTempo, elEditBeats, elEditSubdivision].forEach(el => {
    el.addEventListener('blur', onEditFieldBlur);
  });

  // Number fields also respond immediately on input (e.g. spinner up/down)
  [elEditTempo, elEditBeats, elEditSubdivision].forEach(el => {
    el.addEventListener('input', onEditFieldInput);
  });

  // Move up / down buttons
  elMoveUpBtn.addEventListener('click',   () => moveSong(-1));
  elMoveDownBtn.addEventListener('click', () => moveSong(1));

  // Insert before / after buttons
  elInsertBeforeBtn.addEventListener('click', () => insertSong(0));
  elInsertAfterBtn.addEventListener('click',  () => insertSong(1));

  // Delete current song button
  elDeleteSongBtn.addEventListener('click', deleteSong);

  // Editor panel toggle
  elToggleEditorBtn.addEventListener('click', () => {
    const hidden = elEditorPanel.classList.contains('editor-hidden');
    setEditorVisible(hidden); // show if currently hidden, hide if visible
  });
  elCloseEditorBtn.addEventListener('click', () => setEditorVisible(false));

  // Apply button
  elApplyBtn.addEventListener('click', applyPlaylist);

  // Set initial edit-mode state (editor starts visible by default)
  const editorStartsVisible = !elEditorPanel.classList.contains('editor-hidden');
  setEditorVisible(editorStartsVisible);

  updateUI();

  // If the Monaco loader script failed (e.g., CDN blocked/offline), activate fallback immediately
  if (typeof require === 'undefined') {
    activateFallbackEditor();
  } else {
    // Initialise the Monaco editor (async, loads from CDN)
    initMonaco();
  }
}

document.addEventListener('DOMContentLoaded', init);
