import * as THREE from 'three';

function ellipseShape(rx, rz, holeRx, holeRz) {
  const shape = new THREE.Shape();
  shape.absellipse(0, 0, rx, rz, 0, Math.PI * 2, false, 0);
  if (holeRx) {
    const hole = new THREE.Path();
    hole.absellipse(0, 0, holeRx, holeRz, 0, Math.PI * 2, true, 0);
    shape.holes.push(hole);
  }
  return shape;
}

function remapPlanarUV(geo, rx, rz) {
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    uv.setXY(i, (pos.getX(i) + rx) / (2 * rx), (pos.getY(i) + rz) / (2 * rz));
  }
  uv.needsUpdate = true;
}

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function feltTexture(L, maxAniso) {
  const W = 1024;
  const H = Math.round((W * L.rz) / L.rx);
  const c = canvas(W, H);
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.55);
  grad.addColorStop(0, '#1f7d52');
  grad.addColorStop(0.6, '#176a44');
  grad.addColorStop(1, '#0d4a30');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);

  const img = g.getImageData(0, 0, W, H);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 14;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  g.putImageData(img, 0, 0);

  const pxPerUnit = W / (2 * L.rx);
  const lineInset = 1.2;
  g.save();
  g.translate(W / 2, H / 2);
  g.strokeStyle = 'rgba(236, 214, 160, 0.42)';
  g.lineWidth = 0.028 * pxPerUnit;
  g.beginPath();
  g.ellipse(0, 0, (L.rx - lineInset) * pxPerUnit, (L.rz - lineInset) * pxPerUnit, 0, 0, Math.PI * 2);
  g.stroke();
  g.strokeStyle = 'rgba(236, 214, 160, 0.16)';
  g.lineWidth = 0.012 * pxPerUnit;
  g.beginPath();
  g.ellipse(0, 0, (L.rx - lineInset - 0.09) * pxPerUnit, (L.rz - lineInset - 0.09) * pxPerUnit, 0, 0, Math.PI * 2);
  g.stroke();

  g.restore();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAniso;
  return tex;
}

function grainTexture() {
  const S = 256;
  const c = canvas(S, S);
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = 110 + Math.random() * 60;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function floorTexture() {
  const S = 512;
  const c = canvas(S, S);
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grad.addColorStop(0, '#3a2b20');
  grad.addColorStop(0.35, '#1d1610');
  grad.addColorStop(1, '#050506');
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createTable(renderer) {
  const group = new THREE.Group();
  const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const grain = grainTexture();

  const feltMat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0, bumpMap: grain, bumpScale: 0.6 });
  const trimMat = new THREE.MeshPhysicalMaterial({ color: 0x3b2314, roughness: 0.38, clearcoat: 0.6, clearcoatRoughness: 0.25 });
  const railMat = new THREE.MeshPhysicalMaterial({
    color: 0x17110d,
    roughness: 0.55,
    clearcoat: 0.35,
    clearcoatRoughness: 0.5,
    sheen: 0.4,
    sheenColor: new THREE.Color(0x553a28),
  });
  const apronMat = new THREE.MeshStandardMaterial({ color: 0x120c08, roughness: 0.6 });
  const floorMat = new THREE.MeshStandardMaterial({ map: floorTexture(), roughness: 0.95 });

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -2.4;
  floor.receiveShadow = true;
  group.add(floor);

  let parts = [];

  function build(L) {
    for (const m of parts) {
      group.remove(m);
      m.geometry.dispose();
    }
    parts = [];
    if (feltMat.map) feltMat.map.dispose();
    feltMat.map = feltTexture(L, maxAniso);
    feltMat.needsUpdate = true;
    grain.repeat.set(L.rx * 3, L.rz * 3);

    const flat = (geo) => {
      geo.rotateX(-Math.PI / 2);
      return geo;
    };

    const feltGeo = new THREE.ShapeGeometry(ellipseShape(L.rx + 0.1, L.rz + 0.1), 96);
    remapPlanarUV(feltGeo, L.rx + 0.1, L.rz + 0.1);
    const felt = new THREE.Mesh(flat(feltGeo), feltMat);
    felt.receiveShadow = true;

    const trimW = 0.16;
    const trimGeo = new THREE.ExtrudeGeometry(ellipseShape(L.rx + 0.2, L.rz + 0.2, L.rx - trimW, L.rz - trimW), {
      depth: 0.012,
      bevelEnabled: true,
      bevelThickness: 0.01,
      bevelSize: 0.01,
      bevelSegments: 2,
      curveSegments: 96,
    });
    const trim = new THREE.Mesh(flat(trimGeo), trimMat);
    trim.position.y = 0.0;
    trim.receiveShadow = true;

    const bevel = Math.min(0.16, L.rail * 0.34);
    const railGeo = new THREE.ExtrudeGeometry(
      ellipseShape(L.rx + L.rail - bevel, L.rz + L.rail - bevel, L.rx + bevel - 0.04, L.rz + bevel - 0.04),
      { depth: 0.08, bevelEnabled: true, bevelThickness: 0.13, bevelSize: bevel, bevelSegments: 8, curveSegments: 120 }
    );
    const rail = new THREE.Mesh(flat(railGeo), railMat);
    rail.position.y = 0.1;
    rail.castShadow = true;
    rail.receiveShadow = true;

    const apronGeo = new THREE.ExtrudeGeometry(ellipseShape(L.rx + L.rail - 0.08, L.rz + L.rail - 0.08), {
      depth: 0.55,
      bevelEnabled: false,
      curveSegments: 96,
    });
    const apron = new THREE.Mesh(flat(apronGeo), apronMat);
    apron.position.y = -0.56;
    apron.castShadow = true;
    apron.receiveShadow = true;

    const pedestalGeo = new THREE.CylinderGeometry(Math.min(L.rx, L.rz) * 0.35, Math.min(L.rx, L.rz) * 0.5, 1.9, 48);
    const pedestal = new THREE.Mesh(pedestalGeo, apronMat);
    pedestal.position.y = -1.45;

    parts = [felt, trim, rail, apron, pedestal];
    for (const m of parts) group.add(m);
  }

  function dispose() {
    for (const m of parts) m.geometry.dispose();
    floor.geometry.dispose();
    for (const mat of [feltMat, trimMat, railMat, apronMat, floorMat]) {
      if (mat.map) mat.map.dispose();
      mat.dispose();
    }
    grain.dispose();
  }

  return { group, build, dispose };
}
