const COARSE = '(pointer: coarse)';
const PORTRAIT = '(orientation: portrait)';

let root = null;
let rotated = false;
let forced = null;
let pending = false;
const listeners = new Set();

const TEXT_TYPES = new Set(['text', 'search', 'tel', 'url', 'email', 'number', 'password']);

// Only a field that brings up the soft keyboard: its resize can make an upright phone look landscape.
function isTextField(el) {
  if (!el || !el.isConnected || el.disabled || el.readOnly) return false;
  if (el.tagName === 'INPUT') return TEXT_TYPES.has(el.type);
  return el.tagName === 'TEXTAREA' || el.isContentEditable;
}

function want() {
  if (forced !== null) return forced;
  return matchMedia(COARSE).matches && matchMedia(PORTRAIT).matches;
}

function apply(next) {
  if (next === rotated) return;
  rotated = next;
  document.documentElement.toggleAttribute('data-rotated', rotated);
  for (const cb of [...listeners]) cb(rotated);
}

function evaluate() {
  if (isTextField(document.activeElement)) {
    pending = true;
    return;
  }
  pending = false;
  apply(want());
}

// The keyboard is still up when focus leaves, so the viewport is re-read once it has closed.
function onFocusOut() {
  if (pending) setTimeout(evaluate, 350);
}

function watch(query) {
  const mq = matchMedia(query);
  if (mq.addEventListener) mq.addEventListener('change', evaluate);
  else mq.addListener(evaluate);
}

export function init(el, { force: f } = {}) {
  const first = !root;
  root = el;
  if (first) {
    const q = new URLSearchParams(location.search).get('rotate');
    if (q === '1' || q === '0') forced = q === '1';
    addEventListener('resize', evaluate);
    addEventListener('orientationchange', evaluate);
    document.addEventListener('focusout', onFocusOut);
    watch(COARSE);
    watch(PORTRAIT);
    document.documentElement.toggleAttribute('data-rotated', false);
  }
  if (f !== undefined) forced = f;
  apply(want());
}

export const isRotated = () => rotated;

/** Re-read the orientation, e.g. after the focused field was removed without a focusout. */
export const check = evaluate;

export function size() {
  return root ? { w: root.clientWidth, h: root.clientHeight } : { w: 0, h: 0 };
}

// Rotated, logical (x, y) sits at client (box.left + y, box.bottom - x): logical x runs up the screen, y runs right.
export function toLogical(clientX, clientY) {
  const { w, h } = size();
  const b = root?.getBoundingClientRect();
  if (!b || !b.width || !b.height) return { x: 0, y: 0 };
  if (!rotated) return { x: (clientX - b.left) * w / b.width, y: (clientY - b.top) * h / b.height };
  return { x: (b.bottom - clientY) * w / b.height, y: (clientX - b.left) * h / b.width };
}

export function toClient(x, y) {
  const { w, h } = size();
  const b = root?.getBoundingClientRect();
  if (!b || !w || !h) return { x: 0, y: 0 };
  if (!rotated) return { x: b.left + x * b.width / w, y: b.top + y * b.height / h };
  return { x: b.left + y * b.width / h, y: b.bottom - x * b.height / w };
}

export function rect(el) {
  const r = el.getBoundingClientRect();
  const a = toLogical(r.left, r.top);
  const c = toLogical(r.right, r.bottom);
  return { l: Math.min(a.x, c.x), t: Math.min(a.y, c.y), r: Math.max(a.x, c.x), b: Math.max(a.y, c.y) };
}

export function force(v) {
  forced = v === null ? null : !!v;
  pending = false;
  apply(want());
}

export function onChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
