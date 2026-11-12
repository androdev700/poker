// Every sound is synthesized with WebAudio. Synth functions take (ctx, dest, t, opts) and return
// their end time, so they render the same into a live AudioContext or an OfflineAudioContext.

const MUTE_KEY = 'poker:muted';
const SILENT = 0.0001;

let ctx = null;
let master = null;
let muted = readMuted();
let autoUnlockInstalled = false;
let gestureArmed = false;

const noiseBuffers = new WeakMap();

function readMuted() {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function noiseBuffer(ac) {
  let buf = noiseBuffers.get(ac);
  if (!buf) {
    buf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    noiseBuffers.set(ac, buf);
  }
  return buf;
}

function envelope(ac, dest, t, peak, attack, decay) {
  const g = ac.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(SILENT, t + attack + decay);
  g.connect(dest);
  return g;
}

function tone(ac, dest, { t, freq, to, glide, type = 'sine', peak, attack = 0.004, decay }) {
  const end = t + attack + decay;
  const osc = ac.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, t + (glide ?? attack + decay));
  osc.connect(envelope(ac, dest, t, peak, attack, decay));
  osc.start(t);
  osc.stop(end + 0.02);
  return end;
}

function noise(ac, dest, { t, peak, attack = 0.003, decay, filter = 'bandpass', freq, to, glide, q = 1 }) {
  const end = t + attack + decay;
  const src = ac.createBufferSource();
  src.buffer = noiseBuffer(ac);
  const bq = ac.createBiquadFilter();
  bq.type = filter;
  bq.Q.value = q;
  bq.frequency.setValueAtTime(freq, t);
  if (to) bq.frequency.exponentialRampToValueAtTime(to, t + (glide ?? attack + decay));
  src.connect(bq);
  bq.connect(envelope(ac, dest, t, peak, attack, decay));
  src.start(t, rand(0, 0.7));
  src.stop(end + 0.02);
  return end;
}

function chipClack(ac, dest, t, peak) {
  const f = rand(2500, 4500);
  const decay = rand(0.035, 0.06);
  tone(ac, dest, { t, freq: f, peak, attack: 0.001, decay });
  tone(ac, dest, { t, freq: f * rand(1.43, 1.52), peak: peak * 0.5, attack: 0.001, decay: decay * 0.7 });
  noise(ac, dest, { t, peak: peak * 0.6, attack: 0.001, decay: 0.012, filter: 'highpass', freq: 3000, q: 0.7 });
  return t + decay + 0.001;
}

function chipRun(ac, dest, t, count, peak) {
  let at = t;
  let end = t;
  for (let i = 0; i < count; i++) {
    end = Math.max(end, chipClack(ac, dest, at, peak * rand(0.75, 1)));
    at += rand(0.03, 0.065);
  }
  return end;
}

function bellNote(ac, dest, t, freq, peak, decay) {
  // Inharmonic upper partials decaying faster than the fundamental read as a bell.
  tone(ac, dest, { t, freq, peak, attack: 0.005, decay });
  tone(ac, dest, { t, freq: freq * 2.0, peak: peak * 0.35, attack: 0.004, decay: decay * 0.5 });
  tone(ac, dest, { t, freq: freq * 2.76, peak: peak * 0.15, attack: 0.003, decay: decay * 0.3 });
  return t + 0.005 + decay;
}

function knock(ac, dest, t, peak) {
  tone(ac, dest, { t, freq: 140, to: 80, glide: 0.08, peak, attack: 0.003, decay: 0.11 });
  noise(ac, dest, { t, peak: peak * 0.5, attack: 0.002, decay: 0.05, filter: 'lowpass', freq: 700, q: 0.7 });
  return t + 0.113;
}

const SYNTHS = {
  deal(ac, dest, t) {
    const f = 2400 * rand(0.85, 1.15);
    return noise(ac, dest, { t, peak: 0.35, attack: 0.008, decay: 0.052, freq: f, to: f * 0.6, q: 1.2 });
  },

  flip(ac, dest, t) {
    noise(ac, dest, { t, peak: 0.4, attack: 0.002, decay: 0.025, freq: 3200, q: 1.8 });
    return noise(ac, dest, { t: t + 0.045, peak: 0.3, attack: 0.002, decay: 0.03, freq: 2400, q: 1.5 });
  },

  chips(ac, dest, t, opts = {}) {
    const n = opts.count != null ? Math.max(2, Math.min(8, Math.round(opts.count))) : 3 + Math.floor(rand(0, 3));
    return chipRun(ac, dest, t, n, 0.12);
  },

  check(ac, dest, t) {
    knock(ac, dest, t, 0.55);
    return knock(ac, dest, t + 0.11, 0.42);
  },

  fold(ac, dest, t) {
    return noise(ac, dest, { t, peak: 0.28, attack: 0.025, decay: 0.155, freq: 1800, to: 450, q: 0.8 });
  },

  win(ac, dest, t) {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    let end = t;
    notes.forEach((freq, i) => {
      const last = i === notes.length - 1;
      end = Math.max(end, tone(ac, dest, { t: t + i * 0.09, freq, type: 'triangle', peak: 0.2, attack: 0.005, decay: last ? 0.7 : 0.3 }));
    });
    return Math.max(end, chipRun(ac, dest, t + 0.32, 7, 0.1));
  },

  yourTurn(ac, dest, t) {
    bellNote(ac, dest, t, 880, 0.5, 0.45);
    return bellNote(ac, dest, t + 0.16, 1318.5, 0.5, 0.8);
  },

  tick(ac, dest, t) {
    noise(ac, dest, { t, peak: 0.06, attack: 0.001, decay: 0.012, filter: 'highpass', freq: 3500, q: 0.7 });
    return tone(ac, dest, { t, freq: 1250, peak: 0.1, attack: 0.001, decay: 0.03 });
  },

  tickUrgent(ac, dest, t) {
    noise(ac, dest, { t, peak: 0.08, attack: 0.001, decay: 0.012, filter: 'highpass', freq: 4000, q: 0.7 });
    return tone(ac, dest, { t, freq: 1650, peak: 0.14, attack: 0.001, decay: 0.035 });
  },

  allIn(ac, dest, t) {
    noise(ac, dest, { t, peak: 0.3, attack: 0.36, decay: 0.08, freq: 300, to: 3200, glide: 0.42, q: 1.4 });
    tone(ac, dest, { t, freq: 90, to: 180, glide: 0.4, type: 'triangle', peak: 0.12, attack: 0.3, decay: 0.1 });
    return tone(ac, dest, { t: t + 0.42, freq: 115, to: 45, glide: 0.3, peak: 0.55, attack: 0.004, decay: 0.38 });
  },

  bust(ac, dest, t) {
    const notes = [392.0, 311.13, 261.63];
    let end = t;
    notes.forEach((freq, i) => {
      const last = i === notes.length - 1;
      end = tone(ac, dest, { t: t + i * 0.17, freq, type: 'triangle', peak: 0.22, attack: 0.008, decay: last ? 0.6 : 0.25 });
    });
    return end;
  },

  join(ac, dest, t) {
    return tone(ac, dest, { t, freq: 420, to: 760, glide: 0.035, peak: 0.22, attack: 0.003, decay: 0.07 });
  },
};

export const SOUND_NAMES = Object.keys(SYNTHS);

export function synth(ac, dest, name, t, opts) {
  const fn = SYNTHS[name];
  if (!fn) throw new Error(`unknown sound: ${name}`);
  return fn(ac, dest, t, opts);
}

export function createOutput(ac) {
  const gain = ac.createGain();
  gain.gain.value = 0.8;
  const comp = ac.createDynamicsCompressor();
  comp.threshold.value = -10;
  comp.knee.value = 10;
  comp.ratio.value = 4;
  comp.attack.value = 0.003;
  comp.release.value = 0.15;
  gain.connect(comp);
  comp.connect(ac.destination);
  return gain;
}

function ensureContext() {
  if (ctx) return ctx;
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = createOutput(ctx);
  if (muted) master.gain.value = 0;
  noiseBuffer(ctx);
  return ctx;
}

export function isRunning() {
  return !!ctx && ctx.state === 'running';
}

export function isMuted() {
  return muted;
}

export function setMuted(value) {
  muted = !!value;
  try {
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch {}
  if (ctx && master) master.gain.setTargetAtTime(muted ? 0 : 0.8, ctx.currentTime, 0.02);
}

export function play(name, opts = {}) {
  if (muted) return;
  // Chrome logs an intervention error for vibrate() before the first user gesture.
  if (name === 'yourTurn' && navigator.userActivation?.hasBeenActive !== false) navigator.vibrate?.(80);
  if (!isRunning()) return;
  try {
    synth(ctx, master, name, ctx.currentTime + 0.005 + (opts.delay ?? 0), opts);
  } catch (err) {
    console.warn('sound:', err);
  }
}

export async function unlock() {
  const ac = ensureContext();
  if (!ac) return false;
  // iOS only unlocks output once a buffer has started inside a user gesture.
  try {
    const src = ac.createBufferSource();
    src.buffer = ac.createBuffer(1, 1, ac.sampleRate);
    src.connect(ac.destination);
    src.start(0);
  } catch {}
  if (ac.state !== 'running') {
    try {
      await ac.resume();
    } catch {}
  }
  return isRunning();
}

const GESTURES = ['pointerdown', 'keydown', 'touchend'];

function onGesture() {
  unlock().then((running) => {
    if (running) disarm();
  });
}

function arm() {
  if (gestureArmed) return;
  gestureArmed = true;
  for (const type of GESTURES) addEventListener(type, onGesture, { capture: true, passive: true });
}

function disarm() {
  if (!gestureArmed) return;
  gestureArmed = false;
  for (const type of GESTURES) removeEventListener(type, onGesture, { capture: true });
}

function onVisibility() {
  if (document.visibilityState !== 'visible' || !ctx || ctx.state === 'running') return;
  // iOS can leave the context "interrupted"; resume may need a fresh gesture, so re-arm on failure.
  ctx.resume().catch(() => {}).then(() => {
    if (!isRunning()) arm();
  });
}

export function installAutoUnlock() {
  if (autoUnlockInstalled) return;
  autoUnlockInstalled = true;
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
  } catch {}
  arm();
  document.addEventListener('visibilitychange', onVisibility);
}
