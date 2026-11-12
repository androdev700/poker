import * as THREE from 'three';

export const CHIP_R = 0.175;
export const CHIP_H = 0.046;
const STACK_MAX = 10;
const MAX_STACKS = 6;

/** Values are in big blinds; the smallest chip makes up any remainder. */
export const DENOMS = [
  { bb: 2500, base: '#138a99', spot: '#f2f2f2' },
  { bb: 500, base: '#d98a1c', spot: '#3a2410' },
  { bb: 100, base: '#5a2b8c', spot: '#f2f2f2' },
  { bb: 25, base: '#1d1e22', spot: '#d8c690' },
  { bb: 5, base: '#1f7a3b', spot: '#f2f2f2' },
  { bb: 1, base: '#b3222c', spot: '#f2f2f2' },
  { bb: 0.2, base: '#e8e4da', spot: '#2a5db0' },
];

/**
 * Splits `amount` into single-denomination stacks of at most ~10 chips, largest first.
 * @returns {{denom:number, count:number}[]} denom = index into DENOMS
 */
export function chipBreakdown(amount, unit) {
  const stacks = [];
  if (!(amount > 0) || !(unit > 0)) return stacks;
  let rest = amount / unit;
  const counts = DENOMS.map(() => 0);
  for (let i = 0; i < DENOMS.length; i++) {
    const n = Math.floor(rest / DENOMS[i].bb + 1e-9);
    counts[i] = n;
    rest -= n * DENOMS[i].bb;
  }
  if (rest > 1e-6) counts[DENOMS.length - 1]++;
  for (let i = 0; i < DENOMS.length; i++) {
    let n = counts[i];
    while (n > 0 && stacks.length < MAX_STACKS) {
      const c = Math.min(STACK_MAX, n);
      stacks.push({ denom: i, count: c });
      n -= c;
    }
  }
  return stacks;
}

const ATLAS_W = 256;
const CAP_H = 256;
const SIDE_H = 64;
const CAP_V0 = SIDE_H / (CAP_H + SIDE_H);

function drawChipAtlas({ base, spot }) {
  const c = document.createElement('canvas');
  c.width = ATLAS_W;
  c.height = CAP_H + SIDE_H;
  const g = c.getContext('2d');
  const cx = ATLAS_W / 2;
  const cy = CAP_H / 2;
  const R = CAP_H / 2;

  g.fillStyle = base;
  g.fillRect(0, 0, c.width, c.height);

  g.fillStyle = spot;
  for (let i = 0; i < 6; i++) {
    const a0 = (i / 6) * Math.PI * 2 - 0.2;
    g.beginPath();
    g.arc(cx, cy, R, a0, a0 + 0.4);
    g.arc(cx, cy, R * 0.8, a0 + 0.4, a0, true);
    g.closePath();
    g.fill();
  }
  g.strokeStyle = spot;
  g.globalAlpha = 0.85;
  g.lineWidth = 4;
  g.setLineDash([10, 8]);
  g.beginPath();
  g.arc(cx, cy, R * 0.66, 0, Math.PI * 2);
  g.stroke();
  g.setLineDash([]);
  g.globalAlpha = 1;
  const inner = g.createRadialGradient(cx, cy - 10, 4, cx, cy, R * 0.58);
  inner.addColorStop(0, 'rgba(255,255,255,0.18)');
  inner.addColorStop(1, 'rgba(0,0,0,0.12)');
  g.fillStyle = inner;
  g.beginPath();
  g.arc(cx, cy, R * 0.58, 0, Math.PI * 2);
  g.fill();

  const y0 = CAP_H;
  g.fillStyle = base;
  g.fillRect(0, y0, ATLAS_W, SIDE_H);
  g.fillStyle = spot;
  for (let i = 0; i < 6; i++) {
    const x = (i / 6) * ATLAS_W + ATLAS_W / 24;
    g.fillRect(x, y0, ATLAS_W / 18, SIDE_H);
  }
  g.fillStyle = 'rgba(0,0,0,0.35)';
  g.fillRect(0, y0, ATLAS_W, 5);
  g.fillRect(0, y0 + SIDE_H - 5, ATLAS_W, 5);
  return c;
}

function chipGeometry() {
  const geo = new THREE.CylinderGeometry(CHIP_R, CHIP_R, CHIP_H, 36, 1, false);
  const uv = geo.attributes.uv;
  const seen = new Set();
  for (const grp of geo.groups) {
    const side = grp.materialIndex === 0;
    for (let i = grp.start; i < grp.start + grp.count; i++) {
      const vi = geo.index.getX(i);
      if (seen.has(vi)) continue;
      seen.add(vi);
      const v = uv.getY(vi);
      uv.setY(vi, side ? v * CAP_V0 * 0.98 : CAP_V0 + v * (1 - CAP_V0));
    }
  }
  geo.clearGroups();
  return geo;
}

function hash(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export function createChipKit(renderer) {
  const aniso = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  const geo = chipGeometry();
  const mats = DENOMS.map((d) => {
    const t = new THREE.CanvasTexture(drawChipAtlas(d));
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = aniso;
    return new THREE.MeshStandardMaterial({ map: t, roughness: 0.38, metalness: 0.05 });
  });
  const dispose = () => {
    geo.dispose();
    for (const m of mats) {
      m.map.dispose();
      m.dispose();
    }
  };
  return { geo, mats, dispose };
}

const STACK_GAP = CHIP_R * 2 + 0.018;

/** A cluster of chip stacks for one amount. Its Group origin sits on the felt at the cluster centre. */
export class Pile {
  constructor(kit) {
    this.kit = kit;
    this.group = new THREE.Group();
    this.shown = 0;
    this.unit = 0;
    this.amount = 0;
  }

  setAmount(amount, unit) {
    if (amount === this.shown && unit === this.unit) return;
    this.shown = amount;
    this.unit = unit;
    const g = this.group;
    g.clear();
    const stacks = chipBreakdown(amount, unit);
    const n = stacks.length;
    const front = n > 3 ? Math.ceil(n / 2) : n;
    const back = n - front;
    let seed = 0;
    stacks.forEach((st, si) => {
      const row = si < front ? 0 : 1;
      const col = row === 0 ? si : si - front;
      const rowN = row === 0 ? front : back;
      const sx = (col - (rowN - 1) / 2) * STACK_GAP;
      const sz = back ? (row === 0 ? 0.5 : -0.5) * STACK_GAP : 0;
      for (let k = 0; k < st.count; k++) {
        const m = new THREE.Mesh(this.kit.geo, this.kit.mats[st.denom]);
        seed++;
        m.position.set(sx + (hash(seed) - 0.5) * 0.014, CHIP_H / 2 + k * CHIP_H, sz + (hash(seed + 99) - 0.5) * 0.014);
        m.rotation.y = hash(seed + 7) * Math.PI * 2;
        m.castShadow = true;
        m.receiveShadow = true;
        g.add(m);
      }
    });
  }

  dispose() {
    this.group.removeFromParent();
    this.group.clear();
  }
}
