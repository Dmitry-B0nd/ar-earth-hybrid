// Гибридный трекер: быстрое слежение за точками метки оптическим потоком (Lucas-Kanade).
//
// MindAR на каждом кадре ищет точки метки лишь в ±10 пикселях от прошлого места, поэтому
// срывается на быстрых движениях, и он тяжёлый. Здесь — классический лёгкий способ:
//   • берём 30–60 заметных точек (углов) на метке, их координаты на самой метке знаем по позе MindAR;
//   • на каждом новом кадре находим, куда сдвинулась каждая точка, — сначала на уменьшенной
//     копии кадра (там даже большой рывок — несколько пикселей), потом уточняем на полной;
//   • по сдвинувшимся точкам считаем, как метка видна в кадре (гомография), с отсевом сбившихся точек.
// Модуль ничего не знает про MindAR: на вход — кадр видео и (для посева) гомография метки,
// на выход — гомография «метка → кадр» в координатах входа MindAR (полный размер видео).
import jsfeat from './vendor/jsfeat.mjs';

const U8 = jsfeat.U8_t | jsfeat.C1_t;

export function createHybrid({ scale = 0.5, levels = 4, win = 13, maxPts = 64, minPts = 12, ransacPx = 2.5 } = {}) {
  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  let W = 0, H = 0, prev = null, curr = null, hasPrev = false;
  let n = 0, inlierRatio = 0;
  const xyPrev = new Float32Array(maxPts * 2), xyCurr = new Float32Array(maxPts * 2), status = new Uint8Array(maxPts);
  const mk = new Float32Array(maxPts * 2);                      // координаты точек на метке
  const corners = Array.from({ length: 3000 }, () => new jsfeat.keypoint_t());
  const Hm = new jsfeat.matrix_t(3, 3, jsfeat.F32_t | jsfeat.C1_t);
  const homo = new jsfeat.motion_model.homography2d();
  const rp = new jsfeat.ransac_params_t(4, ransacPx, 0.5, 0.995);
  const mask = new jsfeat.matrix_t(maxPts, 1, U8);
  const from = Array.from({ length: maxPts }, () => ({ x: 0, y: 0 }));
  const to = Array.from({ length: maxPts }, () => ({ x: 0, y: 0 }));
  const stats = { ms: 0, seeds: 0, lost: 0 };

  function alloc(w, h) {
    W = w; H = h; cv.width = w; cv.height = h;
    const a = new jsfeat.pyramid_t(levels), b = new jsfeat.pyramid_t(levels);
    a.allocate(w, h, U8); b.allocate(w, h, U8);
    prev = a; curr = b; hasPrev = false; n = 0;
  }

  // гомография 3×3 (по строкам) применить к точке
  const apply = (h, x, y) => { const z = h[6] * x + h[7] * y + h[8]; return [(h[0] * x + h[1] * y + h[2]) / z, (h[3] * x + h[4] * y + h[5]) / z]; };
  function inv3(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-12) return null;
    return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
  }
  // гомография: координаты входа MindAR ↔ уменьшенного кадра
  const toLk = (h) => [h[0] * scale, h[1] * scale, h[2] * scale, h[3] * scale, h[4] * scale, h[5] * scale, h[6], h[7], h[8]];
  const toIn = (h) => [h[0] / scale, h[1] / scale, h[2] / scale, h[3] / scale, h[4] / scale, h[5] / scale, h[6], h[7], h[8]];

  // точка внутри выпуклого четырёхугольника
  function inQuad(q, x, y) {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const [x1, y1] = q[i], [x2, y2] = q[(i + 1) % 4];
      const c = (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1);
      if (c !== 0) { if (sign === 0) sign = Math.sign(c); else if (Math.sign(c) !== sign) return false; }
    }
    return true;
  }

  return {
    stats,
    get count() { return n; },
    get inlierRatio() { return inlierRatio; },
    get size() { return [W, H]; },
    reset() { n = 0; },

    // Новый кадр камеры: в оттенки серого, уменьшить, построить пирамиду уменьшенных копий.
    grab(video) {
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh) return false;
      const w = Math.round(vw * scale), h = Math.round(vh * scale);
      if (w !== W || h !== H) alloc(w, h);
      const t = prev; prev = curr; curr = t;
      ctx.drawImage(video, 0, 0, w, h);
      jsfeat.imgproc.grayscale(ctx.getImageData(0, 0, w, h).data, w, h, curr.data[0]);
      curr.build(curr.data[0], true);
      const had = hasPrev; hasPrev = true;
      return had;
    },

    // Следим за точками с прошлого кадра на новый. Возвращает гомографию «метка → вход MindAR» или null.
    track() {
      const t0 = performance.now();
      if (!hasPrev || n < minPts) { n = 0; return null; }
      xyPrev.set(xyCurr.subarray(0, n * 2));
      jsfeat.optical_flow_lk.track(prev, curr, xyPrev, xyCurr, n, win, 20, status, 0.02, 0.0005);
      let k = 0;
      for (let i = 0; i < n; i++) {
        const x = xyCurr[i * 2], y = xyCurr[i * 2 + 1];
        if (!status[i] || x < 2 || y < 2 || x > W - 3 || y > H - 3) continue;
        xyCurr[k * 2] = x; xyCurr[k * 2 + 1] = y; mk[k * 2] = mk[i * 2]; mk[k * 2 + 1] = mk[i * 2 + 1]; k++;
      }
      const tracked = k;
      if (k < minPts) { n = 0; stats.lost++; stats.ms = performance.now() - t0; return null; }
      for (let i = 0; i < k; i++) { from[i].x = mk[i * 2]; from[i].y = mk[i * 2 + 1]; to[i].x = xyCurr[i * 2]; to[i].y = xyCurr[i * 2 + 1]; }
      if (!jsfeat.motion_estimator.ransac(rp, homo, from, to, k, Hm, mask, 200)) { n = 0; stats.lost++; stats.ms = performance.now() - t0; return null; }
      // выбрасываем сбившиеся точки и уточняем гомографию по оставшимся
      let m = 0;
      for (let i = 0; i < k; i++) {
        if (!mask.data[i]) continue;
        xyCurr[m * 2] = xyCurr[i * 2]; xyCurr[m * 2 + 1] = xyCurr[i * 2 + 1]; mk[m * 2] = mk[i * 2]; mk[m * 2 + 1] = mk[i * 2 + 1];
        from[m].x = mk[m * 2]; from[m].y = mk[m * 2 + 1]; to[m].x = xyCurr[m * 2]; to[m].y = xyCurr[m * 2 + 1]; m++;
      }
      n = m; inlierRatio = m / tracked;
      if (m < minPts || inlierRatio < 0.5) { n = 0; stats.lost++; stats.ms = performance.now() - t0; return null; }
      homo.run(from, to, Hm, m);
      const d = Hm.data, h = [d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[7], d[8]];
      stats.ms = performance.now() - t0;
      return toIn(h);
    },

    // Посев точек: углы на текущем кадре внутри метки; их координаты на метке — по гомографии MindAR.
    seed(hIn, markerW, markerH) {
      if (!curr) return 0;
      const h = toLk(hIn), hi = inv3(h);
      if (!hi) return 0;
      const s = 0.03;                                            // поля внутри метки (край часто смазан)
      const quad = [[markerW * s, markerH * s], [markerW * (1 - s), markerH * s], [markerW * (1 - s), markerH * (1 - s)], [markerW * s, markerH * (1 - s)]].map(([x, y]) => apply(h, x, y));
      const img = curr.data[0];
      jsfeat.yape06.laplacian_threshold = 20; jsfeat.yape06.min_eigen_value_threshold = 20;
      const cnt = jsfeat.yape06.detect(img, corners, 8);
      // равномерно по метке: сетка 8×8, в каждой клетке — сильнейший угол, потом лучшие по силе
      const G = 8, cells = new Map();
      for (let i = 0; i < cnt; i++) {
        const c = corners[i];
        if (!inQuad(quad, c.x, c.y)) continue;
        const [mx, my] = apply(hi, c.x, c.y);
        const key = Math.min(G - 1, Math.max(0, Math.floor(mx / markerW * G))) * G + Math.min(G - 1, Math.max(0, Math.floor(my / markerH * G)));
        const best = cells.get(key);
        if (!best || c.score > best.score) cells.set(key, { x: c.x, y: c.y, mx, my, score: c.score });
      }
      const pick = [...cells.values()].sort((a, b) => b.score - a.score).slice(0, maxPts);
      if (pick.length < minPts) return 0;
      n = pick.length;
      pick.forEach((p, i) => { xyCurr[i * 2] = p.x; xyCurr[i * 2 + 1] = p.y; mk[i * 2] = p.mx; mk[i * 2 + 1] = p.my; });
      stats.seeds++; inlierRatio = 1;
      return n;
    },

    // Насколько две гомографии расходятся: среднее расстояние (в пикселях входа) по углам и центру метки
    diff(h1, h2, markerW, markerH) {
      const pts = [[0, 0], [markerW, 0], [markerW, markerH], [0, markerH], [markerW / 2, markerH / 2]];
      let s = 0;
      for (const [x, y] of pts) { const a = apply(h1, x, y), b = apply(h2, x, y); s += Math.hypot(a[0] - b[0], a[1] - b[1]); }
      return s / pts.length;
    },
  };
}
