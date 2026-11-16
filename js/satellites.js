// Спутники: расчёт положения по орбитальным элементам (SGP4, satellite.js) и отрисовка.
// Спутники кладутся в ECI-группу Земли (система «звёзды неподвижны»), Земля под ними вращается.
import * as THREE from 'three';
import { json2satrec, propagate, eciToGeodetic, gstime } from './vendor/satellite.js';

const RE = 6378.137;            // экваториальный радиус Земли, км

export async function loadSatellites(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('satellites.json: HTTP ' + r.status);
  return r.json();
}

// ---------- точки-спутники: круглые, размер задан в долях ширины метки ----------
const pointsVertex = /* glsl */`
  attribute float aSize;
  attribute vec3 color;
  uniform float uViewportH, uMinPx, uMaxPx;
  varying vec3 vColor;
  void main() {
    vColor = color;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float scale = length(modelViewMatrix[0].xyz);
    float px = aSize * scale * projectionMatrix[1][1] * uViewportH * 0.5 / -mv.z;
    gl_PointSize = aSize > 0.0 ? clamp(px, uMinPx, uMaxPx) : 0.0;
    gl_Position = projectionMatrix * mv;
  }`;
const pointsFragment = /* glsl */`
  varying vec3 vColor;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float r = length(c);
    if (r > 0.5) discard;
    float core = smoothstep(0.5, 0.32, r);
    gl_FragColor = vec4(mix(vColor * 0.35, vColor, core), 1.0);
  }`;

// подпись: текст на холсте → спрайт постоянного экранного размера
function makeLabel(text, color) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const font = '600 44px -apple-system, system-ui, sans-serif';
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 24, h = 64;
  c.width = w; c.height = h;
  ctx.font = font; ctx.textBaseline = 'middle';
  ctx.lineWidth = 8; ctx.strokeStyle = 'rgba(5,10,25,.85)'; ctx.lineJoin = 'round';
  ctx.strokeText(text, 12, h / 2);
  ctx.fillStyle = color; ctx.fillText(text, 12, h / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, sizeAttenuation: false, depthWrite: false, transparent: true }));
  sprite.userData.aspect = w / h;
  sprite.center.set(0.5, -0.35);               // подпись чуть выше точки
  sprite.renderOrder = 10;
  return sprite;
}

// модель кубсата: корпус 1U/3U/… + раскрытые солнечные панели (рисуется кодом)
function makeCubesatModel(units = 3) {
  const g = new THREE.Group();
  const cell = (() => {
    const c = document.createElement('canvas'); c.width = 64; c.height = 64;
    const x = c.getContext('2d');
    x.fillStyle = '#16306e'; x.fillRect(0, 0, 64, 64);
    x.strokeStyle = '#8fa8d8'; x.lineWidth = 2;
    for (let i = 0; i <= 64; i += 16) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i, 64); x.stroke(); x.beginPath(); x.moveTo(0, i); x.lineTo(64, i); x.stroke(); }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const bodyMat = new THREE.MeshLambertMaterial({ color: 0xd9dde6 });
  const panelMat = new THREE.MeshLambertMaterial({ map: cell, side: THREE.DoubleSide });
  const body = new THREE.Mesh(new THREE.BoxGeometry(units, 1, 1), bodyMat);   // длинная ось — X (вдоль движения)
  g.add(body);
  for (const side of [-1, 1]) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(units * 0.95, 1.6, 0.06), panelMat);
    p.position.set(0, side * 1.35, 0);
    g.add(p);
  }
  // антенна
  const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.6, 6), bodyMat);
  ant.rotation.x = Math.PI / 2; ant.position.set(units / 2 - 0.2, 0, 0.8);
  g.add(ant);
  g.scale.setScalar(1 / units);    // длина модели = 1
  return g;
}

export function createSatellites({ earth, data, scene, artistic = true }) {
  const R = earth.radius;
  const group = new THREE.Group();
  earth.group.add(group);

  // Высота над Землёй в сцене. В реальном масштабе низкие орбиты почти касаются Земли
  // (МКС — 6% радиуса), а геостационар уходит на 5,6 радиуса. Поэтому «художественный»
  // масштаб: низкие орбиты приподняты, высокие прижаты (степенная функция).
  const radiusScene = artistic
    ? (rkm) => R * (1 + 0.69 * Math.pow(Math.max(rkm - RE, 0) / RE, 0.324))
    : (rkm) => R * rkm / RE;

  const groups = data.groups || {};
  const items = [];
  for (const s of data.sats) {
    let rec;
    try { rec = json2satrec(s.omm); } catch (e) { console.warn('Спутник пропущен (ошибка орбиты):', s.name, e); continue; }
    if (!rec || rec.error) continue;
    items.push({ s, rec, pkm: new THREE.Vector3(), vkm: new THREE.Vector3(), ok: false,
                 color: new THREE.Color((groups[s.group] || {}).color || '#ffffff') });
  }
  const N = items.length;

  // ---- точки ----
  const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), size = new Float32Array(N);
  items.forEach((it, i) => {
    it.i = i;
    col.set([it.color.r, it.color.g, it.color.b], i * 3);
    it.baseSize = it.s.group === 'context' ? R * 0.06 : R * 0.032;
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), R * 10);
  const mat = new THREE.ShaderMaterial({
    vertexShader: pointsVertex, fragmentShader: pointsFragment,
    uniforms: { uViewportH: { value: 800 }, uMinPx: { value: 3 }, uMaxPx: { value: 40 } },
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  group.add(points);

  // ---- подписи и орбиты контекстных спутников ----
  const ctxItems = items.filter((it) => it.s.group === 'context');
  for (const it of ctxItems) {
    it.label = makeLabel(it.s.name, '#' + it.color.getHexString());
    group.add(it.label);
    it.orbit = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({
      color: it.color, transparent: true, opacity: 0.35, depthWrite: false }));
    it.orbit.frustumCulled = false;
    group.add(it.orbit);
  }

  // ---- выбранный спутник: подсветка, орбита, модель, подпись ----
  let selected = null;
  const selOrbit = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false }));
  selOrbit.frustumCulled = false; selOrbit.visible = false;
  group.add(selOrbit);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 32), new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
  ring.visible = false;
  group.add(ring);
  const model = makeCubesatModel(3);
  model.visible = false;
  group.add(model);
  let selLabel = null;

  // свет только для модели кубсата (Земля рисуется своим шейдером и свет не использует)
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  const amb = new THREE.AmbientLight(0x8899bb, 0.6);
  scene.add(sun, amb, sun.target);

  // ---- расчёт ----
  const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();
  let lastProp = 0, propCursor = 0;

  // фильтр показа: small — 'all' | 'cube' | 'none', context — true/false
  const filter = { small: 'all', context: true };
  const isShown = (it) => it.s.group === 'context' ? filter.context
    : filter.small === 'all' || (filter.small === 'cube' && !!it.s.cube);

  function prop(it, date) {
    const pv = propagate(it.rec, date);
    if (!pv || !pv.position || Number.isNaN(pv.position.x)) { it.ok = false; return; }
    it.pkm.set(pv.position.x, pv.position.y, pv.position.z);
    it.vkm.set(pv.velocity.x, pv.velocity.y, pv.velocity.z);
    it.ok = true; it.t = date.getTime();
  }

  // точка орбиты в координатах сцены (направление сохраняем, радиус — по масштабу)
  function toScene(pkm, out) {
    const r = pkm.length();
    return out.copy(pkm).multiplyScalar(radiusScene(r) / r);
  }

  function buildOrbit(it, line, t0, segments = 160) {
    const n = it.rec.no * 1440 / (2 * Math.PI);          // оборотов в сутки
    const periodMs = 86400e3 / n;
    const pts = [];
    for (let k = 0; k <= segments; k++) {
      const pv = propagate(it.rec, new Date(t0 + periodMs * k / segments));
      if (!pv || !pv.position) continue;
      pts.push(toScene(tmp.set(pv.position.x, pv.position.y, pv.position.z), new THREE.Vector3()));
    }
    line.geometry.dispose();
    line.geometry = new THREE.BufferGeometry().setFromPoints(pts);
  }
  // орбиты перестраиваем по одной за раз, чтобы не было рывков FPS
  let orbitQueue = [], lastOrbitStep = 0, lastOrbitCycle = -1e9;

  const xDir = new THREE.Vector3(), yDir = new THREE.Vector3(), zDir = new THREE.Vector3();
  const basis = new THREE.Matrix4(), qTarget = new THREE.Quaternion();
  let modelReady = false;
  const camPosW = new THREE.Vector3();

  let propEvery = 100;
  const api = {
    group, items, count: N, filter,

    setFilter(f) {
      Object.assign(filter, f);
      for (const it of ctxItems) { it.label.visible = it.orbit.visible = filter.context; }
      if (selected && !isShown(selected)) api.select(null);
      lastProp = 0; lastOrbitCycle = -1e9;
    },
    isShown,
    // лёгкий режим: полный пересчёт обычных точек 2 раза в секунду вместо 10 (между пересчётами — по скорости)
    setLite(on) { propEvery = on ? 500 : 100; },

    update(date, renderer, sunDirWorld, camera) {
      const now = performance.now(), t = date.getTime();
      // обычные точки: каждая пересчитывается раз в propEvery мс, между пересчётами — по скорости.
      // Пересчёт размазан по кадрам (каждый кадр — своя порция), а не весь разом: иначе раз в 100 мс
      // один кадр получался заметно длиннее остальных (микрофриз).
      // Контекстные и выбранный — точно в каждом кадре (их мало, а на них смотрят пристально).
      const NI = items.length;
      const forceAll = lastProp === 0;
      const due = forceAll ? NI : Math.min(NI, Math.ceil(NI * Math.min(1, (now - lastProp) / propEvery)));
      lastProp = now;
      for (let k = 0; k < NI; k++) {
        const it = items[k], i = it.i;
        const full = forceAll || ((k - propCursor + NI) % NI) < due;
        if (!isShown(it)) { size[i] = 0; continue; }
        const precise = it.s.group === 'context' || it === selected;
        if (precise || full || it.t === undefined || Math.abs(t - it.t) > 120e3) prop(it, date);
        if (!it.ok) { size[i] = 0; continue; }
        toScene(tmp.copy(it.pkm).addScaledVector(it.vkm, (t - it.t) / 1000), tmp2);
        pos[i * 3] = tmp2.x; pos[i * 3 + 1] = tmp2.y; pos[i * 3 + 2] = tmp2.z;
        it.scenePos = it.scenePos || new THREE.Vector3();
        it.scenePos.copy(tmp2);
        size[i] = it === selected ? it.baseSize * 1.5 : it.baseSize;
        if (it.label) it.label.position.copy(tmp2);
      }
      if (NI) propCursor = (propCursor + due) % NI;
      geo.attributes.position.needsUpdate = true;
      geo.attributes.aSize.needsUpdate = true;
      mat.uniforms.uViewportH.value = renderer.domElement.height;
      const dpr = renderer.getPixelRatio();
      mat.uniforms.uMinPx.value = 3 * dpr; mat.uniforms.uMaxPx.value = 36 * dpr;

      // орбиты: раз в 3 секунды ставим в очередь, строим по одной каждые 120 мс
      if (now - lastOrbitCycle > 3000) {
        lastOrbitCycle = now;
        orbitQueue = [];
        if (selected && selected.ok) orbitQueue.push([selected, selOrbit]);
        if (filter.context) for (const it of ctxItems) if (it.ok) orbitQueue.push([it, it.orbit]);
      }
      if (orbitQueue.length && now - lastOrbitStep > 120) {
        lastOrbitStep = now;
        const [it, line] = orbitQueue.shift();
        buildOrbit(it, line, t);
      }

      // подписи — постоянного экранного размера
      // (размер спрайта умножается на масштаб родителей — в AR сцена масштабирована, поэтому делим)
      const ws = group.getWorldScale(camPosW).x || 1, L = 0.032 / ws;
      for (const it of ctxItems) it.label.scale.set(L * it.label.userData.aspect, L, 1);
      if (selLabel) selLabel.scale.set(1.15 * L * selLabel.userData.aspect, 1.15 * L, 1);

      // выбранный спутник
      const sel = selected && selected.ok ? selected : null;
      ring.visible = model.visible = selOrbit.visible = !!sel;
      if (selLabel) selLabel.visible = !!sel;
      if (sel) {
        const p = sel.scenePos;
        ring.position.copy(p);
        ring.scale.setScalar(sel.baseSize * 1.6);
        ring.lookAt(camera ? camera.getWorldPosition(camPosW) : camPosW.set(0, 0, 0));   // кольцо — лицом к камере
        if (selLabel) selLabel.position.copy(p);
        // модель (условная, для малых спутников): «низом» к Земле, носом по ходу движения.
        // Оси считаем из точного положения и скорости этого кадра и слегка сглаживаем — без рывков.
        model.visible = sel.s.group === 'cubesat';
        model.position.copy(p);
        model.scale.setScalar(R * 0.12);
        zDir.copy(sel.pkm).normalize();
        xDir.copy(sel.vkm).addScaledVector(zDir, -sel.vkm.dot(zDir)).normalize();
        yDir.crossVectors(zDir, xDir);
        qTarget.setFromRotationMatrix(basis.makeBasis(xDir, yDir, zDir));
        if (!modelReady) { model.quaternion.copy(qTarget); modelReady = true; }
        else model.quaternion.slerp(qTarget, 0.35);
      }
      if (sunDirWorld) { sun.position.copy(sunDirWorld).multiplyScalar(1000); sun.target.position.set(0, 0, 0); }
    },

    // все видимые спутники в радиусе radiusPx от места касания (с учётом того, что Земля закрывает часть)
    pickScreen(x, y, camera, rect, radiusPx) {
      const out = [];
      const camPos = camera.getWorldPosition(new THREE.Vector3());
      const c = earth.group.getWorldPosition(new THREE.Vector3());
      const rWorld = R * earth.group.getWorldScale(new THREE.Vector3()).x;
      const w = new THREE.Vector3(), d = new THREE.Vector3(), oc = new THREE.Vector3();
      for (const it of items) {
        if (!it.ok || !it.scenePos || !isShown(it)) continue;
        group.localToWorld(w.copy(it.scenePos));
        // закрыт ли Землёй: пересекает ли отрезок «камера → спутник» шар Земли
        d.copy(w).sub(camPos); const len = d.length(); d.divideScalar(len);
        oc.copy(c).sub(camPos);
        const tc = oc.dot(d), h2 = oc.lengthSq() - tc * tc;
        if (h2 < rWorld * rWorld) { const t0 = tc - Math.sqrt(rWorld * rWorld - h2); if (t0 > 0 && t0 < len) continue; }
        const p = w.clone().project(camera);
        if (p.z > 1) continue;
        const sx = rect.left + (p.x + 1) / 2 * rect.width, sy = rect.top + (1 - p.y) / 2 * rect.height;
        const dist = Math.hypot(sx - x, sy - y);
        if (dist <= radiusPx) out.push({ it, d: dist });
      }
      return out.sort((a, b) => a.d - b.d);
    },

    select(it) {
      selected = it || null;
      if (selLabel) { group.remove(selLabel); selLabel.material.map.dispose(); selLabel = null; }
      if (selected && !selected.label) {
        selLabel = makeLabel(selected.s.name, '#ffffff');
        group.add(selLabel);
      }
      lastOrbitCycle = -1e9; modelReady = false;
    },

    // живые сведения для карточки
    liveFacts(it, date) {
      if (!it.ok) return {};
      const r = it.pkm.length(), v = it.vkm.length();
      const nRevDay = it.rec.no * 1440 / (2 * Math.PI);
      const geod = eciToGeodetic({ x: it.pkm.x, y: it.pkm.y, z: it.pkm.z }, gstime(date));
      const lat = geod.latitude * 180 / Math.PI, lon = ((geod.longitude * 180 / Math.PI + 540) % 360) - 180;
      const fmtDeg = (v, pos, neg) => Math.abs(v).toFixed(1).replace('.', ',') + '° ' + (v >= 0 ? pos : neg);
      return {
        'Высота': Math.round(geod.height).toLocaleString('ru-RU') + ' км',
        'Скорость': v.toFixed(2).replace('.', ',') + ' км/с',
        'Виток': (1440 / nRevDay < 120 ? Math.round(1440 / nRevDay) + ' мин' : (24 / nRevDay).toFixed(1).replace('.', ',') + ' ч'),
        'Наклонение орбиты': (it.rec.inclo * 180 / Math.PI).toFixed(1).replace('.', ',') + '°',
        'Сейчас над точкой': fmtDeg(lat, 'с. ш.', 'ю. ш.') + ', ' + fmtDeg(lon, 'в. д.', 'з. д.'),
      };
    },
  };
  return api;
}
