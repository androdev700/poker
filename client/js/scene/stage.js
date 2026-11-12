import * as THREE from 'three';
import { DEAL_CARD_MS } from '/shared/timing.js';
import { Tweener, ease, lerp } from './tween.js';
import {
  CARD,
  SEATS,
  makeLayout,
  viewIndex,
  plateSpot,
  betSpot,
  chipSourceSpot,
  buttonSpot,
  holePose,
  boardPose,
  potSpot,
  deckPose,
  muckSpot,
} from './layout.js';
import { createTable } from './table.js';
import { createCardKit, Card } from './cards.js';
import { createChipKit, Pile } from './chips.js';

const FLIP_DOWN = Math.PI;
const HIGHLIGHT_LIFT = 0.08;

function makeButtonMesh() {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  g.fillStyle = '#f7f5ef';
  g.fillRect(0, 0, S, S);
  g.strokeStyle = '#c9c3b4';
  g.lineWidth = 8;
  g.beginPath();
  g.arc(S / 2, S / 2, S * 0.4, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = '#1b1c20';
  g.font = '800 150px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('D', S / 2, S / 2 + 8);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const side = new THREE.MeshStandardMaterial({ color: 0xe9e6de, roughness: 0.35 });
  const top = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.35 });
  const geo = new THREE.CylinderGeometry(0.22, 0.22, 0.06, 40);
  const mesh = new THREE.Mesh(geo, [side, top, side]);
  mesh.position.y = 0.03;
  mesh.rotation.y = Math.PI / 2;
  mesh.castShadow = true;
  const root = new THREE.Group();
  root.add(mesh);
  root.userData.dispose = () => {
    geo.dispose();
    tex.dispose();
    side.dispose();
    top.dispose();
  };
  return root;
}

export function createStage(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const BG = 0x07080b;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BG);
  scene.fog = new THREE.Fog(BG, 20, 60);

  const camera = new THREE.PerspectiveCamera(36, 1, 0.5, 200);

  const spot = new THREE.SpotLight(0xffe0b5, 3.6, 0, 0.6, 0.55, 0);
  spot.castShadow = true;
  spot.shadow.bias = -0.0004;
  spot.shadow.normalBias = 0.015;
  spot.shadow.radius = 3;
  spot.shadow.camera.near = 4;
  spot.shadow.camera.far = 24;
  scene.add(spot, spot.target);
  const hemi = new THREE.HemisphereLight(0xc4d2e6, 0x2a1b10, 1.1);
  scene.add(hemi);
  const rim = new THREE.DirectionalLight(0x9db9ff, 0.7);
  rim.position.set(0, 4, -12);
  scene.add(rim);

  const table = createTable(renderer);
  scene.add(table.group);
  const cardKit = createCardKit(renderer);
  const chipKit = createChipKit(renderer);
  const deck = cardKit.createDeck();
  scene.add(deck);
  const button = makeButtonMesh();
  button.visible = false;
  scene.add(button);
  const dyn = new THREE.Group();
  scene.add(dyn);

  const tw = new Tweener();
  const st = {
    mySeat: 0,
    heroSeat: -1,
    unit: 1,
    buttonSeat: null,
    handId: null,
    holes: new Map(),
    board: [],
    bets: new Map(),
    pots: [],
    doomed: new Set(),
    highlight: null,
  };
  let L = null;
  let cssW = 0;
  let cssH = 0;
  let dirty = true;
  let raf = 0;
  let last = performance.now();
  let disposed = false;
  const layoutCbs = new Set();
  const tmp = new THREE.Vector3();

  const v = (seat) => viewIndex(seat, st.mySeat);
  const isHero = (seat) => seat === st.heroSeat && v(seat) === 0;
  const holeSlot = (seat, i, card) => holePose(L, v(seat), i, card.faceUp, card.faceUp && isHero(seat));
  const alive = (gen) => gen === tw.generation && !disposed;

  function newCard() {
    const c = new Card(cardKit);
    dyn.add(c.root);
    return c;
  }

  function newPile() {
    const p = new Pile(chipKit);
    dyn.add(p.group);
    return p;
  }

  function readPose(card) {
    const r = card.root;
    return {
      x: r.position.x,
      y: r.position.y - card.lift,
      z: r.position.z,
      yaw: r.rotation.y,
      tilt: r.rotation.x + Math.PI / 2,
      scale: r.scale.x,
    };
  }

  function flipLift(scale) {
    return (CARD.w * scale) / 2 + 0.04;
  }

  /** Tween a card between poses; `arc` lifts it mid-way, `spin` adds yaw at the start, flip* turns it over. */
  function fly(card, from, to, ms, opt = {}) {
    const { delay = 0, arc = 0, spin = 0, flipFrom, flipTo, easing = ease.inOutQuad, hideAtEnd = false } = opt;
    const flipping = flipFrom !== undefined && flipFrom !== flipTo;
    const lift = flipping ? Math.max(arc, flipLift(Math.max(from.scale, to.scale))) : arc;
    const r = card.root;
    return tw.run(
      ms,
      (k) => {
        r.visible = !(hideAtEnd && k >= 1);
        r.position.set(
          lerp(from.x, to.x, k),
          lerp(from.y, to.y, k) + lift * Math.sin(Math.PI * k) + card.lift,
          lerp(from.z, to.z, k)
        );
        r.rotation.set(-Math.PI / 2 + lerp(from.tilt, to.tilt, k), lerp(from.yaw + spin, to.yaw, k), 0);
        r.scale.setScalar(lerp(from.scale, to.scale, k));
        if (flipping) card.mesh.rotation.y = lerp(flipFrom, flipTo, k);
      },
      easing,
      delay
    );
  }

  function slidePile(pile, from, to, ms, opt = {}) {
    const { delay = 0, arc = 0.2, scaleTo = 1, easing = ease.inOutCubic } = opt;
    const g = pile.group;
    return tw.run(
      ms,
      (k) => {
        g.visible = true;
        g.position.set(lerp(from.x, to.x, k), arc * Math.sin(Math.PI * k), lerp(from.z, to.z, k));
        g.scale.setScalar(lerp(1, scaleTo, k));
      },
      easing,
      delay
    );
  }

  function allCards() {
    const out = [];
    for (const cards of st.holes.values()) out.push(...cards);
    out.push(...st.board);
    return out;
  }

  function targetTone(card) {
    if (!st.highlight) return 0;
    return card.faceUp && st.highlight.has(card.code) ? 1 : -1;
  }

  function placeButton() {
    if (st.buttonSeat == null) {
      button.visible = false;
      return;
    }
    const b = buttonSpot(L, v(st.buttonSeat));
    button.visible = true;
    button.position.set(b.x, 0, b.z);
  }

  function placePots() {
    const n = st.pots.length;
    st.pots.forEach((p, i) => {
      const s = potSpot(L, i, n);
      p.setAmount(p.amount, st.unit);
      p.group.position.set(s.x, 0, s.z);
      p.group.scale.setScalar(1);
      p.group.visible = true;
    });
  }

  function placeAll() {
    for (const d of st.doomed) d.dispose();
    st.doomed.clear();
    if (!L) return;
    for (const c of allCards()) {
      const tone = targetTone(c);
      c.setTone(tone);
      c.lift = tone === 1 ? HIGHLIGHT_LIFT : 0;
    }
    for (const [seat, cards] of st.holes) {
      cards.forEach((c, i) => {
        c.root.visible = true;
        c.setFaceUp(c.faceUp);
        c.applyPose(holeSlot(seat, i, c));
      });
    }
    st.board.forEach((c, i) => {
      c.root.visible = true;
      c.setFaceUp(c.faceUp);
      c.applyPose(boardPose(L, i));
    });
    for (const [seat, pile] of st.bets) {
      const s = betSpot(L, v(seat));
      pile.setAmount(pile.amount, st.unit);
      pile.group.position.set(s.x, 0, s.z);
      pile.group.scale.setScalar(1);
      pile.group.visible = true;
    }
    placePots();
    placeButton();
    const d = deckPose(L);
    deck.position.set(d.x, 0, d.z);
    deck.rotation.y = d.yaw;
    dirty = true;
  }

  function removeHole(seat) {
    const cards = st.holes.get(seat);
    if (!cards) return;
    for (const c of cards) c.dispose();
    st.holes.delete(seat);
  }

  function clearHand() {
    for (const seat of [...st.holes.keys()]) removeHole(seat);
    for (const c of st.board) c.dispose();
    st.board = [];
    for (const p of st.bets.values()) p.dispose();
    st.bets.clear();
    for (const p of st.pots) p.dispose();
    st.pots = [];
  }

  function sync(ds) {
    tw.cancelAll();
    const hand = ds?.hand ?? null;
    const bb = ds?.room?.config?.bigBlind;
    if (bb > 0) st.unit = bb;
    const ys = ds?.you?.seat;
    st.heroSeat = Number.isInteger(ys) && ys >= 0 && ys < SEATS ? ys : -1;

    if (!hand) {
      clearHand();
      st.buttonSeat = null;
      st.highlight = null;
      st.handId = null;
      placeAll();
      return;
    }
    if (hand.handId !== st.handId) {
      st.highlight = null;
      st.handId = hand.handId;
    }
    st.buttonSeat = Number.isInteger(hand.button) ? hand.button : null;

    const players = hand.players || {};
    const live = new Set();
    for (const key of Object.keys(players)) {
      const seat = Number(key);
      const p = players[key];
      if (!p || p.folded) continue;
      live.add(seat);
      let cards = st.holes.get(seat);
      if (!cards) {
        cards = [newCard(), newCard()];
        st.holes.set(seat, cards);
      }
      cards.forEach((c, i) => {
        c.setCode(p.cards ? p.cards[i] : null);
        c.faceUp = !!p.cards;
      });
    }
    for (const seat of [...st.holes.keys()]) if (!live.has(seat)) removeHole(seat);

    const board = hand.board || [];
    while (st.board.length > board.length) st.board.pop().dispose();
    board.forEach((code, i) => {
      const c = st.board[i] || (st.board[i] = newCard());
      c.setCode(code);
      c.faceUp = true;
    });

    const betSeats = new Set();
    for (const key of Object.keys(players)) {
      const amt = players[key]?.streetBet || 0;
      if (amt <= 0) continue;
      const seat = Number(key);
      betSeats.add(seat);
      let pile = st.bets.get(seat);
      if (!pile) {
        pile = newPile();
        st.bets.set(seat, pile);
      }
      pile.amount = amt;
    }
    for (const [seat, pile] of [...st.bets]) {
      if (!betSeats.has(seat)) {
        pile.dispose();
        st.bets.delete(seat);
      }
    }

    const pots = (hand.pots || []).filter((p) => p.amount > 0);
    while (st.pots.length > pots.length) st.pots.pop().dispose();
    pots.forEach((p, i) => {
      const pile = st.pots[i] || (st.pots[i] = newPile());
      pile.amount = p.amount;
    });

    placeAll();
  }

  async function dealHole(order, myCards) {
    if (!L || !order?.length) return;
    const gen = tw.generation;
    const hero = myCards && order.includes(st.mySeat) ? st.mySeat : -1;
    if (hero >= 0) st.heroSeat = hero;
    for (const seat of order) {
      removeHole(seat);
      const cards = [newCard(), newCard()];
      cards.forEach((c, i) => {
        c.root.visible = false;
        c.setFaceUp(false);
        if (seat === hero) {
          c.setCode(myCards[i]);
          c.faceUp = true;
        }
      });
      st.holes.set(seat, cards);
    }
    const d = deckPose(L);
    const src = { ...d, y: 0.13 };
    const n = order.length;
    const flights = [];
    let heroDone = null;
    for (let k = 0; k < n * 2; k++) {
      const seat = order[k % n];
      const i = k < n ? 0 : 1;
      const card = st.holes.get(seat)[i];
      const land = holePose(L, v(seat), i, false, false);
      card.setFlip(FLIP_DOWN);
      const f = fly(card, src, land, 280, { delay: k * DEAL_CARD_MS, arc: 0.4, spin: 1.8, easing: ease.outCubic });
      flights.push(f);
      if (seat === hero && i === 1) {
        heroDone = f.then(async (ok) => {
          if (!ok || !alive(gen)) return;
          const cards = st.holes.get(hero);
          if (!cards) return;
          await Promise.all(
            cards.map((c, j) =>
              fly(c, readPose(c), holeSlot(hero, j, c), 300, {
                delay: j * 50,
                flipFrom: FLIP_DOWN,
                flipTo: 0,
                easing: ease.inOutCubic,
              })
            )
          );
        });
      }
    }
    await Promise.all(flights);
    if (heroDone) await heroDone;
    if (alive(gen)) dirty = true;
  }

  async function dealBoard(cards) {
    const onBoard = new Set(st.board.map((c) => c.code));
    const fresh = (cards || []).filter((code) => !onBoard.has(code));
    if (!L || !fresh.length) return;
    const gen = tw.generation;
    const start = st.board.length;
    const added = fresh.map((code) => {
      const c = newCard();
      c.setCode(code);
      c.setFlip(FLIP_DOWN);
      c.faceUp = true;
      c.root.visible = false;
      st.board.push(c);
      return c;
    });
    const d = deckPose(L);
    const src = { ...d, y: 0.13 };
    await Promise.all(
      added.map(async (c, i) => {
        const slot = boardPose(L, start + i);
        c.setTone(targetTone(c));
        const ok = await fly(c, src, slot, 260, { delay: i * 220, arc: 0.35, spin: 1.2, easing: ease.outCubic });
        if (!ok || !alive(gen)) return;
        await fly(c, slot, slot, 260, { flipFrom: FLIP_DOWN, flipTo: 0, easing: ease.inOutCubic });
      })
    );
  }

  async function revealHand(seat, cards) {
    if (!L || !cards) return;
    let hole = st.holes.get(seat);
    if (!hole) {
      hole = [newCard(), newCard()];
      st.holes.set(seat, hole);
      hole.forEach((c, i) => {
        c.setFaceUp(false);
        c.applyPose(holeSlot(seat, i, c));
      });
    }
    const jobs = hole.map((c, i) => {
      if (c.faceUp && c.code === cards[i] && c.mesh.rotation.y === 0) return true;
      const from = readPose(c);
      const flipFrom = c.mesh.rotation.y;
      c.setCode(cards[i]);
      c.faceUp = true;
      return fly(c, from, holeSlot(seat, i, c), 420, {
        delay: i * 120,
        flipFrom,
        flipTo: 0,
        easing: ease.inOutCubic,
      });
    });
    await Promise.all(jobs);
  }

  async function foldHand(seat) {
    if (!L) return;
    const hole = st.holes.get(seat);
    if (!hole) return;
    st.holes.delete(seat);
    const m = muckSpot(L);
    await Promise.all(
      hole.map(async (c, i) => {
        st.doomed.add(c);
        const from = readPose(c);
        const to = { x: m.x, y: CARD.t, z: m.z, yaw: 0.5 + i * 0.3, tilt: 0, scale: 0.25 };
        const ok = await fly(c, from, to, 340, {
          delay: i * 40,
          flipFrom: c.mesh.rotation.y,
          flipTo: FLIP_DOWN,
          arc: 0.15,
          easing: ease.inQuad,
          hideAtEnd: true,
        });
        if (ok) {
          st.doomed.delete(c);
          c.dispose();
        }
      })
    );
  }

  async function pushBet(seat, total) {
    if (!L) return;
    const gen = tw.generation;
    let pile = st.bets.get(seat);
    const prev = pile ? pile.amount : 0;
    if (!pile) {
      pile = newPile();
      st.bets.set(seat, pile);
      const s = betSpot(L, v(seat));
      pile.group.position.set(s.x, 0, s.z);
    }
    pile.amount = total;
    const delta = total - prev;
    if (delta <= 0) {
      pile.setAmount(total, st.unit);
      dirty = true;
      return;
    }
    const flyer = newPile();
    flyer.setAmount(delta, st.unit);
    st.doomed.add(flyer);
    const from = chipSourceSpot(L, v(seat));
    const to = betSpot(L, v(seat));
    flyer.group.position.set(from.x, 0, from.z);
    const ok = await slidePile(flyer, from, to, 320, { arc: 0.3, easing: ease.outCubic });
    if (!ok || !alive(gen)) return;
    st.doomed.delete(flyer);
    flyer.dispose();
    pile.setAmount(total, st.unit);
  }

  async function returnBet(seat, amount) {
    if (!L) return;
    const pile = st.bets.get(seat);
    if (!pile || !(amount > 0)) return;
    pile.amount = Math.max(0, pile.amount - amount);
    pile.setAmount(pile.amount, st.unit);
    if (pile.amount === 0) {
      st.bets.delete(seat);
      st.doomed.add(pile);
    }
    const flyer = newPile();
    flyer.setAmount(amount, st.unit);
    st.doomed.add(flyer);
    const from = betSpot(L, v(seat));
    const to = chipSourceSpot(L, v(seat));
    const ok = await slidePile(flyer, from, to, 300, { arc: 0.15, scaleTo: 0.5, easing: ease.inOutQuad });
    if (!ok) return;
    flyer.dispose();
    st.doomed.delete(flyer);
    if (pile.amount === 0) {
      pile.dispose();
      st.doomed.delete(pile);
    }
  }

  async function collectBets(pots) {
    if (!L) return;
    const gen = tw.generation;
    const moving = [...st.bets.values()];
    st.bets.clear();
    for (const p of moving) st.doomed.add(p);

    const amounts = (pots || []).map((p) => p.amount).filter((a) => a > 0);
    while (st.pots.length > amounts.length) st.pots.pop().dispose();
    amounts.forEach((a, i) => {
      const pile = st.pots[i] || (st.pots[i] = newPile());
      pile.amount = a;
    });
    const n = st.pots.length;
    st.pots.forEach((p, i) => {
      const s = potSpot(L, i, n);
      p.group.position.set(s.x, 0, s.z);
    });

    const target = potSpot(L, n - 1 < 0 ? 0 : n - 1, Math.max(1, n));
    const ok = (
      await Promise.all(
        moving.map((p, i) =>
          slidePile(p, { x: p.group.position.x, z: p.group.position.z }, target, 400, { delay: i * 25, arc: 0.12 })
        )
      )
    ).every(Boolean);
    if (!ok || !alive(gen)) return;
    for (const p of moving) {
      p.dispose();
      st.doomed.delete(p);
    }
    placePots();
    dirty = true;
  }

  async function awardPot(winners) {
    if (!L || !winners?.length) return;
    const gen = tw.generation;
    const total = winners.reduce((s, w) => s + (w.amount || 0), 0);
    let idx = st.pots.findIndex((p) => p.amount === total);
    if (idx < 0) idx = st.pots.length - 1;
    let from = potSpot(L, 0, 1);
    if (idx >= 0) {
      const p = st.pots[idx];
      from = { x: p.group.position.x, z: p.group.position.z };
      st.pots.splice(idx, 1);
      p.dispose();
      placePots();
    }
    const flyers = winners
      .filter((w) => w.amount > 0)
      .map((w) => {
        const f = newPile();
        f.setAmount(w.amount, st.unit);
        f.group.position.set(from.x, 0, from.z);
        st.doomed.add(f);
        return { f, to: chipSourceSpot(L, v(w.seat)) };
      });
    dirty = true;
    if (!(await tw.wait(250)) || !alive(gen)) return;
    const ok = (
      await Promise.all(
        flyers.map(({ f, to }, i) => slidePile(f, from, to, 950, { delay: i * 90, arc: 0.35, scaleTo: 0.85 }))
      )
    ).every(Boolean);
    if (!ok || !alive(gen)) return;
    await Promise.all(
      flyers.map(({ f, to }) => slidePile(f, to, to, 200, { arc: 0, scaleTo: 0.01, easing: ease.inQuad }))
    );
    for (const { f } of flyers) {
      f.dispose();
      st.doomed.delete(f);
    }
  }

  async function moveButton(seat) {
    if (!L) {
      st.buttonSeat = seat;
      return;
    }
    const prev = st.buttonSeat;
    st.buttonSeat = seat;
    if (prev == null || prev === seat || !button.visible) {
      placeButton();
      dirty = true;
      return;
    }
    const a = { x: button.position.x, z: button.position.z };
    const b = buttonSpot(L, v(seat));
    const a0 = Math.atan2(a.z / L.rz, a.x / L.rx);
    let a1 = Math.atan2(b.z / L.rz, b.x / L.rx);
    if (a1 - a0 > Math.PI) a1 -= Math.PI * 2;
    if (a0 - a1 > Math.PI) a1 += Math.PI * 2;
    const r0 = Math.hypot(a.x / L.rx, a.z / L.rz);
    const r1 = Math.hypot(b.x / L.rx, b.z / L.rz);
    await tw.run(
      560,
      (k) => {
        const ang = lerp(a0, a1, k);
        const r = lerp(r0, r1, k);
        button.position.set(Math.cos(ang) * r * L.rx, 0.12 * Math.sin(Math.PI * k), Math.sin(ang) * r * L.rz);
      },
      ease.inOutCubic
    );
  }

  function animateTones() {
    const cards = allCards();
    const starts = cards.map((c) => c.lift);
    const ends = cards.map((c) => {
      const t = targetTone(c);
      c.setTone(t);
      return t === 1 ? HIGHLIGHT_LIFT : 0;
    });
    dirty = true;
    return tw.run(
      220,
      (k) => {
        for (let i = 0; i < cards.length; i++) {
          const nl = lerp(starts[i], ends[i], k);
          cards[i].root.position.y += nl - cards[i].lift;
          cards[i].lift = nl;
        }
      },
      ease.outCubic
    );
  }

  function highlightCards(cards) {
    st.highlight = new Set(cards || []);
    return animateTones().then(() => {});
  }

  function clearHighlight() {
    st.highlight = null;
    return animateTones().then(() => {});
  }

  function setPerspective(mySeat) {
    st.mySeat = Number.isInteger(mySeat) && mySeat >= 0 ? mySeat % SEATS : 0;
    tw.cancelAll();
    placeAll();
    for (const cb of layoutCbs) cb();
  }

  function screenPos(seat, spot) {
    if (!L || !cssW) return { x: 0, y: 0 };
    let x = 0;
    let y = 0;
    let z = 0;
    if (spot === 'plate') {
      const p = plateSpot(L, v(seat));
      x = p.x;
      z = p.z;
      y = 0.25;
    } else if (spot === 'bet') {
      const p = betSpot(L, v(seat));
      x = p.x;
      z = p.z;
    } else if (spot === 'pot') {
      const p = potSpot(L, 0, 1);
      x = p.x;
      z = p.z;
    }
    tmp.set(x, y, z).project(camera);
    return { x: ((tmp.x + 1) / 2) * cssW, y: ((1 - tmp.y) / 2) * cssH };
  }

  function onLayout(cb) {
    layoutCbs.add(cb);
    return () => layoutCbs.delete(cb);
  }

  const fitPts = [];
  function fitCamera() {
    const w = cssW;
    const h = cssH;
    camera.fov = L.fov;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    fitPts.length = 0;
    const R = L.rail;
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      fitPts.push({ x: Math.cos(a) * (L.rx + R), y: 0.3, z: Math.sin(a) * (L.rz + R), px: 6, py: 6 });
    }
    const padX = Math.min(64, w * 0.13);
    for (let i = 0; i < SEATS; i++) {
      const p = plateSpot(L, i);
      fitPts.push({ x: p.x, y: 0.25, z: p.z, px: padX, py: 32 });
    }
    const pitch = L.pitch;
    const place = (D, tz) => {
      camera.position.set(0, D * Math.sin(pitch), tz + D * Math.cos(pitch));
      camera.lookAt(0, 0, tz);
      camera.updateMatrixWorld();
    };
    const slack = (D, tz) => {
      place(D, tz);
      let left = Infinity;
      let right = Infinity;
      let top = Infinity;
      let bottom = Infinity;
      for (const p of fitPts) {
        tmp.set(p.x, p.y, p.z).project(camera);
        const sx = ((tmp.x + 1) / 2) * w;
        const sy = ((1 - tmp.y) / 2) * h;
        left = Math.min(left, sx - p.px);
        right = Math.min(right, w - sx - p.px);
        top = Math.min(top, sy - p.py);
        bottom = Math.min(bottom, h - sy - p.py);
      }
      return { left, right, top, bottom };
    };
    let tz = 0;
    let D = 20;
    for (let iter = 0; iter < 4; iter++) {
      let lo = 2;
      let hi = 120;
      for (let j = 0; j < 26; j++) {
        const mid = (lo + hi) / 2;
        const s = slack(mid, tz);
        if (Math.min(s.left, s.right, s.top, s.bottom) >= 0) hi = mid;
        else lo = mid;
      }
      D = hi;
      const s = slack(D, tz);
      const worldPerPx = (2 * D * Math.tan((camera.fov * Math.PI) / 360)) / h;
      tz -= ((s.bottom - s.top) / 2) * worldPerPx / Math.sin(pitch);
    }
    place(D, tz);
    scene.fog.near = D * 1.05;
    scene.fog.far = D * 2.6;
  }

  function layout() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    cssW = w;
    cssH = h;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    const next = makeLayout(w / h);
    const changed = next !== L;
    L = next;
    if (changed) {
      table.build(L);
      const reach = Math.max(L.rx, L.rz) + L.rail;
      spot.position.set(0, 12, L.portrait ? 0 : 1.5);
      spot.angle = Math.atan2(reach + 1.0, 12);
      spot.target.position.set(0, 0, 0);
      tw.cancelAll();
      placeAll();
    }
    const size = Math.min(w, h) < 700 ? 1024 : 2048;
    if (spot.shadow.mapSize.x !== size) {
      spot.shadow.mapSize.set(size, size);
      if (spot.shadow.map) {
        spot.shadow.map.dispose();
        spot.shadow.map = null;
      }
    }
    fitCamera();
    dirty = true;
    for (const cb of layoutCbs) cb();
  }

  const ro = new ResizeObserver(() => layout());
  ro.observe(canvas);
  layout();

  // rAF stops in a hidden tab, which would leave every animation promise pending; finish them instead.
  const onVisibility = () => {
    if (!document.hidden) return;
    tw.cancelAll();
    placeAll();
  };
  document.addEventListener('visibilitychange', onVisibility);

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(250, now - last);
    last = now;
    const busy = tw.busy;
    if (busy) tw.update(dt);
    if ((busy || dirty) && L) {
      renderer.render(scene, camera);
      dirty = false;
    }
  }
  raf = requestAnimationFrame(frame);

  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(raf);
    ro.disconnect();
    document.removeEventListener('visibilitychange', onVisibility);
    tw.cancelAll();
    clearHand();
    for (const d of st.doomed) d.dispose();
    st.doomed.clear();
    layoutCbs.clear();
    table.dispose();
    cardKit.dispose();
    chipKit.dispose();
    button.userData.dispose();
    spot.shadow.map?.dispose();
    renderer.dispose();
  }

  const wrap =
    (fn) =>
    (...args) => {
      dirty = true;
      return fn(...args);
    };

  return {
    setPerspective: wrap(setPerspective),
    sync: wrap(sync),
    dealHole: wrap(dealHole),
    dealBoard: wrap(dealBoard),
    revealHand: wrap(revealHand),
    foldHand: wrap(foldHand),
    pushBet: wrap(pushBet),
    returnBet: wrap(returnBet),
    collectBets: wrap(collectBets),
    awardPot: wrap(awardPot),
    moveButton: wrap(moveButton),
    highlightCards: wrap(highlightCards),
    clearHighlight: wrap(clearHighlight),
    screenPos,
    onLayout,
    dispose,
  };
}
