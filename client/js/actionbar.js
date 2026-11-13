import { el, button, fmtChips } from './hud.js';

const PRESETS = [
  { label: '½ pot', f: 0.5 },
  { label: '¾ pot', f: 0.75 },
  { label: 'Pot', f: 1 },
];
const WARN_MS = 5000;

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/**
 * Slider positions: 0 = min, last = max, and every big-blind multiple strictly between them, so both
 * ends are exact while the middle snaps to whole big blinds.
 */
function makeScale(min, max, bb) {
  const step = Math.max(1, bb);
  const first = (Math.floor(min / step) + 1) * step;
  const last = (Math.ceil(max / step) - 1) * step;
  const inner = last >= first ? (last - first) / step + 1 : 0;
  const count = max > min ? inner + 2 : 1;
  return {
    count,
    valueAt(i) {
      if (i <= 0) return min;
      if (i >= count - 1) return max;
      return first + (i - 1) * step;
    },
    indexOf(v) {
      if (v <= min) return 0;
      if (v >= max) return count - 1;
      if (!inner) return v - min < max - v ? 0 : 1;
      return clamp(Math.round((v - first) / step) + 1, 1, count - 2);
    },
  };
}

/**
 * @param {HTMLElement} root
 * @param {{onAction:(a:{type:'fold'|'check'|'call'|'raiseTo', amount?:number})=>void}} handlers
 */
export function createActionBar(root, { onAction }) {
  root.classList.add('actionbar', 'is-hidden');
  root.replaceChildren();
  root.setAttribute('role', 'toolbar');
  root.setAttribute('aria-label', 'Your action');

  const timer = el('div', 'ab-timer');
  const timerFill = el('i');
  timer.append(timerFill);

  const panel = el('div', 'ab-panel');
  const amountRow = el('div', 'ab-amount-row');
  const amountLabel = el('span', 'ab-amount-label');
  const amountInput = el('input', 'ab-amount');
  Object.assign(amountInput, { type: 'text', inputMode: 'numeric', autocomplete: 'off', spellcheck: false });
  amountInput.setAttribute('aria-label', 'Raise amount');
  amountInput.setAttribute('enterkeyhint', 'done');
  amountRow.append(amountLabel, amountInput);

  const presetsRow = el('div', 'ab-presets');
  const presetBtns = [
    { label: 'Min', value: () => cur.legal.raise.min },
    ...PRESETS.map((p) => ({ label: p.label, value: () => potFraction(p.f) })),
    { label: 'All-in', value: () => cur.legal.raise.max },
  ].map((p) => {
    p.btn = button('chip-btn', p.label, () => setAmount(p.value()));
    presetsRow.append(p.btn);
    return p;
  });

  const sliderRow = el('div', 'ab-slider-row');
  const minus = button('step-btn', '−', () => nudge(-1));
  const plus = button('step-btn', '+', () => nudge(1));
  minus.setAttribute('aria-label', 'Decrease by one big blind');
  plus.setAttribute('aria-label', 'Increase by one big blind');
  const slider = el('input', 'ab-slider');
  slider.type = 'range';
  slider.step = '1';
  slider.setAttribute('aria-label', 'Raise amount');
  sliderRow.append(minus, slider, plus);
  panel.append(amountRow, presetsRow, sliderRow);

  const row = el('div', 'ab-row');
  const foldBtn = button('act-btn act-fold', 'Fold', () => emit({ type: 'fold' }));
  const callBtn = button('act-btn act-call', '', () => emit(cur.legal.check ? { type: 'check' } : { type: 'call' }));
  const raiseBtn = button('act-btn act-raise', '', () => openPanel(true));
  const backBtn = button('act-btn act-back', 'Back', () => openPanel(false));
  const confirmBtn = button('act-btn act-confirm', '', () => confirmRaise());
  foldBtn.dataset.key = 'F';
  callBtn.dataset.key = 'C';
  raiseBtn.dataset.key = 'R';
  row.append(foldBtn, callBtn, raiseBtn, backBtn, confirmBtn);
  root.append(timer, panel, row);

  let cur = null;
  let curKey = null;
  let scale = null;
  let amount = 0;
  let panelOpen = false;
  let busy = false;
  let visible = false;

  const ro = new ResizeObserver(() => publishHeight());
  ro.observe(root);
  function publishHeight() {
    const h = visible ? root.offsetHeight : 0;
    document.documentElement.style.setProperty('--actionbar-h', `${h}px`);
  }

  function toCall() {
    return Math.max(0, cur.hand.currentBet - cur.streetBet);
  }

  function potFraction(f) {
    return Math.round(cur.hand.currentBet + f * (cur.hand.potTotal + toCall()));
  }

  function verb(v) {
    const r = cur.legal.raise;
    if (v === r.max) return 'All-in';
    return cur.hand.currentBet === 0 ? 'Bet' : 'Raise to';
  }

  function setAmount(v, fromSlider) {
    const r = cur.legal.raise;
    amount = clamp(Math.round(Number.isFinite(v) ? v : r.min), r.min, r.max);
    const idx = scale.indexOf(amount);
    if (!fromSlider) slider.value = String(idx);
    const pct = scale.count > 1 ? (idx / (scale.count - 1)) * 100 : 100;
    slider.style.setProperty('--pct', `${pct}%`);
    if (document.activeElement !== amountInput) amountInput.value = fmtChips(amount);
    amountLabel.textContent = verb(amount);
    confirmBtn.textContent = `${verb(amount)} ${fmtChips(amount)}`;
    confirmBtn.classList.toggle('is-allin', amount === r.max);
    for (const p of presetBtns) p.btn.classList.toggle('is-active', !p.btn.hidden && p.value() === amount);
    minus.disabled = busy || amount <= r.min;
    plus.disabled = busy || amount >= r.max;
  }

  function nudge(dir) {
    if (!cur?.legal.raise) return;
    setAmount(amount + dir * Math.max(1, cur.bigBlind));
  }

  function openPanel(open) {
    if (open && (!cur?.legal.raise || busy)) return;
    panelOpen = open;
    root.classList.toggle('is-raising', open);
    if (open) {
      // A rotated table would get the soft keyboard sideways; slider and presets still set the amount.
      const rotated = document.documentElement.hasAttribute('data-rotated');
      amountInput.readOnly = rotated;
      amountInput.inputMode = rotated ? 'none' : 'numeric';
      amountInput.tabIndex = rotated ? -1 : 0;
      amountInput.style.pointerEvents = rotated ? 'none' : '';
      setAmount(cur.legal.raise.min === cur.legal.raise.max ? cur.legal.raise.max : amount);
    }
    // A button focused by an earlier tap would otherwise swallow Enter and fire itself (e.g. Call).
    if (open && root.contains(document.activeElement)) confirmBtn.focus({ preventScroll: true });
  }

  function confirmRaise() {
    if (!panelOpen) return;
    commitTyped();
    emit({ type: 'raiseTo', amount });
  }

  function commitTyped() {
    if (amountInput.readOnly) return;
    const typed = parseInt(amountInput.value.replace(/[^0-9]/g, ''), 10);
    if (Number.isFinite(typed) && typed !== amount) setAmount(typed);
  }

  function setBusy(b) {
    busy = b;
    root.classList.toggle('is-busy', b);
    for (const node of root.querySelectorAll('button, input')) node.disabled = b;
  }

  function emit(action) {
    if (busy || !visible) return;
    setBusy(true);
    onAction(action);
  }

  slider.addEventListener('input', () => setAmount(scale.valueAt(Number(slider.value)), true));
  amountInput.addEventListener('focus', () => {
    amountInput.value = String(amount);
    amountInput.select();
  });
  amountInput.addEventListener('input', () => {
    const digits = amountInput.value.replace(/[^0-9]/g, '');
    if (digits !== amountInput.value) amountInput.value = digits;
  });
  amountInput.addEventListener('blur', () => {
    commitTyped();
    amountInput.value = fmtChips(amount);
  });
  amountInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      amountInput.blur();
    }
  });

  function onKey(e) {
    if (!visible || busy || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t instanceof Element && t !== slider && t.closest('input, textarea, select, [contenteditable="true"]')) return;
    const k = e.key.toLowerCase();
    if (k === 'f') { e.preventDefault(); emit({ type: 'fold' }); }
    else if (k === 'c') { e.preventDefault(); callBtn.click(); }
    else if (k === 'r') { e.preventDefault(); openPanel(true); }
    else if (k === 'escape' && panelOpen) { e.preventDefault(); openPanel(false); }
    else if (k === 'enter' && panelOpen && !(t instanceof HTMLButtonElement)) { e.preventDefault(); confirmRaise(); }
    else if (panelOpen && (k === 'arrowup' || k === 'arrowdown') && t !== slider) { e.preventDefault(); nudge(k === 'arrowup' ? 1 : -1); }
  }
  window.addEventListener('keydown', onKey);

  /**
   * Idempotent: calling again with the same turn keeps the panel, amount and the post-tap lock.
   * @param {{legal:{check:boolean, call:number, raise:null|{min:number,max:number}},
   *          hand:{handId:number, turnId:number, currentBet:number, potTotal:number, turnMs?:number},
   *          stack:number, streetBet:number, bigBlind:number}} args
   */
  function show(args) {
    const { legal, hand, stack, streetBet } = args;
    const key = JSON.stringify([hand.handId, hand.turnId, hand.currentBet, hand.potTotal, legal, stack, streetBet]);
    if (visible && key === curKey) return;
    curKey = key;
    cur = args;
    visible = true;
    setBusy(false);
    openPanel(false);
    root.classList.remove('is-hidden');

    if (legal.check) {
      callBtn.textContent = 'Check';
      callBtn.classList.remove('is-allin');
    } else {
      const allIn = legal.call >= stack;
      callBtn.textContent = `${allIn ? 'All-in' : 'Call'} ${fmtChips(legal.call)}`;
      callBtn.classList.toggle('is-allin', allIn);
    }

    const r = legal.raise;
    raiseBtn.hidden = !r;
    root.classList.toggle('no-raise', !r);
    if (r) {
      scale = makeScale(r.min, r.max, args.bigBlind);
      slider.min = '0';
      slider.max = String(scale.count - 1);
      sliderRow.hidden = scale.count < 2;
      presetsRow.hidden = scale.count < 2;
      raiseBtn.textContent = r.min === r.max ? 'All-in' : hand.currentBet === 0 ? 'Bet' : 'Raise';
      for (const p of presetBtns) {
        const v = p.value();
        const isEdge = p.label === 'Min' || p.label === 'All-in';
        p.btn.hidden = isEdge ? (p.label === 'Min' && r.min === r.max) : v < r.min || v >= r.max;
      }
      amount = r.min;
      setAmount(r.min);
    }
    publishHeight();
  }

  function hide() {
    visible = false;
    curKey = null;
    openPanel(false);
    setBusy(false);
    root.classList.add('is-hidden');
    setTimeLeft(null);
    publishHeight();
  }

  function setTimeLeft(ms) {
    if (ms == null || !cur?.hand?.turnMs) {
      timer.classList.remove('is-on', 'is-warn');
      return;
    }
    const frac = clamp(ms / cur.hand.turnMs, 0, 1);
    timer.classList.add('is-on');
    timer.classList.toggle('is-warn', ms <= WARN_MS);
    timerFill.style.transform = `scaleX(${frac})`;
  }

  function destroy() {
    window.removeEventListener('keydown', onKey);
    ro.disconnect();
    root.replaceChildren();
  }

  return { show, hide, setTimeLeft, destroy };
}
