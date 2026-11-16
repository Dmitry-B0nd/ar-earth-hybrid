// Резервный режим без камеры: обычная 3D-сцена, Землю можно вращать и приближать пальцами.
// Наружу отдаёт то же, что трекер (renderer, scene, camera, content, frame), поэтому остальной
// код (Земля, спутники, точки, карточки) работает одинаково в обоих режимах.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export function createViewer3D({ container }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x03060f, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);
  Object.assign(renderer.domElement.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', touchAction: 'none' });

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 200);
  camera.position.set(0, 0.6, 3.2);

  // content — как «метка»: единицы — ширина метки, ось Z — «вверх» от метки.
  // Поворачиваем так, чтобы ось Земли смотрела вверх по экрану, а центр Земли был в начале координат.
  const content = new THREE.Group();
  content.rotation.x = -Math.PI / 2;
  scene.add(content);

  // звёздный фон
  const N = 1500, pts = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(60 + Math.random() * 40);
    pts.set([v.x, v.y, v.z], i * 3);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
  scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xaab4cc, size: 1.5, sizeAttenuation: false })));

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.minDistance = 0.9;
  controls.maxDistance = 7;
  controls.rotateSpeed = 0.6;
  controls.zoomSpeed = 0.8;

  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  window.addEventListener('resize', resize);

  return {
    mode: '3d', renderer, scene, camera, content, controls,
    // центр Земли в content задаётся снаружи (высота над «меткой»), здесь подстраиваем точку вращения
    setTarget(heightAboveMarker) {
      content.position.set(0, -heightAboveMarker, 0);   // после поворота ось Z content смотрит вверх (Y)
      controls.target.set(0, 0, 0);
      controls.update();
    },
    shown: true,
    frame() { controls.update(); },
  };
}
