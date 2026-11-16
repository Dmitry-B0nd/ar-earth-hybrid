// Датчики положения телефона (гироскоп + акселерометр, уже «склеенные» системой).
// Даёт ориентацию камеры телефона в «мире» (Z мира — вверх, против силы тяжести) и направление «вверх».
// Камера three.js: X — вправо по экрану, Y — вверх по экрану, Z — из экрана к зрителю.
import * as THREE from 'three';

const DEG = Math.PI / 180;

export function createImu() {
  let alpha = 0, beta = 0, gamma = 0, hasAlpha = false, t = -1e9, count = 0, listening = false;
  // короткая история показаний — чтобы можно было взять ориентацию «на N мс раньше»
  // (кадр камеры доходит до программы с небольшой задержкой)
  const HIST = 32, hist = Array.from({ length: HIST }, () => ({ t: -1e9, a: 0, b: 0, g: 0 }));
  let hi = 0;
  const tmpV = new THREE.Vector3();
  const euler = new THREE.Euler(), qScreen = new THREE.Quaternion(), zAxis = new THREE.Vector3(0, 0, 1);

  // Источники ориентации. На iOS и Android с гироскопом — обычное событие deviceorientation.
  // На телефонах без гироскопа оно приходит пустым (Chrome), и тогда берём deviceorientationabsolute
  // (акселерометр + компас: шумнее, но лучше, чем ничего). Считаем, что приходит, — для отладки.
  const diag = { rel: 0, relNull: 0, abs: 0, absNull: 0, mot: 0, grav: 0 };
  let relT = -1e9, source = '—';
  function onOrient(e) { take(e, 'rel'); }
  function onOrientAbs(e) { take(e, 'abs'); }
  function take(e, kind) {
    if (e.beta == null || e.gamma == null) { diag[kind + 'Null']++; return; }
    diag[kind]++;
    const now = performance.now();
    if (kind === 'rel') relT = now;
    else if (now - relT < 500) return;                 // обычное событие работает — компасное не нужно
    source = kind === 'rel' ? 'гироскоп' : 'компас';
    beta = e.beta; gamma = e.gamma;
    hasAlpha = e.alpha != null;
    alpha = hasAlpha ? e.alpha : 0;
    t = performance.now(); count++;
    const h = hist[hi = (hi + 1) % HIST]; h.t = t; h.a = alpha; h.b = beta; h.g = gamma;
  }
  // Резкие движения: ускорение без учёта силы тяжести (м/с²) и скорость поворота (°/с).
  // Пики копятся до чтения (для строки отладки); время последнего «рывка» — по заданным порогам.
  let jerkA = Infinity, jerkW = Infinity, lastJerkT = -1e9, peakA = 0, peakW = 0, motionCount = 0, hasAcc = false;
  // «Вверх» по одному акселерометру (есть в любом телефоне): ускорение с учётом силы тяжести,
  // сглаженное; в покое оно направлено вверх (стандарт W3C: экраном вверх на столе — z = +9,8).
  // Пока телефон заметно ускоряется, показания не учитываем.
  const grav = new THREE.Vector3(); let gravT = -1e9, gravN = 0;
  function onMotion(e) {
    motionCount++; diag.mot++;
    const ag = e.accelerationIncludingGravity;
    if (ag && ag.x != null) {
      const m = Math.hypot(ag.x, ag.y, ag.z);
      if (m > 7.8 && m < 11.8) {
        diag.grav++;
        if (gravN === 0) grav.set(ag.x, ag.y, ag.z); else grav.lerp(tmpV.set(ag.x, ag.y, ag.z), 0.15);
        gravN++; gravT = performance.now();
      }
    }
    const a = e.acceleration, r = e.rotationRate;
    let am = 0, wm = 0;
    if (a && a.x != null) { am = Math.hypot(a.x, a.y, a.z); hasAcc = true; }
    if (r && r.alpha != null) wm = Math.hypot(r.alpha, r.beta, r.gamma);
    if (am > peakA) peakA = am;
    if (wm > peakW) peakW = wm;
    if (am > jerkA || wm > jerkW) lastJerkT = performance.now();
  }
  const screenAngle = () => ((screen.orientation && screen.orientation.angle) ?? window.orientation ?? 0) * DEG;

  const api = {
    // Вызывать прямо в обработчике нажатия кнопки, до любых await:
    // iOS разрешает спросить доступ к датчикам только в ответ на действие пользователя.
    request() {
      // Ориентация и движение (акселерометр) — в iOS и новом Chrome это отдельные разрешения;
      // спрашиваем оба сразу, в том же нажатии. Хватит и одного: без ориентации работаем по акселерометру.
      const D = window.DeviceOrientationEvent, M = window.DeviceMotionEvent;
      const ask = (E, name) => (E && typeof E.requestPermission === 'function')
        ? E.requestPermission().then((r) => r === 'granted').catch((e) => { console.warn('IMU: нет доступа —', name, e); return false; })
        : Promise.resolve(!!E);
      return Promise.all([ask(D, 'ориентация'), ask(M, 'движение')]).then(([o, m]) => {
        if (o !== m) console.log('[датчики] ориентация:', o ? 'есть' : 'нет', ', движение:', m ? 'есть' : 'нет');
        return o || m;
      });
    },
    start() {
      if (listening) return;
      listening = true;
      window.addEventListener('deviceorientation', onOrient);
      if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', onOrientAbs);
      window.addEventListener('devicemotion', onMotion);
    },
    // пороги рывка: ускорение, м/с², и скорость поворота, °/с
    setJerk(a, w) { jerkA = a; jerkW = w; },
    get lastJerkT() { return lastJerkT; },
    get hasMotion() { return motionCount > 0; },
    get hasAcc() { return hasAcc; },
    // пики с прошлого вызова (для строки отладки)
    takePeaks() { const p = { a: peakA, w: peakW }; peakA = peakW = 0; return p; },
    get count() { return count; },
    get source() { return source; },
    get diag() { return diag; },
    gravFresh() { return gravN > 5 && performance.now() - gravT < 300; },
    // «вверх» в координатах камеры по одному акселерометру (sign = ±1 — на случай обратного знака у браузера)
    gravityUp(out, sign = 1) {
      const a = screenAngle(), x = grav.x * sign, y = grav.y * sign, z = grav.z * sign;
      return out.set(x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a), z).normalize();
    },
    get hasAlpha() { return hasAlpha; },
    fresh() { return performance.now() - t < 300; },

    // Ориентация камеры в мире: кватернион «из координат камеры в координаты мира».
    // Углы по стандарту W3C: R = Rz(alpha)·Rx(beta)·Ry(gamma); плюс поправка на поворот экрана.
    // alpha (поворот вокруг вертикали) у телефона отсчитывается от произвольного направления
    // и медленно «уплывает» — поэтому её используем только в паре с камерой, которая это поправляет.
    worldFromCamera(out, lagMs = 0) {
      let a = alpha, b = beta, g = gamma;
      if (lagMs > 0) {                       // самое свежее показание, которое не новее (сейчас − lagMs)
        const target = performance.now() - lagMs;
        for (let k = 0; k < HIST; k++) {
          const h = hist[(hi - k + HIST) % HIST];
          if (h.t <= target) { if (h.t > 0) { a = h.a; b = h.b; g = h.g; } break; }
        }
      }
      euler.set(b * DEG, g * DEG, a * DEG, 'ZXY');
      out.setFromEuler(euler);
      return out.multiply(qScreen.setFromAxisAngle(zAxis, -screenAngle()));
    },

    // Вектор «вверх» в координатах камеры (единичный), записывается в out (THREE.Vector3)
    upCamera(out) {
      const b = beta * DEG, g = gamma * DEG;
      const x = -Math.cos(b) * Math.sin(g), y = Math.sin(b), z = Math.cos(b) * Math.cos(g);
      const a = screenAngle();
      return out.set(x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a), z).normalize();
    },
  };
  return api;
}
