// Трекинг метки (MindAR) + наше сглаживание, отсев ошибочных поз и синхронизация видео.
// Наружу отдаёт группу `content`: всё, что в неё положено, «стоит» на метке.
// Единицы внутри content: ширина метки = 1, центр метки = (0,0,0), ось Z смотрит от метки вверх.
import * as THREE from 'three';
import { MindARThree } from 'mindar-image-three';
import { createHybrid } from './hybrid.js?v=5.0h';

export function createTracker(opts) {
  const { container, markerUrl, CF, BETA, MISS, WARM, SYNC, RAW, JUMP, NOGUARD, onFound, onLost, onStall, onFatal,
          imu, USE_IMU = true, TOL = 20, IMULAG = 0, KMW = 0.03, COAST = 500, PREDICT = 1, CAMFPS = 60, JERK = 1, JERKA = 10, JERKW = 200, HYBRID = 0, HYAGREE = 6,
          PMC = 2, PB = 5, DMC = 0.6, DB = 2, RMC, RB, DC = 1, FOV = 66 } = opts;

  // MindAR просит у камеры только «заднюю камеру» — iPhone тогда снимает 30 кадров/с.
  // Трекер же успевает ~60 раз в секунду, поэтому просим 60 кадров/с при том же размере кадра:
  // вдвое меньше сдвиг метки между кадрами и короче выдержка — меньше смаз при резких движениях.
  if (CAMFPS && navigator.mediaDevices && navigator.mediaDevices.getUserMedia && !navigator.mediaDevices.__fpsPatched) {
    const md = navigator.mediaDevices, origGUM = md.getUserMedia.bind(md);
    md.getUserMedia = (c) => {
      if (c && c.video && typeof c.video === 'object' && !c.video.frameRate)
        c = { ...c, video: { ...c.video, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: CAMFPS } } };
      return origGUM(c);
    };
    md.__fpsPatched = true;
  }
  const mindar = new MindARThree({
    container, imageTargetSrc: markerUrl, uiScanning: 'no', uiError: 'no',
    filterMinCF: CF, filterBeta: BETA, missTolerance: MISS, warmupTolerance: WARM,
  });
  const { renderer, scene, camera } = mindar;
  // MindAR рисует с плотностью пикселей экрана (у айфона ×3) и сглаживанием — это много видеопамяти.
  // При повороте экрана буферы пересоздаются, и iOS может отобрать у страницы графический контекст
  // распознавания. Ограничиваем ×2: на глаз почти не отличить, памяти в 2,25 раза меньше.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const anchor = mindar.addAnchor(0);

  // ---- 0. Настоящий угол обзора камеры ----
  // MindAR считает, что угол обзора у любой камеры 45° по длинной стороне кадра. У камеры
  // айфона он ~65–72°. С неверным углом трекер систематически ошибается в НАКЛОНЕ метки
  // (на 20–30°), путает похожие наклоны и «перескакивает» между ними, а рамка не ложится по краю.
  // Подменяем параметры камеры в момент, когда MindAR создаёт свой контроллер, — до того,
  // как он передаст их в трекер и в фоновый поток распознавания.
  let ctrl = null;
  const intrinsics = { fov: FOV, f: null, fOrig: null };
  Object.defineProperty(mindar, 'controller', {
    configurable: true, enumerable: true,
    get: () => ctrl,
    set: (c) => {
      ctrl = c;
      if (!FOV || !c || !c.projectionTransform) return;
      const W = c.inputWidth, H = c.inputHeight, long = Math.max(W, H);
      const P = c.projectionTransform;
      intrinsics.fOrig = P[0][0];
      const f = (long / 2) / Math.tan(FOV * Math.PI / 360);
      P[0][0] = f; P[1][1] = f;                                  // меняем на месте: трекер держит ссылку на этот массив
      c.projectionMatrix = c._glProjectionMatrix({ projectionTransform: P, width: W, height: H, near: 10, far: 100000 });
      intrinsics.f = f;
      console.log('[камера] угол обзора', FOV + '°: фокус', f.toFixed(0), 'px вместо', intrinsics.fOrig.toFixed(0), 'px, кадр', W + '×' + H);
    },
  });

  const content = new THREE.Group();
  content.matrixAutoUpdate = false;
  content.visible = false;
  scene.add(content);

  anchor.onTargetFound = () => onFound && onFound();
  anchor.onTargetLost = () => onLost && onLost();

  // ---- 1. Поза метки: камера + датчики телефона, отсев ошибочных поз ----
  // Камера хорошо видит, ГДЕ метка, но её поворот (особенно наклон) определяет с дрожью:
  // плоская картинка почти одинаково выглядит при чуть разных наклонах, а Земля висит над меткой,
  // и любая дрожь поворота раскачивает её, как маятник. Поворот берём из гироскопа (см. ниже),
  // положение — из камеры. Без гироскопа работает только камера с отсевом явно ошибочных поз.
  const cPos = new THREE.Vector3(), cQ = new THREE.Quaternion(), cS = new THREE.Vector3();
  const aPos = new THREE.Vector3(), aQ = new THREE.Quaternion();
  const nrm = new THREE.Vector3(), toCam = new THREE.Vector3();
  let aS = 1, accepted = false, suspect = 0, agree = 1, fusedNow = false, badSince = null;
  // ---- Ориентация метки в «мире» (комнате) ----
  // Метка неподвижна (стол, монитор, стена), значит, её ориентация в комнате постоянна.
  // Гироскоп точно и без задержки знает, как повёрнут телефон; камера знает, как метка повёрнута
  // относительно телефона, но с шумом (особенно наклон и разворот). Поэтому:
  //   qMW — ориентация метки в мире, усредняем её по камере и гироскопу (медленно);
  //   поворот сцены в кадре = (поворот телефона по гироскопу)⁻¹ · qMW — без шума камеры.
  // Камера при этом медленно подправляет qMW (у гироскопа поворот вокруг вертикали «уплывает»).
  // Показания гироскопа берём в момент, когда распознаванию отдали кадр, — так нет отставания при движении.
  const WORLD_UP = new THREE.Vector3(0, 0, 1), Z = new THREE.Vector3(0, 0, 1);
  const qMW = new THREE.Quaternion(), qInst = new THREE.Quaternion(), qRecent = new THREE.Quaternion();
  const qWC = new THREE.Quaternion(), qWCframe = new THREE.Quaternion(), qTmp = new THREE.Quaternion();
  const nW = new THREE.Vector3();
  let haveMW = false, haveFrameQ = false, recentN = 0, markerTilt = 0, snapped = true;
  let bigSince = null, hardSince = null, softSince = null, lastRedetect = 0, devAvg = null;
  const redetects = [];
  const K = KMW;                          // скорость подстройки qMW по камере (0,03 ≈ 1 с при 30 кадрах/с)
  const SNAP = 6, SOFT = 5, HARD = 15, BIG = 40;
  // разложение поправки qInst·qMW⁻¹ на поворот вокруг оси метки (twist) и наклон оси (swing)
  const qDelta = new THREE.Quaternion(), qTwist = new THREE.Quaternion(), qSwing = new THREE.Quaternion(), qT2 = new THREE.Quaternion();
  const nAx = new THREE.Vector3();
  let twistAng = 0, swingAng = 0;
  function splitTwist() {
    qDelta.copy(qInst).multiply(qTmp.copy(qMW).invert());
    if (qDelta.w < 0) qDelta.set(-qDelta.x, -qDelta.y, -qDelta.z, -qDelta.w);
    nAx.copy(Z).applyQuaternion(qMW);                                    // ось метки в мире
    const p = qDelta.x * nAx.x + qDelta.y * nAx.y + qDelta.z * nAx.z;
    qTwist.set(nAx.x * p, nAx.y * p, nAx.z * p, qDelta.w);
    if (qTwist.lengthSq() < 1e-12) qTwist.identity(); else qTwist.normalize();
    qSwing.copy(qDelta).multiply(qTmp.copy(qTwist).invert());             // qDelta = qSwing · qTwist
    twistAng = 2 * Math.acos(Math.min(1, Math.abs(qTwist.w))) * 180 / Math.PI;
    swingAng = 2 * Math.acos(Math.min(1, Math.abs(qSwing.w))) * 180 / Math.PI;
  }
  const qAngle = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a.dot(b)))) * 180 / Math.PI;
  // Метка почти горизонтальна → считаем строго горизонтальной (стол). Убирает остаточный наклон.
  function snapHorizontal() {
    nW.copy(Z).applyQuaternion(qMW);
    markerTilt = nW.angleTo(WORLD_UP) * 180 / Math.PI;
    snapped = markerTilt < SNAP;
    if (snapped) qMW.premultiply(qTmp.setFromUnitVectors(nW, WORLD_UP));
  }
  function reanchor(why) {
    qMW.copy(recentN ? qRecent : qInst);
    snapHorizontal();
    redetects.length = 0; bigSince = hardSince = softSince = devAvg = null;
    console.log('[трекинг] ориентация метки:', snapped ? 'горизонтально' : 'наклон ' + markerTilt.toFixed(0) + '°', '—', why);
  }
  function redetect(now, dev, kind) {
    const ts0 = mindar.controller && mindar.controller.trackingStates[0];
    if (ts0) ts0.isTracking = false;                // MindAR на следующем кадре распознает метку с нуля
    if (hy) { hy.reset(); hyHoldUntil = now + 400; }
    lastRedetect = now; stats.redetect++; devAvg = null; recentN = 0;
    while (redetects.length && now - redetects[0].t > 12000) redetects.shift();
    redetects.push({ t: now, dev });
    console.log(`[трекинг] ${kind} перезахват: камера расходится с гироскопом на ${dev.toFixed(1)}°`);
  }
  // после перезахвата: если камера снова показывает то же самое — значит, метку правда переложили
  function afterRedetectCheck(dev) {
    const n = redetects.length;
    if (n >= 2 && Math.abs(redetects[n - 1].dev - dev) < 3 && recentN > 20) reanchor('перезахваты показывают одно и то же — метку переложили');
  }
  // фиксируем показания гироскопа в момент, когда распознаванию отдают кадр
  // Камера даёт новый кадр 30–60 раз в секунду, а трекер работает с частотой экрана и часто
  // обрабатывает тот же кадр повторно. Время кадра узнаём через requestVideoFrameCallback
  // (а где его нет — по video.currentTime); на повторном кадре время то же, и подсказка трекеру
  // и оценка скорости его не учитывают, а гироскоп берётся на момент появления кадра.
  let vfcT = 0, vfcN = 0, vfcVideo = null, lastFrameId = -1, newFrames = 0;
  // запасной режим без гироскопа: наклон метки на столе — по направлению «вверх» от акселерометра
  const upFrame = new THREE.Vector3(), qFixG = new THREE.Quaternion();
  let haveFrameUp = false, gSign = 1, gFlipVotes = 0, gAngAvg = null, gravMode = false;
  function hookVideoFrames() {
    const v = mindar.video;
    if (!v || vfcVideo === v || typeof v.requestVideoFrameCallback !== 'function') return;
    vfcVideo = v;
    const cb = (now) => { if (vfcVideo !== v) return; vfcT = now; vfcN++; v.requestVideoFrameCallback(cb); };
    v.requestVideoFrameCallback(cb);
  }
  function hookFrameImu() {
    hookVideoFrames();
    const ctrl = mindar.controller, loader = ctrl && ctrl.inputLoader;
    if (!loader || loader.__imuHooked) return;
    const orig = loader.loadInput.bind(loader);
    loader.loadInput = (input) => {
      const now = performance.now(), useVfc = vfcVideo === mindar.video && vfcN > 0;
      const id = useVfc ? vfcN : (mindar.video ? mindar.video.currentTime : 0);
      const isNew = id !== lastFrameId;
      if (isNew) { lastFrameId = id; newFrames++; frameT = useVfc ? vfcT : now; }
      // на повторном кадре гироскоп не перечитываем — картинка та же
      if (isNew) {
        if (imu && imu.fresh() && imu.hasAlpha) { imu.worldFromCamera(qWCframe, IMULAG + Math.max(0, now - frameT)); haveFrameQ = true; } else haveFrameQ = false;
        // нет ориентации (телефон без гироскопа) — хотя бы «вверх» по акселерометру
        haveFrameUp = !haveFrameQ && !!(imu && imu.gravFresh && imu.gravFresh());
        if (haveFrameUp) imu.gravityUp(upFrame, gSign);
      }
      frameUpdated = false; hySeedFrom = null;
      if (isNew && HYBRID) hybridFrame(); else if (!isNew) { hyValid = false; }
      if (PREDICT && !hyValid) predictPose();
      return orig(input);
    };
    loader.__imuHooked = true;
  }
  // ---- Гибрид: оптический поток в помощь MindAR (экспериментальная ветка) ----
  // На каждом новом кадре быстрый трекер (js/hybrid.js) следит за 30–60 точками метки и даёт её позу.
  //  • Эта поза — подсказка MindAR, откуда начинать поиск (вместо прогноза по скорости).
  //  • MindAR нашёл позу, а поток с ним сильно не согласен (MindAR «тащит» на смазе) — верим потоку.
  //  • MindAR на кадре сорвался — на экран идёт поза потока; MindAR потерял метку — сразу
  //    возвращаем его в режим слежения с позой потока, без долгого поиска с нуля.
  //  • Когда MindAR и поток согласны — точки потока периодически пересеваем по MindAR (убираем накопленный увод).
  const hy = HYBRID ? createHybrid() : null;
  const hyStats = { ms: 0, drive: 0, override: 0, revive: 0, diff: 0, sinceSeed: 0, disagree: 0 };
  let hyValid = false, hyH = null, hyM = null, hyDriving = false, hyShowUntil = -1e9, hyHoldUntil = -1e9, hySeedFrom = null;
  // Потоку без подтверждения MindAR верим недолго: он может «зацепиться» за фон и уверенно вести не туда.
  const HY_TRUST_MS = 700;
  let hyConfirmed = -1e9, hyRevived = false, hyReviveFails = 0;
  const hyM4 = new THREE.Matrix4();
  const P3 = () => mindar.controller.projectionTransform;
  // поза MindAR (3×4) → гомография «метка → вход»: H = P·[r1 r2 t]
  function MtoH(M) {
    const P = P3(), h = new Array(9);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      const c = j === 2 ? 3 : j;
      h[i * 3 + j] = P[i][0] * M[0][c] + P[i][1] * M[1][c] + P[i][2] * M[2][c];
    }
    return h;
  }
  // гомография → поза: [r1 r2 t] = λ·P⁻¹·H, поворот доводим до ортогонального
  function HtoM(h) {
    const P = P3();
    const a = P[0][0], b = P[0][1], c = P[0][2], d = P[1][0], e = P[1][1], f = P[1][2], g = P[2][0], k = P[2][1], l = P[2][2];
    const A = e * l - f * k, B = -(d * l - f * g), C = d * k - e * g, det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-12) return null;
    const Pi = [[A / det, -(b * l - c * k) / det, (b * f - c * e) / det], [B / det, (a * l - c * g) / det, -(a * f - c * d) / det], [C / det, -(a * k - b * g) / det, (a * e - b * d) / det]];
    const col = (j) => [0, 1, 2].map((i) => Pi[i][0] * h[j] + Pi[i][1] * h[3 + j] + Pi[i][2] * h[6 + j]);
    let r1 = col(0), r2 = col(1), t = col(2);
    const n1 = Math.hypot(...r1), n2 = Math.hypot(...r2);
    let lam = 2 / (n1 + n2);
    if (t[2] * lam < 0) lam = -lam;                                   // метка перед камерой
    r1 = r1.map((v) => v / n1 * Math.sign(lam)); r2 = r2.map((v) => v / n2 * Math.sign(lam)); t = t.map((v) => v * lam);
    // ортогонализация: биссектрисы
    const s = r1.map((v, i) => v + r2[i]), q = r1.map((v, i) => v - r2[i]);
    const ns = Math.hypot(...s), nq = Math.hypot(...q);
    const u = s.map((v) => v / ns), w = q.map((v) => v / nq);
    r1 = u.map((v, i) => (v + w[i]) / Math.SQRT2); r2 = u.map((v, i) => (v - w[i]) / Math.SQRT2);
    const r3 = [r1[1] * r2[2] - r1[2] * r2[1], r1[2] * r2[0] - r1[0] * r2[2], r1[0] * r2[1] - r1[1] * r2[0]];
    return [0, 1, 2].map((i) => [r1[i], r2[i], r3[i], t[i]]);
  }
  function setAnchorFromM(M) {
    hyM4.fromArray(mindar.controller._glModelViewMatrix(M, 0)).multiply(mindar.postMatrixs[0]);
    anchor.group.matrix.copy(hyM4);
  }
  const markerDims = () => mindar.controller.markerDimensions[0];
  // новый кадр: следим за точками; поза потока — подсказка MindAR
  function hybridFrame() {
    hyValid = false;
    const ctrl = mindar.controller, ts = ctrl && ctrl.trackingStates[0];
    if (!hy || !ts || frozen || videoRotated() || !ctrl.projectionTransform) return;
    const t0 = performance.now();
    hy.grab(mindar.video);
    const h = hy.track();
    hyStats.ms = hyStats.ms * 0.9 + (performance.now() - t0) * 0.1;
    hyStats.sinceSeed++;
    if (!h) return;
    const M = HtoM(h);
    if (!M) return;
    const now = performance.now();
    if (now - hyConfirmed > HY_TRUST_MS) { hy.reset(); return; }         // давно не подтверждён — не верим
    hyH = h; hyM = M; hyValid = true;
    hyRevived = false;
    if (ts.isTracking) ts.currentModelViewTransform = M.map((r) => r.slice());
    // MindAR потерял метку, а поток уверенно её держит — сразу в режим слежения, без поиска с нуля
    else if (hy.count >= 20 && hy.inlierRatio >= 0.7 && now > hyHoldUntil) {
      ts.currentModelViewTransform = M.map((r) => r.slice());
      ts.isTracking = true; hyRevived = true; hyStats.revive++;
    }
  }
  // MindAR дал позу: сверяем с потоком
  function hybridCheck(ts) {
    if (!ts || !ts.currentModelViewTransform || !mindar.controller.projectionTransform) return;
    const hm = MtoH(ts.currentModelViewTransform), [mw, mh] = markerDims();
    hyReviveFails = 0;
    if (!hyValid) { hySeedFrom = hm; hyConfirmed = performance.now(); return; }
    const d = hy.diff(hm, hyH, mw, mh);
    hyStats.diff = d;
    if (d > HYAGREE && hy.count >= 15 && hy.inlierRatio >= 0.7 && hyStats.disagree < 20) {
      // MindAR «тащит» (смаз) — берём позу потока; но если не согласны долго — прав MindAR
      hyStats.disagree++; hyStats.override++;
      ts.currentModelViewTransform = hyM.map((r) => r.slice());
      setAnchorFromM(hyM);
    } else {
      if (d <= HYAGREE) { hyStats.disagree = 0; hyConfirmed = performance.now(); }
      else { hy.reset(); hyStats.disagree = 0; hyConfirmed = performance.now(); }   // долгое несогласие: поток сбился — пересеем по MindAR
      hySeedFrom = hm;
    }
  }
  // кадр обработан: если MindAR позы не дал — показываем позу потока; при необходимости пересеваем точки
  function hybridAfter() {
    const now = performance.now();
    // «вернули» MindAR в слежение, а он метку по позе потока не нашёл — дважды подряд: поток сбился
    if (hyRevived) {
      const ts = mindar.controller.trackingStates[0];
      if (!ts.isTracking && ++hyReviveFails >= 2) { hy.reset(); hyHoldUntil = now + 1000; hyReviveFails = 0; hyValid = false; }
      hyRevived = false;
    }
    if (!frameUpdated && hyValid && !frozen && !jerkingNow()) {
      setAnchorFromM(hyM);
      hyDriving = true; hyShowUntil = now + 250;
      anchor.onTargetUpdate();
      hyDriving = false;
      if (frameUpdated) hyStats.drive++;
    }
    if (hySeedFrom && (hy.count < 32 || hyStats.sinceSeed > 45)) {
      const [mw, mh] = markerDims();
      if (hy.seed(hySeedFrom, mw, mh)) hyStats.sinceSeed = 0;
    }
  }

  // ---- Рывок ----
  // На резком рывке кадр смазан, и трекер часто «тащит» позу за телефоном — сцена улетает.
  // Акселерометр и гироскоп замечают рывок мгновенно: на это время камере не верим, сцену быстро
  // гасим, а когда рывок кончился — заставляем трекер найти метку заново, и сцена проявляется на месте.
  const JERK_HOLD = 150, JERK_FADE = 100;
  if (JERK && imu && imu.setJerk) imu.setJerk(JERKA, JERKW);
  let jerkWas = false;
  const jerkingNow = () => !!(JERK && imu && imu.lastJerkT !== undefined && performance.now() - imu.lastJerkT < JERK_HOLD);
  const stats = { rejected: 0, updates: 0, fused: 0, imuAngSum: 0, imuN: 0, redetect: 0, coast: 0, pred: 0, jerks: 0, get newFrames() { return newFrames; }, set newFrames(v) { newFrames = v; } };

  // ---- Подсказка трекеру: где метка окажется на следующем кадре ----
  // MindAR ищет каждую точку метки только в ±10 пикселях от того места, где она была на прошлом
  // кадре, и никак не предугадывает движение. Если телефон сдвинули быстрее — трекер не находит
  // точки, «цепляется» за старое место (сцена едет вместе с телефоном) и теряет метку.
  // Поэтому перед каждым кадром подставляем трекеру предсказанную позу:
  //   поворот телефона между кадрами — из гироскопа, сдвиг — с той скоростью, что была на прошлых кадрах.
  // Трекер затем уточняет позу по картинке как обычно — предсказание лишь ставит его поиск в нужное место.
  // Позы MindAR — в его осях камеры (x вправо, y вниз, z вперёд); наши (three.js) — x вправо, y вверх, z назад.
  const pr = { M: null, T: 0, q: new THREE.Quaternion(), hasQ: false, v: [0, 0, 0], vT: -1e9 };
  // скорость годится, если посчитана на прошлом кадре; при PREDICT=2 — и после короткой (<0,4 с) потери метки
  const vFresh = () => (PREDICT >= 2 ? frameT - pr.vT < 400 : pr.vT === pr.T);
  const qD = new THREE.Quaternion(), mD = new THREE.Matrix4(), Rcv = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const F = [1, -1, -1];
  // поворот камеры между кадрами в осях MindAR (по гироскопу); нет данных — без поворота
  function deltaRot(hasQ0, q0, hasQ1, q1) {
    if (!(hasQ0 && hasQ1)) { for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) Rcv[i][j] = i === j ? 1 : 0; return; }
    qD.copy(q1).invert().multiply(q0);                       // точки камеры прошлого кадра → этого
    const e = mD.makeRotationFromQuaternion(qD).elements;    // по столбцам
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) Rcv[i][j] = F[i] * F[j] * e[j * 4 + i];
  }
  function videoRotated() {
    const v = mindar.video, c = mindar.controller;
    return v && c && v.videoWidth === c.inputHeight && v.videoHeight === c.inputWidth && c.inputWidth !== c.inputHeight;
  }
  // после обработки кадра: запоминаем позу и оцениваем скорость сдвига
  function predictLearn() {
    const ts = mindar.controller && mindar.controller.trackingStates[0];
    if (!ts || !ts.isTracking || !ts.currentModelViewTransform || videoRotated()) { pr.M = null; return; }
    const M = ts.currentModelViewTransform, dt = frameT - pr.T;
    if (pr.M && dt > 5 && dt < 250) {
      deltaRot(pr.hasQ, pr.q, haveFrameQ, qWCframe);
      for (let i = 0; i < 3; i++) {
        const rotT = Rcv[i][0] * pr.M[0][3] + Rcv[i][1] * pr.M[1][3] + Rcv[i][2] * pr.M[2][3];
        const vi = (M[i][3] - rotT) / dt;                      // сдвиг, не объяснённый поворотом, за 1 мс
        pr.v[i] = vFresh() ? pr.v[i] + 0.5 * (vi - pr.v[i]) : vi;
      }
      pr.vT = frameT;
    }
    pr.M = M.map((r) => r.slice()); pr.T = frameT;
    pr.hasQ = haveFrameQ; if (haveFrameQ) pr.q.copy(qWCframe);
  }
  // перед обработкой кадра: подставляем трекеру предсказанную позу
  function predictPose() {
    const ts = mindar.controller && mindar.controller.trackingStates[0];
    if (!ts || !ts.isTracking || !pr.M || videoRotated()) return;
    const dt = frameT - pr.T;
    if (!(dt > 5 && dt < 250)) return;
    deltaRot(pr.hasQ, pr.q, haveFrameQ, qWCframe);
    const M = pr.M, out = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 4; j++)
      out[i][j] = Rcv[i][0] * M[0][j] + Rcv[i][1] * M[1][j] + Rcv[i][2] * M[2][j];
    if (vFresh()) {
      // сдвиг по экрану продолжаем почти полностью, по глубине (хуже измеряется) — осторожно;
      // и не больше трети расстояния до метки за кадр
      const dist = Math.hypot(out[0][3], out[1][3], out[2][3]);
      let sx = pr.v[0] * dt * 0.85, sy = pr.v[1] * dt * 0.85, sz = pr.v[2] * dt * 0.3;
      const len = Math.hypot(sx, sy, sz), cap = dist / 3;
      if (len > cap) { const k = cap / len; sx *= k; sy *= k; sz *= k; }
      out[0][3] += sx; out[1][3] += sy; out[2][3] += sz;
    }
    ts.currentModelViewTransform = out;
    stats.pred++;
  }

  // ---- Удержание сцены, когда камера на мгновение потеряла метку (смаз при резком движении) ----
  // Сцена в это время не стоит на месте экрана, а движется так, как двигалась бы метка:
  //  • поворот телефона берём из гироскопа (точно);
  //  • сдвиг телефона гироскоп не видит, поэтому продолжаем то движение метки «по комнате»,
  //    которое камера видела последние доли секунды (например, когда обходят метку по кругу).
  // Держим не дольше COAST_MS и только пока метка по расчёту остаётся в кадре.
  const COAST_MS = COAST;
  const qWCgood = new THREE.Quaternion(), qCW = new THREE.Quaternion(), proj = new THREE.Vector3();
  const uW = new THREE.Vector3(), uPrev = new THREE.Vector3(), vW = new THREE.Vector3(), vInst = new THREE.Vector3();
  const uStart = new THREE.Vector3(), uNow = new THREE.Vector3();
  let lastGood = -1e9, tGoodFrame = 0, tPrevFrame = 0, havePrev = false, frameUpdated = false, frameT = 0;
  let coasting = false, coastOk = false;
  const VMAX = 0.0025;                       // предел скорости метки «по комнате» для продолжения, рад/мс

  let frozen = false, frozenWant = false;
  anchor.onTargetUpdate = () => {
    if (frozen) return;                                     // «заморожено»: позу не трогаем
    if (jerkingNow()) return;                               // рывок: позам с камеры не верим
    if (!hyDriving) {                                       // (поза от гибрида проверки MindAR не проходит)
      if (!anchor.group.visible) { accepted = false; suspect = 0; return; }
      const ts = mindar.controller && mindar.controller.trackingStates[0];
      if (ts && !ts.isTracking) return;                     // трекер потерял метку и повторяет старую позу
      if (HYBRID) hybridCheck(ts);                          // MindAR нашёл позу — сверяем с оптическим потоком
    }
    stats.updates++;
    anchor.group.matrix.decompose(cPos, cQ, cS);
    const s = Math.cbrt(Math.abs(cS.x * cS.y * cS.z));
    nrm.set(0, 0, 1).applyQuaternion(cQ);

    let fused = false;
    if (USE_IMU && imu && haveFrameQ) {
      qWC.copy(qWCframe);
      qInst.copy(qWC).multiply(cQ);                                       // ориентация метки в мире по этому кадру
      if (!recentN) qRecent.copy(qInst); else qRecent.slerp(qInst, 0.1);
      recentN++;
      if (!haveMW) { qMW.copy(qInst); snapHorizontal(); haveMW = true;
        console.log('[трекинг] ориентация метки:', snapped ? 'горизонтально' : 'наклон ' + markerTilt.toFixed(0) + '°'); }
      // Поправка qMW → qInst раскладывается на две части:
      //  • поворот вокруг оси метки (метку крутят на столе) — камера видит его точно, догоняем быстро;
      //  • наклон оси метки — камера видит его с дрожью, подстраиваем медленно (K).
      // Расхождение для перезахватов считаем только по наклону: поворот листка — не ошибка трекера.
      splitTwist();
      const dev = swingAng;                                               // насколько камера не согласна с гироскопом
      stats.imuAngSum += dev; stats.imuN++;
      const now = performance.now();
      devAvg = devAvg === null ? dev : devAvg + 0.08 * (dev - devAvg);

      // согласны — подправляем ориентацию метки по камере (медленно)
      if (dev < HARD) {
        const kT = Math.min(1, 0.05 + twistAng / 5);                      // 0,5° (шум) → медленно, ≥ 5° → сразу
        qMW.premultiply(qT2.identity().slerp(qTwist, kT)).premultiply(qTmp.identity().slerp(qSwing, K));   // qDelta = qSwing·qTwist: сначала поворот вокруг оси
        snapHorizontal();
      }
      // > 40° больше секунды — метку явно переложили: берём новую ориентацию
      if (dev > BIG) {
        if (bigSince === null) bigSince = now;
        else if (now - bigSince > 1000) reanchor('метка расположена иначе, чем раньше');
      } else bigSince = null;
      // 15–40° держится 0,7 с — трекер, скорее всего, ошибся: заставляем найти метку заново
      if (dev > HARD && dev <= BIG) {
        if (hardSince === null) hardSince = now;
        else if (now - hardSince > 700 && now - lastRedetect > 700) { hardSince = null; redetect(now, dev, 'резкий'); }
      } else hardSince = null;
      // 5–15° держится 1,5 с — трекер «застрял» на небольшой ошибке: мягкий перезахват
      if (devAvg !== null && devAvg > SOFT && devAvg <= HARD && now - lastRedetect > 3000) {
        if (softSince === null) softSince = now;
        else if (now - softSince > 1500) { softSince = null; redetect(now, devAvg, 'мягкий'); }
      } else softSince = null;
      if (now - lastRedetect > 600 && now - lastRedetect < 2000 && redetects.length) afterRedetectCheck(dev);

      // поворот сцены — из гироскопа и усреднённой ориентации метки; положение остаётся от камеры
      if (dev <= BIG) {
        cQ.copy(qWC).invert().multiply(qMW);
        fused = true; stats.fused++;
      }
    }
    else if (USE_IMU && imu && haveFrameUp) {
      // Телефон без гироскопа. Метка лежит на столе → её ось должна смотреть вверх, а «вверх»
      // знает акселерометр. Наклон берём из него, поворот вокруг оси и положение — из камеры.
      gravMode = true;
      const ang = nrm.angleTo(upFrame) * 180 / Math.PI;
      // браузер с обратным знаком ускорения: метка «смотрит» строго вниз много кадров подряд → меняем знак
      if (ang > 150) { if (++gFlipVotes > 15) { gSign = -gSign; gFlipVotes = 0; gAngAvg = null; console.log('[датчики] знак акселерометра обратный — исправлено'); } }
      else gFlipVotes = 0;
      gAngAvg = gAngAvg === null ? ang : gAngAvg + 0.05 * (ang - gAngAvg);
      stats.imuAngSum += ang; stats.imuN++;
      if (gAngAvg < 25 && ang < 35) {                    // метка горизонтальна (стол), выброс камеры не больше 35°
        cQ.premultiply(qFixG.setFromUnitVectors(nrm, upFrame));
        fused = true; stats.fused++;
      }
    }
    if (!fused && !NOGUARD) {
      toCam.copy(cPos).negate().normalize();
      if (nrm.dot(toCam) < 0.15) { stats.rejected++; return; }   // метка «смотрит» от камеры
      if (accepted) {
        const ang = 2 * Math.acos(Math.min(1, Math.abs(aQ.dot(cQ)))) * 180 / Math.PI;
        const jump = cPos.distanceTo(aPos) / aS;
        if ((ang > JUMP || jump > 0.5) && suspect < 3) { suspect++; stats.rejected++; return; }
      }
    }
    const now = performance.now();
    if (fused) {
      // как метка движется «по комнате» (без учёта поворота телефона) — для продолжения при потере
      uW.copy(cPos).normalize().applyQuaternion(qWC);
      const dt = frameT - tPrevFrame;
      if (dt === 0) { /* повторный кадр — скорость не трогаем */ }
      else if (havePrev && dt > 5 && dt < 200) {
        vInst.copy(uW).sub(uPrev).divideScalar(dt);
        vW.lerp(vInst, 0.3);
        if (vW.length() > VMAX) vW.setLength(VMAX);
      } else vW.set(0, 0, 0);
      if (dt !== 0) { uPrev.copy(uW); tPrevFrame = frameT; havePrev = true; }
      qWCgood.copy(qWC); tGoodFrame = frameT;
    } else havePrev = false;
    coasting = false; coastOk = false;
    aPos.copy(cPos); aQ.copy(cQ);
    suspect = 0;
    fusedNow = fused;
    aS = s; accepted = true; lastGood = now; frameUpdated = true;
    if (SYNC) smoothPose(now);
  };

  // ---- 2. Сглаживание (One Euro) по отдельности для трёх величин ----
  //  направление на метку — камера определяет его очень точно, сглаживаем слабо;
  //  расстояние до метки — определяется хуже (отсюда «дыхание» размера), сглаживаем сильнее;
  //  поворот — слабо, если наклон из датчиков, и сильнее, если только по камере.
  // В каждом случае сглаживание ослабевает, пока телефон движется, — так нет запаздывания.
  const sDir = new THREE.Vector3(), tDir = new THREE.Vector3(), sQ = new THREE.Quaternion(), qInv = new THREE.Quaternion();
  const sPos = new THREE.Vector3(), sScale = new THREE.Vector3();
  let sDist = 1, sS = 1, ready = false, vdF = 0, vzF = 0, wF = 0, last = 0;
  const alpha = (fc, dt) => 1 / (1 + 1 / (2 * Math.PI * fc * dt));
  const angle = (u, v) => Math.acos(Math.max(-1, Math.min(1, u.dot(v))));
  function smoothPose(now) {
    if (frozen) return;
    if (!(accepted && (anchor.group.visible || now < hyShowUntil))) { if (!coastOk) ready = false; last = now; return; }
    const dist = aPos.length();
    tDir.copy(aPos).divideScalar(dist);
    if (!ready || RAW) {
      sDir.copy(tDir); sDist = dist; sQ.copy(aQ); sS = aS; vdF = vzF = wF = 0; ready = true;
    } else {
      const dt = Math.min(Math.max((now - last) / 1000, 0.001), 0.1);
      const rmc = RMC ?? (fusedNow ? 1.5 : 1), rb = RB ?? (fusedNow ? 3 : 1);
      vdF += alpha(DC, dt) * (angle(tDir, sDir) / dt - vdF);                    // рад/с
      vzF += alpha(DC, dt) * (Math.abs(dist - sDist) / sDist / dt - vzF);       // доля расстояния в секунду
      wF  += alpha(DC, dt) * (2 * Math.acos(Math.min(1, Math.abs(sQ.dot(aQ)))) / dt - wF);
      sDir.lerp(tDir, alpha(PMC + PB * vdF, dt)).normalize();
      const az = alpha(DMC + DB * vzF, dt);
      sDist += az * (dist - sDist);
      sS += az * (aS - sS);
      sQ.slerp(aQ, alpha(rmc + rb * wF, dt));
    }
    last = now;
    sPos.copy(sDir).multiplyScalar(sDist);
    content.matrix.compose(sPos, sQ, sScale.set(sS, sS, sS));
  }
  // Удержание: ставим сцену туда, где метка должна быть при ориентации телефона qWCnow в момент tNow.
  // Возвращает false, если удерживать нельзя (давно не было метки, нет датчиков, метка ушла из кадра).
  function coast(qWCnow, tNow) {
    // после COAST_MS сцена растворяется, но и во время растворения продолжает двигаться вместе с меткой
    const since = performance.now() - lastGood;
    if (!(fusedNow && ready && haveMW && imu && imu.fresh()) || since > COAST_MS + FADE_MS) return (coastOk = false);
    if (!coasting) { uStart.copy(sDir).applyQuaternion(qWCgood); coasting = true; }   // откуда продолжаем
    const d = Math.max(0, tNow - tGoodFrame);
    uNow.copy(vW).multiplyScalar(d).add(uStart).normalize();
    qCW.copy(qWCnow).invert();
    proj.copy(uNow).applyQuaternion(qCW).multiplyScalar(sDist);
    const p = proj.clone().project(camera);
    if (!(p.z < 1 && Math.abs(p.x) < 1.1 && Math.abs(p.y) < 1.1)) return (coastOk = false);
    sDir.copy(uNow).applyQuaternion(qCW);
    sQ.copy(qCW).multiply(qMW);
    sPos.copy(sDir).multiplyScalar(sDist);
    last = performance.now();
    content.matrix.compose(sPos, sQ, sScale.set(sS, sS, sS));
    stats.coast++;
    return (coastOk = since <= COAST_MS);
  }

  // ---- 3. Синхронизация видео с трекером ----
  let syncBg = null, syncTimer = null, syncCtx = null;
  function teardownSync() {
    clearInterval(syncTimer); syncTimer = null;
    if (syncBg) { syncBg.remove(); syncBg = null; }
  }
  function setupSync() {
    teardownSync();
    const v = mindar.video;
    const src = mindar.controller.inputLoader.context.canvas;
    const bg = syncBg = document.createElement('canvas');
    bg.width = src.width; bg.height = src.height;
    bg.style.position = 'absolute'; bg.style.zIndex = '-1';
    const bgCtx = syncCtx = bg.getContext('2d');
    v.parentNode.insertBefore(bg, v.nextSibling);
    v.style.opacity = '0';
    const syncStyle = () => {
      for (const k of ['top', 'left', 'width', 'height']) if (bg.style[k] !== v.style[k]) bg.style[k] = v.style[k];
    };
    syncStyle(); syncTimer = setInterval(syncStyle, 500);
    const ctrl = mindar.controller;
    const origUpdate = ctrl.onUpdate;
    ctrl.onUpdate = (data) => {
      if (data.type === 'processDone' && src.width === bg.width && !frozen) bgCtx.drawImage(src, 0, 0);
      origUpdate(data);
    };
  }

  // ---- 4. Плавное появление и исчезновение сцены (прозрачностью холста) ----
  const HOLD_MS = 250, FADE_MS = 300;
  let lostAt = null, fading = false;
  const canvas = renderer.domElement;
  canvas.style.transition = `opacity ${FADE_MS}ms ease`;
  function fadeTo(v, ms = FADE_MS) {
    canvas.style.transition = `opacity ${ms}ms ease`;
    canvas.style.opacity = String(v);
    fading = v === 0;
  }

  // ---- 5. Сторож: камера или распознавание могут «зависнуть» (iOS при сворачивании Safari
  // приостанавливает видео; при быстрой разморозке мог запуститься второй цикл обработки).
  // Если кадры перестали обрабатываться — перезапускаем; не помогло — просим перезагрузку.
  let lastProcessed = performance.now(), realProcessed = performance.now(), loopRuns = 0, restarting = false, stallReported = false;
  function countProcessed() {
    hookFrameImu();
    const ctrl = mindar.controller, orig = ctrl.onUpdate;
    ctrl.onUpdate = (data) => {
      if (data.type === 'processDone') {
        lastProcessed = realProcessed = performance.now(); loopRuns++;
        // кадр обработан, а позы нет (смаз, перезахват) — поворачиваем сцену по гироскопу этого кадра
        if (PREDICT) predictLearn();
        if (HYBRID) hybridAfter();
        if (SYNC && !frozen && !frameUpdated && haveFrameQ) coast(qWCframe, frameT);
      }
      orig(data);
    };
  }
  function restartProcessing() {
    if (restarting) return;
    restarting = true;
    const ctrl = mindar.controller;
    ctrl.stopProcessVideo();
    // ждём, пока прежний цикл завершит текущий кадр и выйдет (обновления прекратятся)
    const waitStart = performance.now();
    const check = () => {
      if (frozen || paused) { restarting = false; return; }
      if (performance.now() - lastProcessed > 250 || performance.now() - waitStart > 2000) {
        ctrl.processVideo(mindar.video);
        restarting = false;
        lastProcessed = performance.now();
      } else setTimeout(check, 60);
    };
    setTimeout(check, 60);
  }
  // ---- 6. Поворот телефона ----
  // iOS при повороте меняет ориентацию видео с камеры (480×640 ↔ 640×480), а MindAR настраивает
  // распознавание на размер кадра один раз при запуске — дальше кадры читаются с перекосом.
  // Если размер кадра изменился и держится, перезапускаем камеру и распознавание под новый размер.
  let arRestarting = false, dimsSince = null, paused = false, resumeTimer = null;
  // диагностика состояния камеры и графики — пишется в консоль
  function diag(when) {
    const v = mindar.video, tr = v && v.srcObject && v.srcObject.getVideoTracks()[0];
    console.log(`[диагностика: ${when}] видео ${v ? v.videoWidth + '×' + v.videoHeight : '—'}, ` +
      `пауза ${v ? v.paused : '—'}, готовность ${v ? v.readyState : '—'}, ` +
      `камера ${tr ? tr.readyState + (tr.muted ? ', muted' : '') + (tr.enabled ? '' : ', disabled') : '—'}, ` +
      `распознавание ${mindar.controller ? mindar.controller.inputWidth + '×' + mindar.controller.inputHeight : '—'}, ` +
      `потерь WebGL: ${window.__glLost || 0}`);
  }
  // потеря графического контекста — распознавание после неё само не оживёт
  window.addEventListener('gl-lost', () => {
    if (!mindar.controller) return;
    diag('потерян WebGL');
    onFatal && onFatal('потерян графический контекст');
  });
  function checkVideoSize() {
    const v = mindar.video, c = mindar.controller;
    if (arRestarting || frozen || paused || !v || !c || !v.videoWidth) { dimsSince = null; return; }
    if (v.videoWidth !== c.inputWidth || v.videoHeight !== c.inputHeight) {
      if (dimsSince === null) dimsSince = performance.now();
      else if (performance.now() - dimsSince > 600) {
        dimsSince = null;
        restartAR(`кадр ${c.inputWidth}×${c.inputHeight} → ${v.videoWidth}×${v.videoHeight}`);
      }
    } else dimsSince = null;
  }
  async function restartAR(reason) {
    if (hy) hy.reset();
    if (arRestarting) return;
    arRestarting = true;
    console.log('[камера] перезапуск:', reason);
    accepted = false; ready = false; badSince = bigSince = null;
    const old = mindar.controller;
    try { mindar.stop(); } catch (e) { console.warn('stop:', e); }
    try { old && old.worker && old.worker.terminate(); } catch (e) {}
    teardownSync();
    try {
      await mindar._startVideo();
      await mindar._startAR();
      if (SYNC) setupSync();
      countProcessed();
      lastProcessed = performance.now();
      console.log('[камера] готово, кадр', mindar.video.videoWidth + '×' + mindar.video.videoHeight);
      if (paused) mindar.controller.stopProcessVideo();     // пока перезапускались, телефон снова повернули
    } catch (e) {
      console.error('[камера] перезапуск не удался:', e);
      onStall && onStall();
    }
    arRestarting = false;
  }

  function startWatchdog() {
    countProcessed();
    let lastVideoTime = -1, videoStuckSince = null, stalls = 0;
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !frozen && !paused && !arRestarting) { mindar.video.play().catch(() => {}); lastProcessed = performance.now(); }
    });
    setInterval(checkVideoSize, 300);
    setInterval(() => {
      if (frozen || paused || document.hidden || arRestarting) { videoStuckSince = null; lastProcessed = performance.now(); return; }
      const v = mindar.video, now = performance.now();
      // видео стоит на месте?
      if (v.currentTime === lastVideoTime) {
        if (videoStuckSince === null) videoStuckSince = now;
        else if (now - videoStuckSince > 1500) { console.warn('[сторож] видео остановилось — запускаю снова'); v.play().catch(() => {}); }
      } else videoStuckSince = null;
      lastVideoTime = v.currentTime;
      // кадры не обрабатываются?
      if (!restarting && now - lastProcessed > 2500) {
        stalls++;
        console.warn('[сторож] распознавание не отвечает', Math.round(now - lastProcessed), 'мс — перезапуск №' + stalls);
        restartProcessing();
        if (stalls >= 3 && !stallReported) { stallReported = true; onStall && onStall(); }
      } else if (now - realProcessed < 500) stalls = 0;      // сбрасываем, только если кадры правда идут
    }, 1000);
  }

  return {
    mindar, renderer, scene, camera, content, stats, intrinsics,
    get agree() { return agree; },
    get debug() { return { ready, sinceGood: Math.round(performance.now() - lastGood), coasting, coastOk, v: +(vW.length() * 1000 * 57.3).toFixed(1) }; },
    async start() {
      mindar.ui.showLoading();
      let t = performance.now();
      await mindar._startVideo();
      const v = mindar.video;
      console.log('[2] Камера включена за', Math.round(performance.now() - t), 'мс, разрешение', v.videoWidth + '×' + v.videoHeight);
      t = performance.now();
      await mindar._startAR();
      console.log('[3] Трекер готов за', Math.round(performance.now() - t), 'мс');
      if (SYNC) setupSync();
      if (imu) imu.start();
      startWatchdog();
      return v;
    },
    // вызывать каждый кадр перед отрисовкой
    frame(now) {
      if (!SYNC) smoothPose(now);
      // Если распознавание не выдаёт кадров (пауза, запуск после поворота, перезапуск),
      // показываем живое видео, чтобы картинка с камеры не замирала. При заморозке — не трогаем.
      if (SYNC && syncBg && syncCtx && !frozen && now - realProcessed > 150) {
        const v = mindar.video;
        if (v && v.readyState >= 2 && v.videoWidth) {
          if (syncBg.width !== v.videoWidth || syncBg.height !== v.videoHeight) { syncBg.width = v.videoWidth; syncBg.height = v.videoHeight; }
          syncCtx.drawImage(v, 0, 0, syncBg.width, syncBg.height);
        }
      }
      // рывок: быстро гасим; кончился — трекер ищет метку заново, сцена появится уже на новом месте
      const jerking = !frozen && jerkingNow();
      if (jerking && !jerkWas) {
        jerkWas = true; stats.jerks++;
        coasting = false; coastOk = false; lastGood = -1e9;
        if (content.visible) { lostAt = now - HOLD_MS; fadeTo(0, JERK_FADE); }
      } else if (!jerking && jerkWas) {
        jerkWas = false;
        const ts0 = mindar.controller && mindar.controller.trackingStates[0];
        if (ts0) ts0.isTracking = false;
        accepted = false; ready = false; pr.M = null;
        if (hy) hy.reset();
      }
      const want = jerking ? false : frozen ? frozenWant : ((anchor.group.visible && accepted) || (HYBRID && accepted && now < hyShowUntil) || (coastOk && now - lastGood < COAST_MS));
      // Плавность: при потере метки сцена ещё ~0,25 с стоит на месте (короткие пропуски
      // незаметны), потом за 0,3 с растворяется; при нахождении — быстро проявляется.
      if (want) {
        lostAt = null;
        if (!content.visible || fading) { content.visible = true; fadeTo(1); }   // в т.ч. если нашлась посреди растворения
      } else if (content.visible) {
        if (lostAt === null) lostAt = coasting ? now - HOLD_MS : now;   // после удержания — сразу растворяем
        if (now - lostAt > HOLD_MS && !fading) fadeTo(0);
        if (now - lostAt > HOLD_MS + FADE_MS) content.visible = false;
      }
    },
    get shown() { return content.visible && !fading; },
    get restarting() { return arRestarting; },
    // Пауза распознавания (телефон повёрнут горизонтально). Камера продолжает работать,
    // поэтому после возврата в вертикальное положение всё продолжается сразу, без перезапуска.
    setPaused(on) {
      if (on === paused) return;
      // заморозку при повороте снимаем: после поворота меняется кадр камеры, и «замороженный»
      // снимок всё равно не совпал бы с экраном (раньше камера после этого не оживала)
      if (on && frozen) { paused = true; this.setFrozen(false); console.log('[экран] поворот — заморозка снята'); }
      paused = on;
      clearTimeout(resumeTimer);
      if (on) {
        if (!arRestarting && mindar.controller) mindar.controller.stopProcessVideo();
        accepted = false; ready = false;
        return;
      }
      // Возврат в вертикальное положение. Ждём, пока iOS закончит поворот, поправляем раскладку
      // и продолжаем. Дальше проверяем, ожило ли распознавание: если нет — перезапускаем камеру,
      // а если и это не помогло — сообщаем наружу (страницу придётся перезагрузить).
      lastProcessed = performance.now();
      resumeTimer = setTimeout(async () => {
        if (paused || frozen) return;
        try { mindar.resize(); } catch (e) {}
        diag('после поворота');
        const t0 = performance.now();
        if (!arRestarting) {
          const v = mindar.video, c = mindar.controller;
          if (v && c && v.videoWidth === c.inputWidth && v.videoHeight === c.inputHeight) restartProcessing();
        }
        resumeTimer = setTimeout(async () => {
          if (paused || frozen || realProcessed > t0) return;          // кадры пошли — всё хорошо
          console.warn('[камера] после поворота распознавание не ожило — перезапуск камеры');
          await restartAR('после поворота');
          const t1 = performance.now();
          resumeTimer = setTimeout(() => {
            if (paused || frozen || realProcessed > t1) return;
            diag('не помог перезапуск');
            onFatal && onFatal('после поворота распознавание не восстановилось');
          }, 3500);
        }, 2500);
      }, 250);
    },
    get markerState() {
      if (!haveMW) return gravMode ? (gAngAvg !== null && gAngAvg < 25 ? 'горизонтально (акселерометр)' : 'не на столе — только камера') : '—';
      if (bigSince !== null) return 'перенастройка';
      return snapped ? 'горизонтально' : 'наклон ' + markerTilt.toFixed(0) + '°';
    },
    // направление «вверх» (против силы тяжести) в координатах сцены метки; false — датчиков нет
    gravityInContent(out) {
      if (!(USE_IMU && imu)) return false;
      if (imu.fresh()) {
        // ориентация метки в комнате уже усреднена — «вверх» в сцене постоянен и не дрожит
        if (haveMW && fusedNow) return out.copy(WORLD_UP).applyQuaternion(qInv.copy(qMW).invert()).normalize();
        imu.upCamera(out);
      } else if (imu.gravFresh && imu.gravFresh()) imu.gravityUp(out, gSign);
      else return false;
      return out.applyQuaternion(qInv.copy(sQ).invert()).normalize();
    },
    get frozen() { return frozen; },
    get loops() { return loopRuns; },
    get hybrid() { return hy ? { on: true, pts: hy.count, ms: hyStats.ms, drive: hyStats.drive, override: hyStats.override, revive: hyStats.revive, diff: hyStats.diff, seeds: hy.stats.seeds } : { on: false }; },
    // Лёгкий режим для слабых телефонов: камера 30 кадров/с (слабый трекер больше не успевает).
    // Чёткость рендера НЕ понижаем: на старом Android (трекер 15 Гц) это не ускорило трекер —
    // он упирается в процессор, а не в видеокарту, — а картинка становилась мыльной.
    setLite(on) {
      const v = mindar.video, trk = v && v.srcObject && v.srcObject.getVideoTracks()[0];
      const fps = on ? 30 : CAMFPS;
      if (trk && trk.applyConstraints && fps) trk.applyConstraints({ width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: fps } }).catch((e) => console.warn('[камера] не удалось сменить частоту:', e));
    },
    // «Заморозить»: останавливаем и картинку с камеры, и позу — можно опустить телефон и спокойно тапать
    setFrozen(on) {
      if (on === frozen || arRestarting) return;
      frozen = on;
      frozenWant = on && content.visible;
      const ctrl = mindar.controller;
      if (on) {
        if (!SYNC) mindar.video.pause();
        ctrl.stopProcessVideo();
      } else {
        if (!SYNC) mindar.video.play();
        restartProcessing();
        accepted = false; ready = false;          // после разморозки ищем метку заново
      }
    },
  };
}
