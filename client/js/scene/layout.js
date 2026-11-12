// World units: table felt on the y=0 plane, +z points at the camera, the local player sits at +z.

export const SEATS = 6;
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
  betInset: [1.12, 1.75, 1.55, 1.25, 1.55, 1.75],
  betSide: [1.6, 0, 0, -0.95, 0, 0],
  buttonInset: [1.12, 1.45],
  buttonSide: [1.2, 0.8],
  plateOut: [0.42, 0.28, 0.28, 0.42, 0.28, 0.28],
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
  holeInset: [0.72, 1.0, 1.0, 0.72, 1.0, 1.0],
  betInset: [1.12, 1.9, 1.9, 1.6, 1.9, 1.9],
  betSide: [1.3, 0, 0, 0, 0, 0],
  buttonInset: [1.05, 1.55],
  buttonSide: [1.05, 0.8],
  // Side nameplates straddle the rail on phones; outside it they would squeeze the table to half the width.
  plateOut: [0.3, -0.21, -0.21, 0.3, -0.21, -0.21],
  boardScale: 1.08,
  holeScale: 0.88,
  revealScale: 1.05,
  heroScale: 1.45,
};

const portraits = new Map();

/**
 * Portrait tables stretch with the screen so a phone is filled top to bottom. rz is quantised so small
 * height changes (mobile URL bar) keep the same layout object and do not trigger a rebuild.
 */
export function makeLayout(aspect) {
  if (aspect >= 1.05) return LANDSCAPE;
  const rz = Math.min(7, Math.max(4.5, Math.round((3.0 / aspect) * 2) / 2));
  let L = portraits.get(rz);
  if (!L) {
    L = { ...PORTRAIT, rz };
    portraits.set(rz, L);
  }
  return L;
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

export function plateSpot(L, v) {
  return railPoint(L, L.seatT[v], -(L.rail + L.plateOut[v]));
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

export function buttonSpot(L, v) {
  const k = v === 0 ? 0 : 1;
  const p = railPoint(L, L.seatT[v], L.buttonInset[k]);
  // Seats 1 and 4 offset the other way, away from the hero's cards and the deck respectively.
  const side = L.buttonSide[k] * (v === 1 || v === 4 ? -1 : 1);
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
  const spacing = L.portrait ? 1.05 : 1.25;
  return { x: (i - (n - 1) / 2) * spacing, z };
}

export function deckPose(L) {
  const p = railPoint(L, L.deckT, 0.95);
  return { x: p.x, y: 0, z: p.z, yaw: -0.35, tilt: 0, scale: 1 };
}

export function muckSpot(L) {
  const p = railPoint(L, L.deckT, 1.5);
  return { x: p.x, z: p.z };
}
