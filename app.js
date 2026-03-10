/**
 * Metronome Playlist — app.js
 *
 * Features:
 *  - Monaco Editor with JSON Schema validation and code-completion hints
 *  - Web Audio API metronome engine (lookahead scheduler for accurate timing)
 *  - SVG pendulum animation synchronized to tempo
 *  - Beat-light indicators (accent on beat 1)
 *  - Play / Pause / Stop controls
 *  - Sound on/off toggle
 *  - Prev/Next song navigation
 *  - Playlist persisted in localStorage
 */

'use strict';

/* ─────────────────────────────────────────────────────────────────────────
   Constants & defaults
───────────────────────────────────────────────────────────────────────── */

const STORAGE_KEY = 'metronome-playlist-v1';

/** Lookahead window for the Web Audio scheduler (seconds). */
const LOOKAHEAD_TIME = 0.12;

/** How often the scheduler tick fires (ms). */
const SCHEDULE_INTERVAL_MS = 25;

/** Max pendulum swing angle in degrees. */
const MAX_ANGLE = 28;

/** Flash duration for beat lights / bob (ms). */
const FLASH_MS = 140;

/**
 * How many consumed entries to accumulate in visualQueue before trimming them.
 * Keeps memory bounded while avoiding per-frame allocations (shift() is O(n)).
 */
const VISUAL_QUEUE_TRIM_THRESHOLD = 32;

/** Default field values used when adding a new song via the inline editor. */
const DEFAULT_NEW_SONG_TEMPO      = 120;
const DEFAULT_NEW_SONG_BEATS      = 4;
const DEFAULT_NEW_SONG_SUBDIVISION = 1;

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

let isPlaying = false;
let isPaused  = false;
let soundEnabled = true;

// Metronome engine state
/** @type {AudioContext|null} */
let audioCtx = null;

let schedulerTimer = null;
let nextBeatTime = 0;        // audioCtx.currentTime of the next event to schedule
let currentBeat = 0;         // beat within the measure [0, beats)
let currentSubdiv = 0;       // subdivision step within the beat [0, subdivision)

// Visual sync state
let playStartAudioTime = 0;  // audioCtx.currentTime of beat 0 of measure 0
let beatDurSeconds = 0;      // duration of one main beat (seconds)

/** @type {Array<{audioTime:number, beat:number, isSubdiv:boolean}>} */
let visualQueue = [];
let visualQueueHead = 0;

let animationFrameId = null;

// DOM element references (populated in init())
let elPlayBtn, elStopBtn, elSoundBtn;
let elPrevSong, elNextSong, elSongName, elSongMeta, elSongPos;
let elPendulum, elPendulumBob, elWeightRect, elBeatText;
let elBeatLightsRow;
let elValidationMsg, elApplyBtn, elToggleEditorBtn, elCloseEditorBtn, elEditorPanel;
let elPlaylistList, elAddSongBtn;

/** References to beat-light dot elements for the current song. */
let beatDots = [];

/** @type {import('monaco-editor').editor.IStandaloneCodeEditor|null} */
let monacoEditor = null;
/** True once we have given up waiting for Monaco to load. */
let usingFallbackEditor = false;
/** Timeout handle used to detect Monaco CDN failure. */
let monacoLoadTimeout = null;

/* ─────────────────────────────────────────────────────────────────────────
   Web Audio helpers
───────────────────────────────────────────────────────────────────────── */

function ensureAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}

/**
 * Schedule a short click at the given audioCtx time.
 * @param {number} time  - audioCtx scheduled time
 * @param {'accent'|'beat'|'subdiv'} type
 */
function scheduleClick(time, type) {
  if (!soundEnabled || !audioCtx) return;

  const gainNode = audioCtx.createGain();
  gainNode.connect(audioCtx.destination);

  const osc = audioCtx.createOscillator();
  osc.connect(gainNode);
  osc.type = 'triangle';

  let freq, peakGain, releaseSec;
  if (type === 'accent') {
    freq = 1400; peakGain = 0.9; releaseSec = 0.05;
  } else if (type === 'beat') {
    freq = 880;  peakGain = 0.65; releaseSec = 0.04;
  } else {
    freq = 580;  peakGain = 0.25; releaseSec = 0.025;
  }

  osc.frequency.setValueAtTime(freq, time);
  gainNode.gain.setValueAtTime(0, time);
  gainNode.gain.linearRampToValueAtTime(peakGain, time + 0.003);
  gainNode.gain.exponentialRampToValueAtTime(0.001, time + releaseSec);

  osc.start(time);
  osc.stop(time + releaseSec + 0.01);
}

/* ─────────────────────────────────────────────────────────────────────────
   Metronome scheduler
───────────────────────────────────────────────────────────────────────── */

function scheduleBeats() {
  const song = playlist[currentSongIndex];
  if (!song) return;

  const beatDur  = 60 / song.tempo;
  const subdivDur = beatDur / (song.subdivision || 1);

  while (nextBeatTime < audioCtx.currentTime + LOOKAHEAD_TIME) {
    const isBeatStart   = currentSubdiv === 0;
    const isAccentBeat  = isBeatStart && currentBeat === 0;

    if (isBeatStart) {
      scheduleClick(nextBeatTime, isAccentBeat ? 'accent' : 'beat');
    } else {
      scheduleClick(nextBeatTime, 'subdiv');
    }

    // Queue a visual event keyed to this audioCtx time
    visualQueue.push({
      audioTime: nextBeatTime,
      beat:      currentBeat,
      isSubdiv:  !isBeatStart,
    });

    // Advance state
    currentSubdiv++;
    if (currentSubdiv >= (song.subdivision || 1)) {
      currentSubdiv = 0;
      currentBeat++;
      if (currentBeat >= song.beats) {
        currentBeat = 0;
      }
    }
    nextBeatTime += subdivDur;
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   Animation loop (pendulum + visual beat processing)
───────────────────────────────────────────────────────────────────────── */

function animationLoop() {
  if (!isPlaying || !audioCtx) return;

  const song = playlist[currentSongIndex];
  if (!song) return;

  const now = audioCtx.currentTime;

  // ── Pendulum position ──────────────────────────────────────────────────
  // The pendulum reaches an extreme every beat.
  // cos(π · elapsed/beatDur):  at t=0 → +1, at t=beatDur → −1, at t=2·beatDur → +1
  const elapsed = now - playStartAudioTime;
  const angle = MAX_ANGLE * Math.cos(Math.PI * (elapsed / beatDurSeconds));
  elPendulum.setAttribute('transform', `rotate(${angle}, 100, 197)`);

  // ── Process visual queue ───────────────────────────────────────────────
  // A small tolerance (one animation frame ≈ 16 ms) so we don't miss flashes
  while (visualQueueHead < visualQueue.length &&
         visualQueue[visualQueueHead].audioTime <= now + 0.018) {
    const evt = visualQueue[visualQueueHead++];
    if (!evt.isSubdiv) {
      triggerBeatFlash(evt.beat, evt.beat === 0);
    }
    // Subdivision ticks: only a subtle bob pulse (no light change)
    if (evt.isSubdiv) {
      pulseBob(false, true);
    }
  }
  // Trim the consumed prefix periodically to prevent unbounded memory growth
  if (visualQueueHead >= VISUAL_QUEUE_TRIM_THRESHOLD) {
    visualQueue.splice(0, visualQueueHead);
    visualQueueHead = 0;
  }

  animationFrameId = requestAnimationFrame(animationLoop);
}

/* ─────────────────────────────────────────────────────────────────────────
   Visual helpers
───────────────────────────────────────────────────────────────────────── */

/**
 * Flash a beat-light dot and the pendulum bob.
 * @param {number}  beatIndex  - 0-based beat index
 * @param {boolean} isAccent   - true for beat 1 (index 0)
 */
function triggerBeatFlash(beatIndex, isAccent) {
  // Update beat counter text
  elBeatText.textContent = String(beatIndex + 1);

  // Light up the correct dot
  beatDots.forEach((dot, i) => {
    dot.classList.remove('lit-beat', 'lit-accent');
    if (i === beatIndex) {
      dot.classList.add(isAccent ? 'lit-accent' : 'lit-beat');
      setTimeout(() => dot.classList.remove('lit-beat', 'lit-accent'), FLASH_MS);
    }
  });

  // Flash the bob
  pulseBob(isAccent, false);
}

/**
 * Briefly change the pendulum-bob colour.
 * @param {boolean} isAccent
 * @param {boolean} isSubdiv
 */
function pulseBob(isAccent, isSubdiv) {
  if (isSubdiv) {
    // Very subtle subdivision pulse
    elPendulumBob.style.fill = '#78c8ff';
    setTimeout(() => { elPendulumBob.style.fill = 'var(--bob-idle, #4a9eff)'; }, 60);
  } else {
    const color = isAccent ? 'var(--bob-accent, #ff5744)' : 'var(--bob-beat, #ffe44a)';
    const glow  = isAccent ? '#ff5744' : '#ffe44a';
    elPendulumBob.style.fill = color;
    elPendulumBob.style.filter = `drop-shadow(0 0 8px ${glow})`;
    setTimeout(() => {
      elPendulumBob.style.fill   = 'var(--bob-idle, #4a9eff)';
      elPendulumBob.style.filter = '';
    }, FLASH_MS);
  }
}

/** Re-render beat-light dots to match the current song's beat count. */
function renderBeatDots(numBeats) {
  elBeatLightsRow.innerHTML = '';
  beatDots = [];
  for (let i = 0; i < numBeats; i++) {
    const dot = document.createElement('div');
    dot.className = 'beat-dot';
    dot.title = `Beat ${i + 1}`;
    elBeatLightsRow.appendChild(dot);
    beatDots.push(dot);
  }
}

/** Reset the pendulum to centre and clear all lights. */
function resetVisuals() {
  elPendulum.setAttribute('transform', 'rotate(0, 100, 197)');
  elBeatText.textContent = '—';
  beatDots.forEach(d => d.classList.remove('lit-beat', 'lit-accent'));
  elPendulumBob.style.fill   = '';
  elPendulumBob.style.filter = '';
}

/** Position the weight-rect on the rod to reflect the current tempo. */
function positionWeightForTempo(tempo) {
  // Map 20 BPM → y=90 (high on rod, slower) … 400 BPM → y=175 (low on rod, faster)
  // In SVG y increases downward, so a smaller y is physically higher.
  const minY = 90, maxY = 175;
  const y = minY + ((tempo - 20) / (400 - 20)) * (maxY - minY);
  elWeightRect.setAttribute('y', y.toFixed(1));
}

/* ─────────────────────────────────────────────────────────────────────────
   Metronome playback control
───────────────────────────────────────────────────────────────────────── */

function startMetronome() {
  const song = playlist[currentSongIndex];
  if (!song) return;

  ensureAudioContext();

  currentBeat  = 0;
  currentSubdiv = 0;
  beatDurSeconds = 60 / song.tempo;
  nextBeatTime   = audioCtx.currentTime + 0.05;
  playStartAudioTime = nextBeatTime;
  visualQueue    = [];
  visualQueueHead = 0;

  schedulerTimer = setInterval(scheduleBeats, SCHEDULE_INTERVAL_MS);
  animationFrameId = requestAnimationFrame(animationLoop);

  isPlaying = true;
  isPaused  = false;

  renderBeatDots(song.beats);
  positionWeightForTempo(song.tempo);
  updateUI();
}

function pauseMetronome() {
  clearInterval(schedulerTimer);
  schedulerTimer = null;
  cancelAnimationFrame(animationFrameId);
  animationFrameId = null;

  isPaused  = true;
  isPlaying = false;
  updateUI();
}

function resumeMetronome() {
  const song = playlist[currentSongIndex];
  if (!song) return;

  ensureAudioContext();

  // Restart from beat 0
  currentBeat  = 0;
  currentSubdiv = 0;
  beatDurSeconds = 60 / song.tempo;
  nextBeatTime   = audioCtx.currentTime + 0.05;
  playStartAudioTime = nextBeatTime;
  visualQueue    = [];
  visualQueueHead = 0;

  schedulerTimer = setInterval(scheduleBeats, SCHEDULE_INTERVAL_MS);
  animationFrameId = requestAnimationFrame(animationLoop);

  isPlaying = true;
  isPaused  = false;
  updateUI();
}

function stopMetronome() {
  clearInterval(schedulerTimer);
  schedulerTimer = null;
  cancelAnimationFrame(animationFrameId);
  animationFrameId = null;

  isPlaying = false;
  isPaused  = false;
  visualQueue = [];
  visualQueueHead = 0;

  resetVisuals();
  updateUI();
}

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

  renderPlaylistList();
  updateSongDisplay();
  updateUI();

  const song = playlist[0];
  if (song) {
    renderBeatDots(song.beats);
    positionWeightForTempo(song.tempo);
  }
}

/**
 * Navigate to a different song (stopping/restarting if needed).
 * @param {number} index
 */
function goToSong(index) {
  if (index < 0 || index >= playlist.length) return;
  const wasPlaying = isPlaying;
  if (isPlaying || isPaused) stopMetronome();
  currentSongIndex = index;
  updateSongDisplay();
  updateUI();
  const song = playlist[currentSongIndex];
  if (song) {
    renderBeatDots(song.beats);
    positionWeightForTempo(song.tempo);
  }
  if (wasPlaying) startMetronome();
}

function updateSongDisplay() {
  const song = playlist[currentSongIndex];
  if (song) {
    elSongName.textContent = song.name;
    const subdivLabel = (song.subdivision || 1) > 1
      ? ` · ×${song.subdivision} subdivision`
      : '';
    elSongMeta.textContent =
      `${song.tempo} BPM · ${song.beats} beats/bar${subdivLabel}`;
    elSongPos.textContent = `${currentSongIndex + 1} / ${playlist.length}`;
  } else {
    elSongName.textContent = 'No playlist loaded';
    elSongMeta.textContent = '';
    elSongPos.textContent  = '';
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   UI state
───────────────────────────────────────────────────────────────────────── */

function updateUI() {
  const hasPlaylist = playlist.length > 0;

  elPlayBtn.disabled = !hasPlaylist;
  const playBtnConfig = isPlaying  ? { text: '⏸ Pause',   label: 'Pause'   }
                      : isPaused   ? { text: '▶ Restart', label: 'Restart' }
                                   : { text: '▶ Play',    label: 'Play'    };
  elPlayBtn.textContent = playBtnConfig.text;
  elPlayBtn.title = playBtnConfig.label;
  elPlayBtn.setAttribute('aria-label', playBtnConfig.label);
  elStopBtn.disabled  = !isPlaying && !isPaused;

  elPrevSong.disabled = currentSongIndex <= 0;
  elNextSong.disabled = currentSongIndex >= playlist.length - 1;

  if (soundEnabled) {
    elSoundBtn.textContent = '🔊';
    elSoundBtn.classList.add('sound-on');
    elSoundBtn.classList.remove('sound-off');
    elSoundBtn.title = 'Sound on — click to mute';
    elSoundBtn.setAttribute('aria-label', 'Sound on — click to mute');
    elSoundBtn.setAttribute('aria-pressed', 'true');
  } else {
    elSoundBtn.textContent = '🔇';
    elSoundBtn.classList.add('sound-off');
    elSoundBtn.classList.remove('sound-on');
    elSoundBtn.title = 'Sound off — click to unmute';
    elSoundBtn.setAttribute('aria-label', 'Sound off — click to unmute');
    elSoundBtn.setAttribute('aria-pressed', 'false');
  }

  updatePlaylistListEditState();
}

/* ─────────────────────────────────────────────────────────────────────────
   Inline playlist editor
───────────────────────────────────────────────────────────────────────── */

/**
 * (Re)build the full inline playlist list DOM.
 * Call when the playlist structure changes (load, add, remove, reorder).
 */
function renderPlaylistList() {
  if (!elPlaylistList) return;
  elPlaylistList.innerHTML = '';
  const isEditable = !isPlaying && !isPaused;

  playlist.forEach((song, i) => {
    const row = document.createElement('div');
    row.className = 'playlist-row' + (i === currentSongIndex ? ' active-song' : '');
    row.dataset.index = i;

    const nameInput   = makeInput('text',   song.name,               'playlist-name',   isEditable);
    const tempoInput  = makeInput('number', song.tempo,              'playlist-tempo',  isEditable, 20,  400);
    const beatsInput  = makeInput('number', song.beats,              'playlist-beats',  isEditable, 1,   32);
    const subdivInput = makeInput('number', song.subdivision || 1,   'playlist-subdiv', isEditable, 1,   8);

    [nameInput, tempoInput, beatsInput, subdivInput].forEach(inp => {
      inp.addEventListener('blur',  () => commitInlineEdit(i));
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); });
    });

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'playlist-row-actions';
    actionsDiv.appendChild(makeActionBtn('▲', 'Move up',     'move-up',     !isEditable || i === 0,                  () => moveSong(i, -1)));
    actionsDiv.appendChild(makeActionBtn('▼', 'Move down',   'move-down',   !isEditable || i === playlist.length - 1, () => moveSong(i, 1)));
    actionsDiv.appendChild(makeActionBtn('✕', 'Remove song', 'remove-song', !isEditable || playlist.length <= 1,      () => removeSong(i)));

    row.append(nameInput, tempoInput, beatsInput, subdivInput, actionsDiv);
    elPlaylistList.appendChild(row);
  });

  if (elAddSongBtn) elAddSongBtn.disabled = !isEditable;
}

/** Helper: create a styled input for a playlist row. */
function makeInput(type, value, cssClass, enabled, min, max) {
  const inp = document.createElement('input');
  inp.type      = type;
  inp.value     = value;
  inp.className = `playlist-input ${cssClass}`;
  inp.disabled  = !enabled;
  if (min !== undefined) inp.min = min;
  if (max !== undefined) inp.max = max;
  return inp;
}

/** Helper: create a small action button for a playlist row. */
function makeActionBtn(text, title, action, disabled, handler) {
  const btn = document.createElement('button');
  btn.textContent      = text;
  btn.title            = title;
  btn.dataset.action   = action;
  btn.className        = 'playlist-action-btn';
  btn.disabled         = disabled;
  btn.addEventListener('click', handler);
  return btn;
}

/**
 * Update only the editable/disabled state + active-song class of existing rows.
 * Called from updateUI() so we never lose focus while the user is typing.
 */
function updatePlaylistListEditState() {
  if (!elPlaylistList) return;
  const isEditable = !isPlaying && !isPaused;

  elPlaylistList.querySelectorAll('.playlist-row').forEach(row => {
    const idx = parseInt(row.dataset.index, 10);
    row.classList.toggle('active-song', idx === currentSongIndex);

    row.querySelectorAll('.playlist-input').forEach(inp => {
      inp.disabled = !isEditable;
    });

    row.querySelectorAll('.playlist-action-btn').forEach(btn => {
      if (!isEditable) {
        btn.disabled = true;
      } else if (btn.dataset.action === 'move-up') {
        btn.disabled = idx === 0;
      } else if (btn.dataset.action === 'move-down') {
        btn.disabled = idx >= playlist.length - 1;
      } else if (btn.dataset.action === 'remove-song') {
        btn.disabled = playlist.length <= 1;
      }
    });
  });

  if (elAddSongBtn) elAddSongBtn.disabled = !isEditable;
}

/**
 * Read a row's inputs, clamp values, and persist the change to playlist[i].
 * Called on blur of any inline input.
 * @param {number} i  Row index
 */
function commitInlineEdit(i) {
  if (isPlaying || isPaused) return;
  const row = elPlaylistList && elPlaylistList.querySelector(`.playlist-row[data-index="${i}"]`);
  if (!row) return;

  const nameVal   = row.querySelector('.playlist-name').value.trim();
  const tempoVal  = Math.min(400, Math.max(20, parseFloat(row.querySelector('.playlist-tempo').value)  || DEFAULT_NEW_SONG_TEMPO));
  const beatsVal  = Math.min(32,  Math.max(1,  parseInt(row.querySelector('.playlist-beats').value, 10) || DEFAULT_NEW_SONG_BEATS));
  const subdivVal = Math.min(8,   Math.max(1,  parseInt(row.querySelector('.playlist-subdiv').value, 10) || DEFAULT_NEW_SONG_SUBDIVISION));

  if (!nameVal) return; // don't save an empty name

  // Clamp inputs back to valid range in case user typed out-of-bounds values
  row.querySelector('.playlist-tempo').value  = tempoVal;
  row.querySelector('.playlist-beats').value  = beatsVal;
  row.querySelector('.playlist-subdiv').value = subdivVal;

  playlist[i] = { name: nameVal, tempo: tempoVal, beats: beatsVal, subdivision: subdivVal };

  syncPlaylistToEditor();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(playlist));

  if (i === currentSongIndex) {
    updateSongDisplay();
    renderBeatDots(beatsVal);
    positionWeightForTempo(tempoVal);
  }
}

/** Serialize playlist → JSON editor (Monaco or textarea) and refresh validation. */
function syncPlaylistToEditor() {
  const json = JSON.stringify(playlist, null, 2);
  if (usingFallbackEditor) {
    const ta = document.getElementById('fallback-editor');
    if (ta) ta.value = json;
  } else if (monacoEditor) {
    const model = monacoEditor.getModel();
    if (model) model.setValue(json);
  }
  refreshValidationStatus();
}

/** Move the song at index i by delta (-1 = up, +1 = down). */
function moveSong(i, delta) {
  if (isPlaying || isPaused) return;
  const j = i + delta;
  if (j < 0 || j >= playlist.length) return;

  [playlist[i], playlist[j]] = [playlist[j], playlist[i]];
  if (currentSongIndex === i)      currentSongIndex = j;
  else if (currentSongIndex === j) currentSongIndex = i;

  renderPlaylistList();
  syncPlaylistToEditor();
  updateSongDisplay();
  updateUI();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(playlist));
}

/** Remove the song at index i from the playlist. */
function removeSong(i) {
  if (isPlaying || isPaused) return;
  if (playlist.length <= 1) return;

  playlist.splice(i, 1);
  if (currentSongIndex >= playlist.length) currentSongIndex = playlist.length - 1;

  renderPlaylistList();
  syncPlaylistToEditor();
  updateSongDisplay();
  updateUI();
  const song = playlist[currentSongIndex];
  if (song) {
    renderBeatDots(song.beats);
    positionWeightForTempo(song.tempo);
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(playlist));
}

/** Append a new default song and focus its name input. */
function addSong() {
  if (isPlaying || isPaused) return;
  playlist.push({
    name:        'New Song',
    tempo:       DEFAULT_NEW_SONG_TEMPO,
    beats:       DEFAULT_NEW_SONG_BEATS,
    subdivision: DEFAULT_NEW_SONG_SUBDIVISION,
  });

  renderPlaylistList();
  syncPlaylistToEditor();
  updateSongDisplay();
  updateUI();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(playlist));

  // Focus the new row's name input — renderPlaylistList() is synchronous so
  // the DOM is already updated; a single rAF waits for the next paint.
  requestAnimationFrame(() => {
    const rows = elPlaylistList ? elPlaylistList.querySelectorAll('.playlist-row') : [];
    const lastRow = rows[rows.length - 1];
    if (lastRow) {
      const inp = lastRow.querySelector('.playlist-name');
      if (inp) { inp.select(); inp.focus(); }
    }
  });
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
  if (isPlaying || isPaused) stopMetronome();

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
   Editor panel toggle
───────────────────────────────────────────────────────────────────────── */

function setEditorVisible(visible) {
  if (visible) {
    elEditorPanel.classList.remove('editor-hidden');
    elToggleEditorBtn.setAttribute('aria-pressed', 'true');
  } else {
    elEditorPanel.classList.add('editor-hidden');
    elToggleEditorBtn.setAttribute('aria-pressed', 'false');
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
  elPlayBtn   = document.getElementById('play-btn');
  elStopBtn   = document.getElementById('stop-btn');
  elSoundBtn  = document.getElementById('sound-btn');

  elPrevSong  = document.getElementById('prev-song-btn');
  elNextSong  = document.getElementById('next-song-btn');
  elSongName  = document.getElementById('song-name');
  elSongMeta  = document.getElementById('song-meta');
  elSongPos   = document.getElementById('song-position');

  elPendulum    = document.getElementById('pendulum');
  elPendulumBob = document.getElementById('pendulum-bob');
  elWeightRect  = document.getElementById('weight-rect');
  elBeatText    = document.getElementById('beat-text');

  elBeatLightsRow  = document.getElementById('beat-lights-row');
  elValidationMsg  = document.getElementById('validation-msg');
  elApplyBtn       = document.getElementById('apply-btn');
  elToggleEditorBtn = document.getElementById('toggle-editor-btn');
  elCloseEditorBtn  = document.getElementById('close-editor-btn');
  elEditorPanel     = document.getElementById('editor-panel');
  elPlaylistList    = document.getElementById('playlist-list');
  elAddSongBtn      = document.getElementById('add-song-btn');

  // Transport controls
  elPlayBtn.addEventListener('click', () => {
    if (isPlaying) {
      pauseMetronome();
    } else if (isPaused) {
      ensureAudioContext();
      resumeMetronome();
    } else {
      ensureAudioContext();
      startMetronome();
    }
  });
  elStopBtn.addEventListener('click',  stopMetronome);

  elSoundBtn.addEventListener('click', () => {
    soundEnabled = !soundEnabled;
    updateUI();
  });

  // Song navigation
  elPrevSong.addEventListener('click', () => goToSong(currentSongIndex - 1));
  elNextSong.addEventListener('click', () => goToSong(currentSongIndex + 1));

  // Editor panel toggle
  elToggleEditorBtn.addEventListener('click', () => {
    const hidden = elEditorPanel.classList.contains('editor-hidden');
    setEditorVisible(hidden); // show if currently hidden, hide if visible
  });
  elCloseEditorBtn.addEventListener('click', () => setEditorVisible(false));

  // Apply button
  elApplyBtn.addEventListener('click', applyPlaylist);

  // Inline playlist list — add song
  elAddSongBtn.addEventListener('click', addSong);

  // Set initial UI state
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
