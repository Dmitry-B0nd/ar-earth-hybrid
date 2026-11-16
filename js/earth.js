// Земля: дневная поверхность, ночные огни, блики океана, облака, свечение атмосферы.
import * as THREE from 'three';
import { gmst, sunDirectionEci } from './astro.js';

const earthVertex = /* glsl */`
  varying vec2 vUv;
  varying vec3 vN;   // нормаль в мировых координатах
  varying vec3 vV;   // направление на камеру
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vN = normalize(mat3(modelMatrix) * normal);
    vV = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;

const earthFragment = /* glsl */`
  uniform sampler2D uDay, uLights, uWater;
  uniform vec3 uSun;          // направление на Солнце (мировые координаты)
  varying vec2 vUv; varying vec3 vN; varying vec3 vV;
  void main() {
    vec3 N = normalize(vN), V = normalize(vV), S = normalize(uSun);
    float d = dot(N, S);                                  // >0 день, <0 ночь
    float dayK = smoothstep(-0.12, 0.18, d);              // мягкий терминатор (сумерки)
    vec3 day = texture2D(uDay, vUv).rgb;
    float lights = texture2D(uLights, vUv).r;
    float water = texture2D(uWater, vUv).r;
    vec3 col = day * (0.06 + 0.94 * clamp(d * 1.25 + 0.1, 0.0, 1.0));
    // ночь: едва заметные очертания материков + тёплые огни городов
    vec3 night = day * vec3(0.09, 0.11, 0.17) + vec3(1.0, 0.72, 0.38) * lights * 1.25;
    col = mix(night, col, dayK);
    // блик Солнца на воде
    vec3 H = normalize(S + V);
    float spec = pow(max(dot(N, H), 0.0), 45.0) * water * dayK;
    col += vec3(1.0, 0.94, 0.82) * spec * 0.55;
    // голубая дымка у края диска (атмосфера на просвет)
    float fr = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    col += vec3(0.32, 0.58, 1.0) * fr * (0.04 + 0.96 * smoothstep(-0.2, 0.5, d)) * 0.8;
    gl_FragColor = vec4(col, 1.0);
  }`;

const cloudsFragment = /* glsl */`
  uniform sampler2D uClouds;
  uniform vec3 uSun;
  varying vec2 vUv; varying vec3 vN; varying vec3 vV;
  void main() {
    vec3 N = normalize(vN);
    float d = dot(N, normalize(uSun));
    float a = texture2D(uClouds, vUv).r;
    float light = 0.04 + 0.96 * smoothstep(-0.15, 0.3, d);
    gl_FragColor = vec4(vec3(light), a * 0.92);
  }`;

const atmoFragment = /* glsl */`
  uniform vec3 uSun;
  uniform float uLimb;        // значение -dot(N,V) на краю Земли
  varying vec2 vUv; varying vec3 vN; varying vec3 vV;
  void main() {
    vec3 N = normalize(vN), V = normalize(vV);
    float k = -dot(N, V);                                 // 0 на внешнем краю свечения
    float glow = pow(clamp(k / uLimb, 0.0, 1.0), 3.0);
    // освещённость берём для точки на краю диска (а не для задней стороны сферы)
    vec3 Nl = normalize(N + k * V);
    float lit = 0.06 + 0.94 * smoothstep(-0.25, 0.4, dot(Nl, normalize(uSun)));
    vec3 c = vec3(0.30, 0.56, 1.0) * glow * lit * 0.85;
    gl_FragColor = vec4(c, max(c.r, max(c.g, c.b)));
  }`;

export async function loadEarthTextures(base, onProgress) {
  const loader = new THREE.TextureLoader();
  const names = { day: 'earth_day_4k.jpg', lights: 'earth_lights_4k.jpg', clouds: 'earth_clouds_2k.jpg', water: 'earth_water_1k.jpg' };
  const out = {};
  await Promise.all(Object.entries(names).map(async ([key, file]) => {
    out[key] = await loader.loadAsync(base + file);
    onProgress && onProgress(key);
  }));
  return out;
}

export function createEarth({ radius = 0.3, textures, renderer }) {
  const maxAniso = renderer ? renderer.capabilities.getMaxAnisotropy() : 1;
  for (const t of Object.values(textures)) { t.anisotropy = Math.min(8, maxAniso); t.needsUpdate = true; }

  const eci = new THREE.Group();        // ECI: Z — ось Земли
  const ecef = new THREE.Group();       // крутится вместе с Землёй
  eci.add(ecef);

  // Сфера three.js: полюс по оси Y. Поворот на +90° вокруг X ставит полюс на Z,
  // а нулевой меридиан — на +X, как в ECEF.
  const geo = new THREE.SphereGeometry(radius, 128, 64);
  const sunUniform = { value: new THREE.Vector3(1, 0, 0) };

  const earth = new THREE.Mesh(geo, new THREE.ShaderMaterial({
    vertexShader: earthVertex, fragmentShader: earthFragment,
    uniforms: { uDay: { value: textures.day }, uLights: { value: textures.lights }, uWater: { value: textures.water }, uSun: sunUniform },
  }));
  earth.rotation.x = Math.PI / 2;
  ecef.add(earth);

  const cloudsPivot = new THREE.Group();   // облака медленно дрейфуют относительно поверхности
  ecef.add(cloudsPivot);
  const clouds = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.008, 128, 64), new THREE.ShaderMaterial({
    vertexShader: earthVertex, fragmentShader: cloudsFragment,
    uniforms: { uClouds: { value: textures.clouds }, uSun: sunUniform },
    transparent: true, depthWrite: false,
  }));
  clouds.rotation.x = Math.PI / 2;
  cloudsPivot.add(clouds);

  const ATMO = 1.12;
  const atmo = new THREE.Mesh(new THREE.SphereGeometry(radius * ATMO, 96, 48), new THREE.ShaderMaterial({
    vertexShader: earthVertex, fragmentShader: atmoFragment,
    uniforms: { uSun: sunUniform, uLimb: { value: Math.sqrt(1 - 1 / (ATMO * ATMO)) } },
    side: THREE.BackSide, transparent: true, depthWrite: false,
    // Свечение — полупрозрачная голубая дымка поверх видео (альфа = яркость свечения).
    // Обычное аддитивное смешивание делало холст вокруг Земли непрозрачным —
    // поверх видео получалось чёрное кольцо.
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  }));
  eci.add(atmo);

  const sunEci = new THREE.Vector3();
  return {
    group: eci,
    sunWorld: sunUniform.value,   // направление на Солнце в мировых координатах
    ecef,          // сюда кладём всё, что «приклеено» к поверхности (точки интереса)
    radius,
    // лёгкий режим: облака оставляем (их выключение не помогло трекеру, а картинка беднее)
    setLite(on) {},
    // date — симулируемое время (Date)
    update(date) {
      ecef.rotation.z = gmst(date);
      const days = date.getTime() / 86400000;
      cloudsPivot.rotation.z = (days * 2 * Math.PI / 25) % (2 * Math.PI);   // облака: +1 оборот за ~25 суток
      const [x, y, z] = sunDirectionEci(date);
      eci.updateWorldMatrix(true, true);
      sunUniform.value.copy(sunEci.set(x, y, z)).transformDirection(eci.matrixWorld);
    },
  };
}
