import * as THREE from 'three';
import { CARD } from './layout.js';

const FACE_W = 300;
const FACE_H = 420;
const RED = '#c4202f';
const BLACK = '#16181d';
const SUIT_GLYPH = { s: '♠', h: '♥', d: '♦', c: '♣' };
const TEXT_STYLE = '︎';
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

function roundRectShape(w, h, r) {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

/**
 * Rounded slab in the XY plane, centred on z=0, with material groups 0 = front (+z), 1 = back (-z), 2 = edge.
 * Cap UVs span the card 0..1, the back mirrored so its texture reads correctly from behind.
 */
export function slabGeometry(w, h, t, r) {
  const src = new THREE.ExtrudeGeometry(roundRectShape(w, h, r), { depth: t, bevelEnabled: false, curveSegments: 6 });
  const pos = src.attributes.position;
  const nor = src.attributes.normal;
  const buckets = [[], [], []];
  const eps = 1e-6;
  for (let i = 0; i < pos.count; i += 3) {
    const z0 = pos.getZ(i);
    const z1 = pos.getZ(i + 1);
    const z2 = pos.getZ(i + 2);
    let b = 2;
    if (Math.abs(z0 - t) < eps && Math.abs(z1 - t) < eps && Math.abs(z2 - t) < eps) b = 0;
    else if (Math.abs(z0) < eps && Math.abs(z1) < eps && Math.abs(z2) < eps) b = 1;
    buckets[b].push(i, i + 1, i + 2);
  }
  const n = pos.count;
  const P = new Float32Array(n * 3);
  const N = new Float32Array(n * 3);
  const U = new Float32Array(n * 2);
  const geo = new THREE.BufferGeometry();
  let k = 0;
  buckets.forEach((list, g) => {
    geo.addGroup(k, list.length, g);
    for (const i of list) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      P[k * 3] = x;
      P[k * 3 + 1] = y;
      P[k * 3 + 2] = pos.getZ(i) - t / 2;
      N[k * 3] = nor.getX(i);
      N[k * 3 + 1] = nor.getY(i);
      N[k * 3 + 2] = nor.getZ(i);
      const u = (x + w / 2) / w;
      U[k * 2] = g === 1 ? 1 - u : u;
      U[k * 2 + 1] = (y + h / 2) / h;
      k++;
    }
  });
  geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(U, 2));
  src.dispose();
  return geo;
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function fillRounded(g, x, y, w, h, r) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
  g.fill();
}

function drawFace(code) {
  const c = makeCanvas(FACE_W, FACE_H);
  const g = c.getContext('2d');
  const rank = code[0] === 'T' ? '10' : code[0];
  const suit = code[1];
  const color = suit === 'h' || suit === 'd' ? RED : BLACK;
  const glyph = SUIT_GLYPH[suit] + TEXT_STYLE;

  const bg = g.createLinearGradient(0, 0, 0, FACE_H);
  bg.addColorStop(0, '#fdfcf8');
  bg.addColorStop(1, '#efebe2');
  g.fillStyle = bg;
  g.fillRect(0, 0, FACE_W, FACE_H);

  g.fillStyle = color;
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';

  const idxX = 78;
  g.font = `800 150px ${FONT}`;
  g.save();
  if (rank.length > 1) {
    g.translate(idxX, 0);
    g.scale(0.72, 1);
    g.translate(-idxX, 0);
  }
  g.fillText(rank, idxX, 142);
  g.restore();

  g.font = `110px ${FONT}`;
  g.fillText(glyph, idxX, 252);

  g.globalAlpha = 0.95;
  g.font = `230px ${FONT}`;
  g.fillText(glyph, 200, 398);
  g.globalAlpha = 1;
  return c;
}

function drawBack() {
  const c = makeCanvas(FACE_W, FACE_H);
  const g = c.getContext('2d');
  g.fillStyle = '#f4f1ea';
  g.fillRect(0, 0, FACE_W, FACE_H);
  const m = 16;
  const grad = g.createLinearGradient(0, 0, FACE_W, FACE_H);
  grad.addColorStop(0, '#a3192f');
  grad.addColorStop(1, '#6e0f1f');
  g.fillStyle = grad;
  fillRounded(g, m, m, FACE_W - 2 * m, FACE_H - 2 * m, 14);

  g.save();
  g.beginPath();
  g.roundRect(m, m, FACE_W - 2 * m, FACE_H - 2 * m, 14);
  g.clip();
  g.strokeStyle = 'rgba(255, 220, 200, 0.16)';
  g.lineWidth = 2;
  const step = 22;
  for (let d = -FACE_H; d < FACE_W + FACE_H; d += step) {
    g.beginPath();
    g.moveTo(d, 0);
    g.lineTo(d + FACE_H, FACE_H);
    g.moveTo(d, FACE_H);
    g.lineTo(d + FACE_H, 0);
    g.stroke();
  }
  g.restore();

  g.strokeStyle = 'rgba(255, 226, 170, 0.55)';
  g.lineWidth = 3;
  g.beginPath();
  g.roundRect(m + 10, m + 10, FACE_W - 2 * m - 20, FACE_H - 2 * m - 20, 10);
  g.stroke();

  const cx = FACE_W / 2;
  const cy = FACE_H / 2;
  g.fillStyle = '#7a1022';
  g.beginPath();
  g.arc(cx, cy, 58, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = 'rgba(255, 226, 170, 0.75)';
  g.lineWidth = 4;
  g.stroke();
  g.fillStyle = 'rgba(255, 226, 170, 0.9)';
  g.font = `76px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(SUIT_GLYPH.s + TEXT_STYLE, cx, cy + 4);
  return c;
}

function drawGlow() {
  const S = 128;
  const c = makeCanvas(S, Math.round((S * CARD.h) / CARD.w));
  const g = c.getContext('2d');
  const w = c.width;
  const h = c.height;
  // shadowBlur instead of ctx.filter, which older Safari ignores: draw off-canvas and keep only the blurred shadow.
  g.shadowColor = 'rgba(255, 210, 110, 1)';
  g.shadowBlur = 12;
  g.shadowOffsetX = w * 2;
  g.fillStyle = '#000';
  fillRounded(g, 18 - w * 2, 18, w - 36, h - 36, 12);
  return c;
}

export function createCardKit(renderer) {
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const tex = (canvas) => {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = aniso;
    return t;
  };
  const faces = new Map();
  const blank = tex(makeCanvas(4, 4));
  const geo = slabGeometry(CARD.w, CARD.h, CARD.t, CARD.r);
  const deckGeo = slabGeometry(CARD.w, CARD.h, 0.11, CARD.r);
  const backMat = new THREE.MeshStandardMaterial({ map: tex(drawBack()), roughness: 0.5 });
  const edgeMat = new THREE.MeshStandardMaterial({ color: 0xe9e5dc, roughness: 0.7 });
  const glowGeo = new THREE.PlaneGeometry(CARD.w * 1.32, CARD.h * 1.24);
  const glowMat = new THREE.MeshBasicMaterial({
    map: tex(drawGlow()),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });

  function face(code) {
    let t = faces.get(code);
    if (!t) {
      t = tex(drawFace(code));
      faces.set(code, t);
    }
    return t;
  }

  function createDeck() {
    const mesh = new THREE.Mesh(deckGeo, [backMat, backMat, edgeMat]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.055;
    const root = new THREE.Group();
    root.add(mesh);
    return root;
  }

  function dispose() {
    for (const t of faces.values()) t.dispose();
    faces.clear();
    blank.dispose();
    geo.dispose();
    deckGeo.dispose();
    glowGeo.dispose();
    backMat.map.dispose();
    backMat.dispose();
    edgeMat.dispose();
    glowMat.map.dispose();
    glowMat.dispose();
  }

  return { geo, backMat, edgeMat, glowGeo, glowMat, face, blank, createDeck, dispose };
}

/**
 * root (position, yaw, tilt, scale) -> mesh (rotation.y = flip, 0 face up / PI face down).
 * Flipping about the card's long axis is a real 3D turn; the caller lifts root while it happens.
 */
export class Card {
  constructor(kit) {
    this.kit = kit;
    this.frontMat = new THREE.MeshStandardMaterial({ map: kit.blank, roughness: 0.42 });
    this.mesh = new THREE.Mesh(kit.geo, [this.frontMat, kit.backMat, kit.edgeMat]);
    this.mesh.castShadow = true;
    this.glow = new THREE.Mesh(kit.glowGeo, kit.glowMat);
    this.glow.position.z = -CARD.t;
    this.glow.visible = false;
    this.glow.renderOrder = -1;
    this.mesh.add(this.glow);
    this.root = new THREE.Group();
    this.root.rotation.order = 'YXZ';
    this.root.add(this.mesh);
    this.code = null;
    this.faceUp = false;
    this.lift = 0;
    this.tone = 0;
    this.pose = null;
  }

  setCode(code) {
    if (code === this.code) return;
    this.code = code;
    this.frontMat.map = code ? this.kit.face(code) : this.kit.blank;
  }

  setFlip(angle) {
    this.mesh.rotation.y = angle;
  }

  setFaceUp(up) {
    this.faceUp = up;
    this.mesh.rotation.y = up ? 0 : Math.PI;
  }

  /** 1 = highlighted (glow), -1 = dimmed, 0 = normal */
  setTone(tone) {
    this.tone = tone;
    this.glow.visible = tone === 1;
    this.frontMat.color.setScalar(tone === -1 ? 0.3 : 1);
  }

  applyPose(p, extraY = 0) {
    this.root.position.set(p.x, p.y + this.lift + extraY, p.z);
    this.root.rotation.set(-Math.PI / 2 + p.tilt, p.yaw, 0);
    this.root.scale.setScalar(p.scale);
  }

  dispose() {
    this.root.removeFromParent();
    this.frontMat.dispose();
  }
}
