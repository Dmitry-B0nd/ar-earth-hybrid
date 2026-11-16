// Точки интереса на поверхности Земли: космодромы, ЦУПы, станции дальней связи.
// Точки кладутся в ECEF-группу Земли и вращаются вместе с ней.
import * as THREE from 'three';

export const POI_VERSION = '5.1h';   // должна совпадать со сборкой в index.html
const DEG = Math.PI / 180;

// широта/долгота (градусы) → точка на сфере в ECEF (X — Гринвич, Z — северный полюс)
export function latLonToVec3(lat, lon, r, out = new THREE.Vector3()) {
  const la = lat * DEG, lo = lon * DEG;
  return out.set(r * Math.cos(la) * Math.cos(lo), r * Math.cos(la) * Math.sin(lo), r * Math.sin(la));
}

export async function loadPoi(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error('poi.json: HTTP ' + r.status);
  return r.json();
}

export function createPoi({ earth, data }) {
  const R = earth.radius;
  const group = new THREE.Group();
  earth.ecef.add(group);

  // Общие геометрии: тонкая «ножка» от поверхности, светящаяся головка и
  // невидимая увеличенная сфера для попадания пальцем.
  const STEM = R * 0.05, HEAD = R * 0.026, HIT = R * 0.09;
  const stemGeo = new THREE.CylinderGeometry(R * 0.004, R * 0.004, STEM, 6);
  stemGeo.rotateX(Math.PI / 2);            // цилиндр вдоль оси Z
  stemGeo.translate(0, 0, STEM / 2);
  const headGeo = new THREE.SphereGeometry(HEAD, 16, 12);
  const haloGeo = new THREE.RingGeometry(HEAD * 1.4, HEAD * 1.9, 32);
  const hitGeo = new THREE.SphereGeometry(HIT, 8, 6);
  const hitMat = new THREE.MeshBasicMaterial({ visible: false });

  const items = [];
  const zAxis = new THREE.Vector3(0, 0, 1), n = new THREE.Vector3();

  for (const p of data.points) {
    const type = data.types[p.type] || { color: '#ffffff', label: p.type };
    const color = new THREE.Color(type.color);

    const pin = new THREE.Group();
    latLonToVec3(p.lat, p.lon, R * 1.002, pin.position);
    pin.quaternion.setFromUnitVectors(zAxis, n.copy(pin.position).normalize());   // ось Z пина — наружу

    const stem = new THREE.Mesh(stemGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 }));
    const head = new THREE.Mesh(headGeo, new THREE.MeshBasicMaterial({ color, transparent: true }));
    head.position.z = STEM;
    const halo = new THREE.Mesh(haloGeo, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false,
    }));
    halo.position.z = STEM;
    const hit = new THREE.Mesh(hitGeo, hitMat);
    hit.position.z = STEM;
    hit.userData.poi = p;

    pin.add(stem, head, halo, hit);
    group.add(pin);
    items.push({ p, pin, stem, head, halo, hit, facing: 0 });
  }

  let selected = null;
  const camLocal = new THREE.Vector3(), center = new THREE.Vector3(), wp = new THREE.Vector3();
  const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

  return {
    group,
    hitTargets: items.map((i) => i.hit),

    // точка, по которой попал луч (с учётом того, что Земля закрывает обратную сторону)
    pick(raycaster) {
      // из всех точек, в чью зону попал палец, берём ту, что ближе всего к лучу
      // (а не первую по лучу) — так соседние точки не «перехватывают» тап
      const hits = raycaster.intersectObjects(this.hitTargets, false);
      let best = null, bestD = Infinity;
      for (const h of hits) {
        const it = items.find((i) => i.hit === h.object);
        if (it.facing < 0.1) continue;                      // на обратной стороне Земли
        const d = raycaster.ray.distanceToPoint(it.head.getWorldPosition(wp));
        if (d < bestD) { bestD = d; best = it; }
      }
      return best ? best.p : null;
    },

    // Все видимые точки в радиусе radiusPx от места касания, ближайшие первыми.
    // Зона нажатия считается в пикселях экрана, поэтому не зависит от расстояния до метки.
    pickScreen(x, y, camera, rect, radiusPx) {
      const out = [];
      for (const it of items) {
        if (!it.pin.visible || it.facing < 0.1) continue;
        it.head.getWorldPosition(wp).project(camera);
        if (wp.z > 1) continue;
        const sx = rect.left + (wp.x + 1) / 2 * rect.width;
        const sy = rect.top + (1 - wp.y) / 2 * rect.height;
        const d = Math.hypot(sx - x, sy - y);
        if (d <= radiusPx) out.push({ p: it.p, d });
      }
      return out.sort((u, v) => u.d - v.d);
    },

    select(id) {
      selected = items.find((i) => i.p.id === id) || null;
    },

    // анимация: пульсация выбранной точки, ореол повёрнут к камере
    update(timeSec, camera) {
      camera.getWorldPosition(camLocal);
      earth.group.getWorldPosition(center);
      for (const it of items) {
        it.pin.getWorldPosition(wp);
        const normal = wp.clone().sub(center).normalize();
        it.facing = normal.dot(wp.clone().sub(camLocal).negate().normalize());   // 1 — смотрит на нас, 0 — край диска
        const vis = sstep(0.02, 0.22, it.facing);
        it.pin.visible = vis > 0.001;
        it.head.material.opacity = vis;
        it.stem.material.opacity = 0.85 * vis;
        const isSel = it === selected;
        it.head.scale.setScalar(isSel ? 1.6 + 0.25 * Math.sin(timeSec * 6) : 1);
        it.halo.material.opacity = isSel ? 0.9 * vis : 0;
        if (isSel) it.halo.lookAt(camLocal);
      }
    },
  };
}
