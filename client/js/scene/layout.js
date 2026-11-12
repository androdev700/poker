// World units: table felt on the y=0 plane, +z points at the camera, the local player sits at +z.

export const SEATS = 6;
export const MAX_RZ = 7;
export const CARD = { w: 0.62, h: 0.87, t: 0.008, r: 0.055 };
const DEG = Math.PI / 180;

const LANDSCAPE = {
  portrait: false,
  rx: 5.1,
  rz: 3.05,
  rail: 0.5,
  pitch: 50 * DEG,
  fov: 34,
  seatT: [90, 150, 210, 270, 330, 30].map((d) => d * DEG),
  deckT: 300 * DEG,
  holeInset: [0.78, 0.78, 0.78, 0.78, 0.78, 0.78],
  // Bets and the top seat's button stay out of the pot row so the pot label has room left of the piles.
  betInset: [1.12, 1.46, 2.25, 1.05, 2.25, 1.46],
  betSide: [1.6, -0.96, -0.22, 1.15, 0.22, 0.96],
  buttonInset: [1.12, 1.45, 1.45, 0.6, 1.45, 1.45],
  // Seats 1 and 4 offset away from the hero's cards and the deck.
  buttonSide: [1.2, -0.8, 0.8, 0.95, -0.8, 0.8],
  // The hero's plate sits over the front rail beside its cards; the top seat's covers the far rail.
  plateOut: [-0.35, 0.55, 0.55, 0, 0.55, 0.55],
  // Plate anchor shift along the rail, positive toward the next view index; the hero's moves away from the
  // action bar docked bottom-right.
  plateSide: [2.0, 0, 0, 0, 0, 0],
  // The pot row sits right of centre so it and its label, on the left, are centred together.
  potShift: 0.35,
  deckInset: 0.75,
  boardScale: 1.22,
  holeScale: 0.92,
  revealScale: 1.12,
  heroScale: 1.38,
};

const PORTRAIT = {
  ...LANDSCAPE,
  portrait: true,
  rx: 2.7,
  rz: 5.0,
  rail: 0.42,
  pitch: 56 * DEG,
  fov: 40,
  seatT: [90, 148, 212, 270, 328, 32].map((d) => d * DEG),
  deckT: 302 * DEG,
  holeInset: [0.72, 1.1, 1.1, 0.72, 1.1, 1.1],
  // The lower side seats keep their bets and button out of the strip under the board where the pot label hangs.
  betInset: [1.12, 1.85, 1.9, 1.6, 1.9, 1.85],
  betSide: [1.3, -0.3, 0, 0, 0, 0.3],
  // Side seats keep their button near the rail and off the pot row; seat 4's goes down, clear of the deck.
  buttonInset: [1.05, 0.9, 0.75, 1.55, 0.7, 0.9],
  buttonSide: [1.05, 0.75, -0.75, 0.8, -1.2, -0.75],
  // Side nameplates cover the rail; upright ones (phones) also overlap the felt, since outside the rail they
  // would squeeze the table to half the width.
  plateOut: [0.47, 0, 0, 0.47, 0, 0],
  uprightPlateOut: [0.47, -0.3, -0.3, 0.47, -0.3, -0.3],
  plateSide: [0, 0, 0, 0, 0, 0],
  potShift: 0,
  deckInset: 0.95,
  boardScale: 1.08,
  holeScale: 0.88,
  revealScale: 1.05,
  heroScale: 1.45,
};

// Short, wide screens: side nameplates slide toward the table's ends so they sit beside the rail, not above it.
const LANDSCAPE_ENDS = { ...LANDSCAPE, plateSide: [2.0, 1.2, -1.2, 0, 1.2, -1.2] };

const portraits = new Map();

function portraitLayout(rz) {
  let L = portraits.get(rz);
  if (!L) {
    L = { ...PORTRAIT, rz };
    // On the shortest table seats 1 and 5 would put the button against the hero's bet; it goes up instead.
    if (rz < 5) {
      L.buttonInset = [1.05, 0.65, 0.75, 1.55, 0.7, 0.65];
      L.buttonSide = [1.05, -1.15, -0.75, 0.8, -1.2, 1.15];
    }
    portraits.set(rz, L);
  }
  return L;
}

/**
 * Portrait vs landscape follows the canvas so HUD insets never flip the table; a portrait table stretches
 * to the free rectangle between the HUD bars. rz is quantised so small height changes (mobile URL bar)
 * keep the same layout object and do not trigger a rebuild.
 */
export function makeLayout(aspect, freeAspect = aspect) {
  if (aspect >= 1.05) return LANDSCAPE;
  return portraitLayout(Math.min(MAX_RZ, Math.max(4.5, Math.round((4.0 / freeAspect) * 2) / 2)));
}

/** makeLayout's pick first, then the alternatives the stage may fall back to when nameplates do not fit. */
export function layoutChoices(aspect, freeAspect = aspect) {
  const first = makeLayout(aspect, freeAspect);
  if (!first.portrait) return [first, LANDSCAPE_ENDS];
  const out = [first];
  for (let rz = first.rz + 0.5; rz <= MAX_RZ; rz += 0.5) out.push(portraitLayout(rz));
  return out;
}

export const viewIndex = (seat, mySeat) => (((seat - mySeat) % SEATS) + SEATS) % SEATS;

/** Point on the felt ellipse at parameter t, moved `inset` along the inward normal (negative = outward). */
export function railPoint(L, t, inset) {
  const c = Math.cos(t);
  const s = Math.sin(t);
  let nx = c / L.rx;
  let nz = s / L.rz;
  const n = Math.hypot(nx, nz);
  nx /= n;
  nz /= n;
  let tx = -L.rx * s;
  let tz = L.rz * c;
  const m = Math.hypot(tx, tz);
  tx /= m;
  tz /= m;
  return { x: L.rx * c - nx * inset, z: L.rz * s - nz * inset, nx, nz, tx, tz };
}

/** Nameplate anchor; `out` is the distance outward from the felt edge (negative = over the felt). */
export function plateSpot(L, v, upright = false) {
  let t = L.seatT[v];
  if (L.plateSide[v]) t += L.plateSide[v] / Math.hypot(L.rx * Math.sin(t), L.rz * Math.cos(t));
  const out = (upright && L.uprightPlateOut ? L.uprightPlateOut : L.plateOut)[v];
  return { ...railPoint(L, t, -out), out };
}

/** betSide shifts a bet along the rail (positive = toward the next view index) to clear the hole cards. */
export function betSpot(L, v) {
  const p = railPoint(L, L.seatT[v], L.betInset[v]);
  const side = L.betSide[v];
  return { x: p.x + p.tx * side, z: p.z + p.tz * side };
}

export function chipSourceSpot(L, v) {
  return railPoint(L, L.seatT[v], 0.25);
}

/** buttonSide shifts the button along the rail, positive = toward the previous view index. */
export function buttonSpot(L, v) {
  const p = railPoint(L, L.seatT[v], L.buttonInset[v]);
  const side = L.buttonSide[v];
  return { x: p.x - p.tx * side, z: p.z - p.tz * side };
}

/** Card pose: position, yaw about world Y, tilt of the card's top edge up off the felt, uniform scale. */
export function holePose(L, v, i, faceUp, hero) {
  if (hero) {
    const p = railPoint(L, L.seatT[v], L.holeInset[v] + 0.32);
    const s = L.heroScale;
    const spread = CARD.w * s * 0.56;
    return {
      x: p.x + (i === 0 ? -spread / 2 : spread / 2),
      y: 0.34 + i * 0.012,
      z: p.z,
      yaw: i === 0 ? 0.07 : -0.07,
      tilt: 0.62,
      scale: s,
    };
  }
  const p = railPoint(L, L.seatT[v], L.holeInset[v]);
  const s = faceUp ? L.revealScale : L.holeScale;
  const off = CARD.w * s * (faceUp ? 0.56 : 0.34);
  return {
    x: p.x + (i === 0 ? -off / 2 : off / 2),
    y: CARD.t / 2 + 0.002 + i * 0.006,
    z: p.z + (i === 0 ? 0.02 : -0.02),
    yaw: i === 0 ? 0.1 : -0.1,
    tilt: 0,
    scale: s,
  };
}

export function boardPose(L, i) {
  const s = L.boardScale;
  const gap = CARD.w * s + 0.09 * s;
  return { x: (i - 2) * gap, y: CARD.t / 2 + 0.002, z: 0, yaw: 0, tilt: 0, scale: s };
}

export function boardHalfDepth(L) {
  return (CARD.h * L.boardScale) / 2;
}

export function potSpot(L, i = 0, n = 1) {
  const z = -(boardHalfDepth(L) + (L.portrait ? 0.5 : 0.55));
  const spacing = L.portrait ? 1.05 : 0.95;
  return { x: (i - (n - 1) / 2) * spacing + L.potShift, z };
}

export function deckPose(L) {
  const p = railPoint(L, L.deckT, L.deckInset);
  return { x: p.x, y: 0, z: p.z, yaw: -0.35, tilt: 0, scale: 1 };
}

export function muckSpot(L) {
  const p = railPoint(L, L.deckT, 1.5);
  return { x: p.x, z: p.z };
}
