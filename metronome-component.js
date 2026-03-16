/**
 * Metronome Playlist — metronome-component.js
 *
 * Self-contained metronome custom element built with Preact + HTM.
 * Exposed as <metronome-player>.
 *
 * Settable properties (no HTML attributes required):
 *   tempo         {number}  beats per minute (20–400)
 *   beats         {number}  beats per measure (1–32)
 *   subdivision   {number}  subdivision per beat (1–8, default 1)
 *   playbackState {'playing'|'paused'|'stopped'}
 *                           set to drive playback declaratively;
 *                           read to get the current state
 *
 * Methods (kept for convenience; prefer playbackState setter):
 *   play()   – start or restart playback
 *   pause()  – pause playback
 *   stop()   – stop and reset visuals
 *
 * Read-only getters:
 *   isPlaying  {boolean}
 *   isPaused   {boolean}
 */

import { html }           from 'htm/preact';
import {
  useState, useEffect, useRef, useCallback, useMemo,
} from 'preact/hooks';
import { preactComponent } from './utils.js';

/* ── Constants ────────────────────────────────────────────────────────── */

const LOOKAHEAD_TIME            = 0.12;   // seconds
const SCHEDULE_INTERVAL_MS      = 25;     // ms
const MAX_ANGLE                 = 28;     // degrees
const FLASH_MS                  = 140;    // ms
const VISUAL_QUEUE_TRIM_THRESHOLD = 32;

/* ══════════════════════════════════════════════════════════════════════
   MetronomePlayer — Preact functional component
   ══════════════════════════════════════════════════════════════════════ */

/**
 * @param {{
 *   tempo:      number,
 *   beats:      number,
 *   subdivision:number,
 *   onApiReady: (api: object) => void,
 * }} props
 */
function MetronomePlayer({ tempo, beats, subdivision, onApiReady }) {

  /* ── Playback state (triggers button re-renders) ──────────────────── */
  const [isPlaying,    setIsPlaying]    = useState(false);
  const [isPaused,     setIsPaused]     = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);

  /* ── Engine refs — updated without causing re-renders ────────────── */
  const tempoRef   = useRef(tempo);
  const beatsRef   = useRef(beats);
  const subdivRef  = useRef(subdivision);
  const isPlayingRef          = useRef(false);
  const isPausedRef           = useRef(false);
  const pausedByVisibilityRef = useRef(false);
  const soundEnabledRef       = useRef(true);

  const audioCtxRef        = useRef(null);
  const schedulerTimerRef  = useRef(null);
  const animFrameRef       = useRef(null);

  const visualQueueRef     = useRef([]);
  const visualQueueHeadRef = useRef(0);
  const nextBeatTimeRef    = useRef(0);
  const currentBeatRef     = useRef(0);
  const currentSubdivRef   = useRef(0);
  const playStartTimeRef   = useRef(0);
  const beatDurRef         = useRef(0);
  const wakeLockRef        = useRef(null);

  /* ── DOM refs (direct manipulation for animation performance) ─────── */
  const pendulumGroupRef     = useRef(null);
  const weightRef            = useRef(null);
  const beatTextRef          = useRef(null);
  const beatDotsContainerRef = useRef(null);
  const beatDotRefsRef       = useRef([]);

  /* ── Sync prop refs synchronously on every render ────────────────── */
  // Updating refs in the render body is a standard pattern for "latest props"
  // refs: it ensures startEngine() always reads the correct values even when
  // called by the custom element immediately after setting a property (before
  // any useEffect has had a chance to run).
  tempoRef.current  = tempo;
  beatsRef.current  = beats;
  subdivRef.current = subdivision;

  /* ── Sync soundEnabled → ref ──────────────────────────────────────── */
  useEffect(() => { soundEnabledRef.current = soundEnabled; }, [soundEnabled]);

  /* ── Web Audio helpers ────────────────────────────────────────────── */

  const ensureAudioContext = useCallback(() => {
    if (!audioCtxRef.current) {
      audioCtxRef.current =
        new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume();
    }
  }, []);

  const scheduleClick = useCallback((time, type) => {
    if (!soundEnabledRef.current || !audioCtxRef.current) return;
    const ctx      = audioCtxRef.current;
    const gainNode = ctx.createGain();
    gainNode.connect(ctx.destination);
    const osc = ctx.createOscillator();
    osc.connect(gainNode);
    osc.type = 'triangle';

    let freq, peakGain, releaseSec;
    if      (type === 'accent') { freq = 1400; peakGain = 0.9;  releaseSec = 0.05;  }
    else if (type === 'beat')   { freq = 880;  peakGain = 0.65; releaseSec = 0.04;  }
    else                        { freq = 580;  peakGain = 0.25; releaseSec = 0.025; }

    osc.frequency.setValueAtTime(freq, time);
    gainNode.gain.setValueAtTime(0, time);
    gainNode.gain.linearRampToValueAtTime(peakGain, time + 0.003);
    gainNode.gain.exponentialRampToValueAtTime(0.001, time + releaseSec);
    osc.start(time);
    osc.stop(time + releaseSec + 0.01);
  }, []);

  /* ── Screen Wake Lock helpers ─────────────────────────────────────── */

  const acquireWakeLock = useCallback(async () => {
    if (!('wakeLock' in navigator)) return;
    try {
      wakeLockRef.current = await navigator.wakeLock.request('screen');
      wakeLockRef.current.addEventListener('release', () => {
        wakeLockRef.current = null;
      });
    } catch (_err) {
      // Wake lock request can fail (e.g. power-saving mode, non-secure context); safe to ignore.
      wakeLockRef.current = null;
    }
  }, []);

  const releaseWakeLock = useCallback(async () => {
    if (!wakeLockRef.current) return;
    try { await wakeLockRef.current.release(); } catch (_err) { /* ignore release errors */ }
    wakeLockRef.current = null;
  }, []);

  /* ── Beat-light DOM helpers (imperative for animation performance) ── */

  const renderBeatDotsDOM = useCallback((numBeats) => {
    const container = beatDotsContainerRef.current;
    if (!container) return;
    container.innerHTML = '';
    beatDotRefsRef.current = [];
    for (let i = 0; i < numBeats; i++) {
      const dot = document.createElement('div');
      dot.className = 'beat-dot';
      dot.title = `Beat ${i + 1}`;
      container.appendChild(dot);
      beatDotRefsRef.current.push(dot);
    }
  }, []);

  const triggerBeatFlash = useCallback((beat, isAccent) => {
    if (beatTextRef.current) {
      beatTextRef.current.textContent = String(beat + 1);
    }
    beatDotRefsRef.current.forEach((dot, i) => {
      dot.classList.remove('lit-beat', 'lit-accent', 'lit-subdiv');
      if (i === beat) {
        dot.classList.add(isAccent ? 'lit-accent' : 'lit-beat');
        setTimeout(() => dot.classList.remove('lit-beat', 'lit-accent'), FLASH_MS);
      }
    });
  }, []);

  const triggerSubdivFlash = useCallback((beat) => {
    const dot = beatDotRefsRef.current[beat];
    if (!dot) return;
    dot.classList.add('lit-subdiv');
    setTimeout(() => dot.classList.remove('lit-subdiv'), FLASH_MS);
  }, []);

  const resetVisualsDOM = useCallback(() => {
    if (pendulumGroupRef.current) {
      pendulumGroupRef.current.setAttribute('transform', 'rotate(0, 100, 197)');
    }
    if (beatTextRef.current) {
      beatTextRef.current.textContent = '—';
    }
    beatDotRefsRef.current.forEach(d => d.classList.remove('lit-beat', 'lit-accent', 'lit-subdiv'));
  }, []);

  const positionWeightDOM = useCallback((t) => {
    if (!weightRef.current) return;
    // Map 20 BPM → y=90 (high, slower) … 400 BPM → y=175 (low, faster)
    const minY = 90, maxY = 175;
    const y = minY + ((t - 20) / (400 - 20)) * (maxY - minY);
    weightRef.current.setAttribute('y', y.toFixed(1));
  }, []);

  /* ── Lookahead scheduler ──────────────────────────────────────────── */

  // All refs — no dependency on props or state → stable across re-renders
  const scheduleBeats = useCallback(() => {
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    const t = tempoRef.current;
    const b = beatsRef.current;
    const s = subdivRef.current || 1;
    const beatDur   = 60 / t;
    const subdivDur = beatDur / s;

    while (nextBeatTimeRef.current < ctx.currentTime + LOOKAHEAD_TIME) {
      const isBeatStart  = currentSubdivRef.current === 0;
      const isAccentBeat = isBeatStart && currentBeatRef.current === 0;

      if (isBeatStart) {
        scheduleClick(nextBeatTimeRef.current, isAccentBeat ? 'accent' : 'beat');
      } else {
        scheduleClick(nextBeatTimeRef.current, 'subdiv');
      }

      visualQueueRef.current.push({
        audioTime: nextBeatTimeRef.current,
        beat:      currentBeatRef.current,
        isSubdiv:  !isBeatStart,
      });

      currentSubdivRef.current++;
      if (currentSubdivRef.current >= s) {
        currentSubdivRef.current = 0;
        currentBeatRef.current++;
        if (currentBeatRef.current >= b) {
          currentBeatRef.current = 0;
        }
      }
      nextBeatTimeRef.current += subdivDur;
    }
  }, [scheduleClick]);

  /* ── Animation loop ───────────────────────────────────────────────── */

  const animationLoop = useCallback(() => {
    if (!isPlayingRef.current || !audioCtxRef.current) return;
    const ctx = audioCtxRef.current;
    const now = ctx.currentTime;

    // Pendulum swing: sine oscillation — angle is 0 (bottom) at every beat boundary,
    // swings to right on odd intervals and left on even intervals.
    const elapsed = now - playStartTimeRef.current;
    const angle   = MAX_ANGLE * Math.sin(Math.PI * (elapsed / beatDurRef.current));
    if (pendulumGroupRef.current) {
      pendulumGroupRef.current.setAttribute('transform', `rotate(${angle}, 100, 197)`);
    }

    // Drain visual queue
    const queue = visualQueueRef.current;
    let   head  = visualQueueHeadRef.current;
    while (head < queue.length && queue[head].audioTime <= now + 0.018) {
      const evt = queue[head++];
      if (!evt.isSubdiv) {
        triggerBeatFlash(evt.beat, evt.beat === 0);
      } else {
        triggerSubdivFlash(evt.beat);
      }
    }
    visualQueueHeadRef.current = head;
    if (head >= VISUAL_QUEUE_TRIM_THRESHOLD) {
      visualQueueRef.current.splice(0, head);
      visualQueueHeadRef.current = 0;
    }

    animFrameRef.current = requestAnimationFrame(animationLoop);
  }, [triggerBeatFlash, triggerSubdivFlash]);

  /* ── Playback control (all read from refs → stable callbacks) ─────── */

  const stopEngine = useCallback(() => {
    clearInterval(schedulerTimerRef.current);
    schedulerTimerRef.current = null;
    cancelAnimationFrame(animFrameRef.current);
    animFrameRef.current = null;
    isPlayingRef.current          = false;
    isPausedRef.current           = false;
    pausedByVisibilityRef.current = false;
    visualQueueRef.current        = [];
    visualQueueHeadRef.current    = 0;
    releaseWakeLock();
    resetVisualsDOM();
    setIsPlaying(false);
    setIsPaused(false);
  }, [releaseWakeLock, resetVisualsDOM]);

  const pauseEngine = useCallback(() => {
    clearInterval(schedulerTimerRef.current);
    schedulerTimerRef.current = null;
    cancelAnimationFrame(animFrameRef.current);
    animFrameRef.current = null;
    isPlayingRef.current = false;
    isPausedRef.current  = true;
    if (audioCtxRef.current?.state === 'running') {
      audioCtxRef.current.suspend().catch(() => {
        // Ignore errors if the AudioContext is already closed or cannot be suspended.
      });
    }
    setIsPlaying(false);
    setIsPaused(true);
  }, []);

  const startEngine = useCallback(() => {
    // No-op if already playing — prevents duplicate scheduler/RAF loops.
    if (isPlayingRef.current) return;

    // Validate inputs before starting to avoid NaN durations and broken visuals.
    const t = tempoRef.current;
    const b = beatsRef.current;
    const s = subdivRef.current || 1;
    if (!Number.isFinite(t) || t < 20 || t > 400 ||
        !Number.isFinite(b) || b < 1  || b > 32  ||
        !Number.isFinite(s) || s < 1  || s > 8) {
      console.warn('[metronome] startEngine: invalid parameters', { tempo: t, beats: b, subdivision: s });
      return;
    }

    ensureAudioContext();
    const ctx = audioCtxRef.current;
    currentBeatRef.current     = 0;
    currentSubdivRef.current   = 0;
    beatDurRef.current         = 60 / t;
    nextBeatTimeRef.current    = ctx.currentTime + 0.05;
    playStartTimeRef.current   = nextBeatTimeRef.current;
    visualQueueRef.current     = [];
    visualQueueHeadRef.current = 0;
    isPlayingRef.current       = true;
    isPausedRef.current        = false;
    pausedByVisibilityRef.current = false;

    renderBeatDotsDOM(b);
    positionWeightDOM(t);

    schedulerTimerRef.current = setInterval(scheduleBeats, SCHEDULE_INTERVAL_MS);
    animFrameRef.current      = requestAnimationFrame(animationLoop);

    acquireWakeLock();
    setIsPlaying(true);
    setIsPaused(false);
  }, [
    ensureAudioContext, scheduleBeats, animationLoop,
    renderBeatDotsDOM, positionWeightDOM, acquireWakeLock,
  ]);

  /* ── Visual DOM updates when props change (and on first mount) ───────── */
  useEffect(() => { positionWeightDOM(tempo); }, [tempo, positionWeightDOM]);
  useEffect(() => { renderBeatDotsDOM(beats); }, [beats, renderBeatDotsDOM]);

  /* ── Page Visibility API: auto-pause / auto-resume ────────────────── */
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === 'hidden') {
        if (isPlayingRef.current) {
          pauseEngine();
          pausedByVisibilityRef.current = true;
        }
      } else {
        if (pausedByVisibilityRef.current && isPausedRef.current) {
          pausedByVisibilityRef.current = false;
          startEngine();
        }
        if (isPlayingRef.current || isPausedRef.current) {
          acquireWakeLock();
        }
      }
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, [pauseEngine, startEngine, acquireWakeLock]);

  /* ── Clean up on unmount ──────────────────────────────────────────── */
  useEffect(() => () => stopEngine(), [stopEngine]);

  /* ── Stable API object exposed to the custom element ─────────────── */
  const api = useMemo(() => ({
    play:  startEngine,
    stop:  stopEngine,
    pause: pauseEngine,
    get isPlaying() { return isPlayingRef.current; },
    get isPaused()  { return isPausedRef.current;  },
  }), [startEngine, stopEngine, pauseEngine]);

  // Register API with parent custom element synchronously on every render
  // (idempotent — the api object reference is stable)
  onApiReady?.(api);

  /* ── Play button handler ──────────────────────────────────────────── */
  const handlePlayClick = useCallback(() => {
    if (isPlaying) {
      pauseEngine();
    } else {
      ensureAudioContext();
      startEngine();
    }
  }, [isPlaying, pauseEngine, ensureAudioContext, startEngine]);

  /* ── Render ───────────────────────────────────────────────────────── */
  const canPlay = tempo >= 20 && beats >= 1;

  return html`
    <section id="metronome-visual">
      <svg id="pendulum-svg" viewBox="0 0 200 260" xmlns="http://www.w3.org/2000/svg"
           role="img" aria-label="Pendulum metronome">
        <g transform="translate(0,-50)">
          <!-- Metronome body (pyramid / trapezoid) -->
          <polygon points="58,295 142,295 124,148 76,148" fill="#1a1a38"/>
          <polygon points="60,293 140,293 122,150 78,150" fill="#22224a"/>

          <!-- Scale lines on the body -->
          <line x1="88" y1="173" x2="112" y2="173" stroke="#35356a" stroke-width="1.2"/>
          <line x1="90" y1="188" x2="110" y2="188" stroke="#35356a" stroke-width="1.2"/>
          <line x1="90" y1="203" x2="110" y2="203" stroke="#35356a" stroke-width="1.2"/>
          <line x1="90" y1="218" x2="110" y2="218" stroke="#35356a" stroke-width="1.2"/>
          <line x1="88" y1="233" x2="112" y2="233" stroke="#35356a" stroke-width="1.2"/>

          <!-- Body outline -->
          <polygon points="58,295 142,295 124,148 76,148" fill="none" stroke="#3a3a72" stroke-width="1.5"/>

          <!-- Beat counter text -->
          <text ref=${beatTextRef} x="100" y="252" text-anchor="middle"
                fill="#7070a0" font-size="20" font-family="monospace" font-weight="bold">—</text>

          <!-- Pendulum group — rotated directly via DOM ref for smooth 60fps -->
          <g ref=${pendulumGroupRef}>
            <!-- Rod -->
            <line x1="100" y1="60" x2="100" y2="287"
                  stroke="#c0c0de" stroke-width="2.2" stroke-linecap="round"/>
            <!-- Tempo weight -->
            <rect ref=${weightRef} x="93" y="132" width="14" height="11" rx="3" fill="#6060c0"/>
            <!-- Bob -->
            <circle cx="100" cy="283" r="11" fill="#4a9eff"/>
          </g>

          <!-- Pivot pin (drawn last so it sits on top of the rod) -->
          <circle cx="100" cy="197" r="5"   fill="#666"/>
          <circle cx="100" cy="197" r="2.5" fill="#ccc"/>
        </g>
      </svg>

      <!-- Beat indicator dots -->
      <div ref=${beatDotsContainerRef} id="beat-lights-row"
           aria-live="polite" aria-label="Beat indicator"></div>
    </section>

    <section id="controls">
      <button
        id="play-btn"
        class="ctrl-btn play-btn"
        title=${isPlaying ? 'Pause' : isPaused ? 'Restart' : 'Play'}
        aria-label=${isPlaying ? 'Pause' : isPaused ? 'Restart' : 'Play'}
        disabled=${!canPlay}
        onClick=${handlePlayClick}
      >${isPlaying ? '⏸ Pause' : isPaused ? '▶ Restart' : '▶ Play'}</button>

      <button
        id="stop-btn"
        class="ctrl-btn stop-btn"
        title="Stop" aria-label="Stop"
        disabled=${!isPlaying && !isPaused}
        onClick=${stopEngine}
      >⏹ Stop</button>

      <span class="ctrl-sep"></span>

      <button
        id="sound-btn"
        class=${'ctrl-btn sound-btn ' + (soundEnabled ? 'sound-on' : 'sound-off')}
        title=${soundEnabled ? 'Sound on — click to mute' : 'Sound off — click to unmute'}
        aria-label=${soundEnabled ? 'Sound on — click to mute' : 'Sound off — click to unmute'}
        aria-pressed=${String(soundEnabled)}
        onClick=${() => setSoundEnabled(v => !v)}
      >${soundEnabled ? '🔊' : '🔇'}</button>
    </section>
  `;
}

/* ══════════════════════════════════════════════════════════════════════
   MetronomePlayerElement — Custom element wrapper (via preactComponent)
   ══════════════════════════════════════════════════════════════════════ */

// Create the base class (connectedCallback / disconnectedCallback / setProp /
// _render all provided by the utility) but defer registration so we can
// subclass before calling customElements.define().
const _MetronomePlayerBase = preactComponent(MetronomePlayer, { define: false });

class MetronomePlayerElement extends _MetronomePlayerBase {
  /** @type {{ play:()=>void, stop:()=>void, pause:()=>void, isPlaying:boolean, isPaused:boolean }|null} */
  #api = null;

  constructor() {
    super();
    // Seed default props and wire the API callback once.
    this._props.tempo       = 100;
    this._props.beats       = 4;
    this._props.subdivision = 1;
    this._props.onApiReady  = (api) => { this.#api = api; };
  }

  /* ── Settable properties ────────────────────────────────────────── */

  get tempo()          { return this._props.tempo; }
  set tempo(val)       { this.setProp('tempo', Number(val)); }

  get beats()          { return this._props.beats; }
  set beats(val)       { this.setProp('beats', Number(val)); }

  get subdivision()    { return this._props.subdivision; }
  set subdivision(val) { this.setProp('subdivision', Number(val)); }

  /* ── Control methods ────────────────────────────────────────────── */

  play()  { this.#api?.play(); }
  pause() { this.#api?.pause(); }
  stop()  { this.#api?.stop(); }

  /* ── Declarative playback state ─────────────────────────────────── */

  /** @returns {'playing'|'paused'|'stopped'} */
  get playbackState() {
    if (this.#api?.isPlaying) return 'playing';
    if (this.#api?.isPaused)  return 'paused';
    return 'stopped';
  }

  /** @param {'playing'|'paused'|'stopped'} val */
  set playbackState(val) {
    if      (val === 'playing') this.play();
    else if (val === 'paused')  this.pause();
    else                        this.stop();
  }

  /* ── Read-only state ────────────────────────────────────────────── */

  get isPlaying() { return this.#api?.isPlaying ?? false; }
  get isPaused()  { return this.#api?.isPaused  ?? false; }
}

customElements.define('metronome-player', MetronomePlayerElement);
