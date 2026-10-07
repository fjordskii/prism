// fig. 1 — the hero prism, rendered with three.js.
//
// White light enters the left face and each band is traced through the glass with Snell's law.
// Band IORs are solved so the exit beams land in an evenly spaced column, and each segment label
// sits at the end of its own beam at every viewport size; there is no separate legend. The bench
// is fitted into the `.prism-frame` box, so CSS decides where the prism sits in the hero.
// Particles are visitors: white on the way in, coloured once the prism has routed them, slowed
// inside the glass by 1/n. Progressive enhancement: the static SVG stays in the markup and is
// shown whenever this module fails to load or WebGL2 is unavailable.

import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

const V2 = THREE.Vector2;
const rad = THREE.MathUtils.degToRad;
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const ease = (x) => 1 - (1 - x) ** 3;
const smooth = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// ---------- optics (world units; every beam lies in the z = 0 plane) ----------
const SIDE = 2.2;
const DEPTH = 1.5;
const H = (SIDE * Math.sqrt(3)) / 2;
const APEX = new V2(0, (2 * H) / 3); // centroid at the origin
const BASE_L = new V2(-SIDE / 2, -H / 3);
const BASE_R = new V2(SIDE / 2, -H / 3);
const N_ENTRY = new V2(-H, SIDE / 2).normalize(); // outward normal of the left face
const N_EXIT = new V2(H, SIDE / 2).normalize(); // outward normal of the right face
const ENTRY = BASE_L.clone().lerp(APEX, 0.4);
const IN_DIR = new V2(Math.cos(rad(19.5)), Math.sin(rad(19.5))); // ~minimum deviation
const IN_LEN = 11; // the white beam starts well off-canvas
const BEAM_START = ENTRY.clone().addScaledVector(IN_DIR, -IN_LEN);
const X_END = 3.8; // every band terminates on this vertical line
const RED_IOR = 1.47;
const BAND_GAP = 0.6; // vertical spacing of band ends: the label rhythm (wide enough for phones)
const FIT_X0 = -1.6; // the bench fitted into the frame starts on the white beam just left of the prism
const IN_FADE = [3.6, 1.2]; // the white beam fades in from darkness between these distances before the prism

// ---------- presentation ----------
const FOV = 24;
const BASE_YAW = -0.38; // camera sits left of the beam so the entry face reads in 3D
const BASE_PITCH = 0.2;
const LABEL_GAP = 14; // px between band end and its label
const MIN_LABEL_GAP = 17; // px between band ends below which only the latest hit label shows
const MAX_PIXELS = 2.4e6; // drawing-buffer budget: full-bleed canvases drop DPR instead of stalling
const SPEED = 2.7; // visitor speed in air, world units / s
const POOL = 72;

/**
 * NeutralToneMapping subtracts a toe offset driven by the darkest channel, which crushes the page's
 * --ink to near black and leaves a seam where the canvas meets CSS. Invert that toe for dark greys
 * (offset = x - 6.25x² below 0.08, else 0.04) so the room renders as exactly the CSS colour.
 */
function preToneMap(c) {
  const m = Math.min(c.r, c.g, c.b);
  const off = m < 0.04 ? 0.4 * Math.sqrt(m) - m : 0.04;
  return new THREE.Color(c.r + off, c.g + off, c.b + off);
}

/** Refract unit vector `d` through a surface with unit normal `n` facing against `d`; null on TIR. */
function refract(d, n, eta) {
  const cos = -d.dot(n);
  const k = 1 - eta * eta * (1 - cos * cos);
  if (k < 0) return null;
  return d.clone().multiplyScalar(eta).addScaledVector(n, eta * cos - Math.sqrt(k));
}

function hitLine(p, d, a, b) {
  const e = b.clone().sub(a);
  return p.clone().addScaledVector(d, a.clone().sub(p).cross(e) / d.cross(e));
}

/** Trace one band through the prism; null when it is totally internally reflected at the exit face. */
function traceBand(ior) {
  const inside = refract(IN_DIR, N_ENTRY, 1 / ior);
  const exit = hitLine(ENTRY, inside, BASE_R, APEX);
  const out = refract(inside, N_EXIT.clone().negate(), ior);
  if (!out) return null;
  const end = exit.clone().addScaledVector(out, (X_END - exit.x) / out.x);
  return { ior, exit, end };
}

/** Bisect for the IOR whose exit beam lands at height `y` on X_END (higher n bends further down). */
function solveIor(y) {
  let lo = 1.3;
  let hi = 1.8;
  for (let k = 0; k < 48; k++) {
    const m = (lo + hi) / 2;
    const t = traceBand(m);
    if (t && t.end.y > y) lo = m;
    else hi = m; // below target, or TIR: both mean n is too high
  }
  return (lo + hi) / 2;
}

// ---------- geometry ----------

/** Strip between two edges (a0→a1, b0→b1); uv.x runs along the strip, uv.y = 0 on a, 1 on b. */
function strip(a0, a1, b0, b1, segs = 24, rows = 1) {
  const pos = [];
  const uv = [];
  const idx = [];
  const a = new V2();
  const b = new V2();
  for (let i = 0; i <= segs; i++) {
    const u = i / segs;
    a.lerpVectors(a0, a1, u);
    b.lerpVectors(b0, b1, u);
    for (let j = 0; j <= rows; j++) {
      const v = j / rows;
      pos.push(a.x + (b.x - a.x) * v, a.y + (b.y - a.y) * v, 0);
      uv.push(u, v);
    }
  }
  const stride = rows + 1;
  for (let i = 0; i < segs; i++) {
    for (let j = 0; j < rows; j++) {
      const p = i * stride + j;
      idx.push(p, p + stride, p + 1, p + 1, p + stride, p + stride + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** A beam ribbon from a to b, tapering from half-width wa to wb. */
function ribbon(a, b, wa, wb) {
  const d = b.clone().sub(a).normalize();
  const n = new V2(-d.y, d.x);
  return strip(
    a.clone().addScaledVector(n, wa),
    b.clone().addScaledVector(n, wb),
    a.clone().addScaledVector(n, -wa),
    b.clone().addScaledVector(n, -wb),
  );
}

// ---------- shaders ----------
const additive = {
  transparent: true,
  depthWrite: false,
  depthTest: false, // the only occluder is glass, and light should read through it
  side: THREE.DoubleSide,
  blending: THREE.AdditiveBlending,
};

const UV_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

/** `head` = [far, near]: fade in from darkness over that distance band before the beam's end. */
function beamMaterial(color, intensity, length, tail, head = [0, 0]) {
  return new THREE.ShaderMaterial({
    ...additive,
    uniforms: {
      uColor: { value: color },
      uIntensity: { value: intensity },
      uLen: { value: length },
      uTail: { value: tail },
      uHead: { value: new V2(...head) },
      uProgress: { value: 0 },
      uTime: { value: 0 },
    },
    vertexShader: UV_VERT,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform vec2 uHead;
      uniform float uIntensity, uLen, uTail, uProgress, uTime;
      varying vec2 vUv;
      void main() {
        float v = vUv.y * 2.0 - 1.0;
        float core = exp(-v * v * 34.0);
        float halo = exp(-v * v * 4.5) * 0.2;
        float reveal = clamp((uProgress - vUv.x) * uLen / 0.3, 0.0, 1.0);
        float tail = mix(1.0, 1.0 - 0.55 * vUv.x, uTail);
        if (uHead.x > 0.0) tail *= smoothstep(uHead.x, uHead.y, (1.0 - vUv.x) * uLen);
        float shimmer = 1.0 + 0.05 * sin(vUv.x * uLen * 9.0 - uTime * 7.0);
        gl_FragColor = vec4(uColor * uIntensity * (core + halo) * reveal * tail * shimmer, 1.0);
      }`,
  });
}

function sheetMaterial(stops, { opacity, whiteness, fade, length }) {
  return new THREE.ShaderMaterial({
    ...additive,
    uniforms: {
      uStops: { value: stops },
      uOpacity: { value: opacity },
      uWhite: { value: whiteness },
      uFade: { value: fade },
      uLen: { value: length },
      uProgress: { value: 0 },
    },
    defines: { STOPS: stops.length },
    vertexShader: UV_VERT,
    fragmentShader: /* glsl */ `
      uniform vec3 uStops[STOPS];
      uniform float uOpacity, uWhite, uFade, uLen, uProgress;
      varying vec2 vUv;
      vec3 spectrum(float t) {
        float x = clamp(t, 0.0, 1.0) * float(STOPS - 1);
        int i = int(min(floor(x), float(STOPS - 2)));
        return mix(uStops[i], uStops[i + 1], smoothstep(0.0, 1.0, x - float(i)));
      }
      void main() {
        float edge = smoothstep(0.0, 0.14, vUv.y) * smoothstep(1.0, 0.86, vUv.y);
        float reveal = clamp((uProgress - vUv.x) * uLen / 0.35, 0.0, 1.0);
        float fade = mix(1.0, pow(max(1.0 - vUv.x, 0.0), 1.4), uFade);
        vec3 c = mix(vec3(1.0), spectrum(vUv.y), mix(1.0, smoothstep(0.0, 0.85, vUv.x), uWhite));
        gl_FragColor = vec4(c * uOpacity * edge * reveal * fade, 1.0);
      }`,
  });
}

const POINT_SIZE = /* glsl */ `
  gl_PointSize = size * projectionMatrix[1][1] * uViewH * 0.5 / -mv.z;`;

function glowMaterial() {
  return new THREE.ShaderMaterial({
    ...additive,
    uniforms: { uViewH: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute vec3 aColor;
      attribute float aSize, aIntensity;
      uniform float uViewH;
      varying vec3 vColor;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float size = aSize;
        ${POINT_SIZE}
        vColor = aColor * aIntensity;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      void main() {
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        float r2 = dot(p, p);
        if (r2 > 1.0) discard;
        float a = exp(-r2 * 4.0) * (1.0 - r2) * 0.55 + exp(-r2 * 36.0);
        gl_FragColor = vec4(vColor * a, 1.0);
      }`,
  });
}

/** Dust in a darkened room: motes only show where a beam passes through them. */
function motesMaterial(segments) {
  return new THREE.ShaderMaterial({
    ...additive,
    defines: { SEGS: segments },
    uniforms: {
      uViewH: { value: 1 },
      uTime: { value: 0 },
      uA: { value: Array.from({ length: segments }, () => new THREE.Vector3()) },
      uB: { value: Array.from({ length: segments }, () => new THREE.Vector3()) },
      uC: { value: Array.from({ length: segments }, () => new THREE.Color()) },
      uP: { value: new Array(segments).fill(0) },
    },
    vertexShader: /* glsl */ `
      attribute float aSeed;
      uniform float uViewH, uTime;
      uniform vec3 uA[SEGS], uB[SEGS], uC[SEGS];
      uniform float uP[SEGS];
      varying vec3 vColor;
      void main() {
        vec3 p = position;
        p.x += sin(uTime * 0.11 + aSeed * 12.3) * 0.14;
        p.y += sin(uTime * 0.17 + aSeed * 7.1) * 0.06 + cos(uTime * 0.07 + aSeed * 3.0) * 0.04;
        p.z += cos(uTime * 0.13 + aSeed * 5.7) * 0.08;
        vec3 col = vec3(0.0);
        for (int i = 0; i < SEGS; i++) {
          vec3 ab = uB[i] - uA[i];
          float t = clamp(dot(p - uA[i], ab) / dot(ab, ab), 0.0, 1.0);
          float d = length(p - (uA[i] + ab * t));
          col += uC[i] * exp(-d * d * 260.0) * step(t, uP[i]);
        }
        vColor = col * (0.55 + 0.45 * sin(uTime * 1.3 + aSeed * 40.0));
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float size = 0.034;
        ${POINT_SIZE}
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      void main() {
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        float r2 = dot(p, p);
        if (r2 > 1.0 || dot(vColor, vColor) < 1e-5) discard;
        gl_FragColor = vec4(vColor * (1.0 - r2) * 1.4, 1.0);
      }`,
  });
}

// ---------- mount ----------
const fig = document.querySelector("[data-prism]");
if (fig) {
  try {
    mount(fig);
  } catch (err) {
    console.error("prism hero:", err);
    fig.classList.remove("is-loading", "is-3d");
  }
}

function mount(fig) {
  const stage = fig.querySelector(".prism-stage");
  const items = [...fig.querySelectorAll(".prism-labels li")];
  const frameEl = fig.querySelector(".prism-frame");
  const tag = fig.querySelector(".prism-tag");
  const ink = new THREE.Color(getComputedStyle(fig).getPropertyValue("--ink").trim());

  // Bands: colours come from the label markup, so the page has one source of truth.
  const yRed = traceBand(RED_IOR).end.y;
  const bands = items.map((li, i) => {
    const ray = traceBand(i === 0 ? RED_IOR : solveIor(yRed - i * BAND_GAP));
    if (!ray) throw new Error("band spacing exceeds the prism's dispersion");
    const color = new THREE.Color(getComputedStyle(li).getPropertyValue("--c").trim());
    color.multiplyScalar(1 / Math.max(color.r, color.g, color.b)); // light, not paint: full value
    return {
      ...ray,
      color,
      li,
      lenIn: ENTRY.distanceTo(ray.exit),
      lenOut: ray.exit.distanceTo(ray.end),
      progress: 0,
      flash: 0,
    };
  });
  const first = bands[0];
  const last = bands[bands.length - 1];
  const stops = bands.map((b) => b.color);
  const weights = [0.18, 0.15, 0.22, 0.19, 0.17, 0.09].slice(0, bands.length);
  const weightSum = weights.reduce((s, w) => s + w, 0);

  // ----- renderer -----
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
  renderer.toneMapping = THREE.NeutralToneMapping;
  const canvas = renderer.domElement;
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", stage.querySelector("svg")?.getAttribute("aria-label") ?? "");
  stage.append(canvas);

  const scene = new THREE.Scene();
  const room = preToneMap(ink);
  scene.background = room;
  const camera = new THREE.PerspectiveCamera(FOV, 2, 0.1, 200);

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();

  const composer = new EffectComposer(
    renderer,
    new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }),
  );
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new V2(1, 1), 0.7, 0.5, 0.45);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // ----- the room: faint graph paper behind the bench, which the glass refracts -----
  const backdrop = new THREE.Mesh(
    new THREE.PlaneGeometry(80, 40),
    new THREE.ShaderMaterial({
      uniforms: { uBg: { value: room }, uLine: { value: preToneMap(new THREE.Color("#191c1a")) } },
      vertexShader: /* glsl */ `
        varying vec2 vW;
        void main() {
          vW = (modelMatrix * vec4(position, 1.0)).xy;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uBg, uLine;
        varying vec2 vW;
        void main() {
          vec2 g = vW / 0.5;
          vec2 w = fwidth(g);
          vec2 l = 1.0 - smoothstep(vec2(0.0), w * 1.25, abs(fract(g - 0.5) - 0.5));
          vec2 c = vW - vec2(0.8, -0.6);
          float fade = exp(-dot(c, c) * 0.022);
          gl_FragColor = vec4(mix(uBg, uLine, max(l.x, l.y) * fade), 1.0);
        }`,
    }),
  );
  backdrop.position.z = -2.4;
  scene.add(backdrop);

  // ----- prism -----
  const prismGeo = new THREE.ExtrudeGeometry(new THREE.Shape([BASE_L, BASE_R, APEX]), {
    depth: DEPTH,
    bevelEnabled: true,
    bevelThickness: 0.03,
    bevelSize: 0.03,
    bevelOffset: -0.03,
    bevelSegments: 4,
  });
  prismGeo.translate(0, 0, -DEPTH / 2);
  const prism = new THREE.Mesh(
    prismGeo,
    new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      metalness: 0,
      roughness: 0.03,
      transmission: 1,
      thickness: 1.6,
      ior: 1.5,
      dispersion: 6,
      envMapIntensity: 0.55,
      clearcoat: 0.5,
      clearcoatRoughness: 0.08,
      attenuationColor: new THREE.Color("#dde6f2"),
      attenuationDistance: 5,
    }),
  );
  scene.add(prism);

  // Hairline edges: front edges crisp, back edges faint (seen through the glass).
  const zf = DEPTH / 2;
  const corners = [BASE_L, BASE_R, APEX];
  const edgePos = [];
  corners.forEach((p, i) => {
    const q = corners[(i + 1) % 3];
    edgePos.push(p.x, p.y, zf, q.x, q.y, zf, p.x, p.y, -zf, q.x, q.y, -zf, p.x, p.y, zf, p.x, p.y, -zf);
  });
  const edgeGeo = new THREE.BufferGeometry();
  edgeGeo.setAttribute("position", new THREE.Float32BufferAttribute(edgePos, 3));
  edgeGeo.scale(1.004, 1.004, 1.004);
  const edgeFront = new THREE.LineSegments(
    edgeGeo,
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }),
  );
  const edgeBack = new THREE.LineSegments(
    edgeGeo,
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, depthTest: false }),
  );
  scene.add(edgeFront, edgeBack);

  // ----- light -----
  const white = new THREE.Color(1, 1, 1);
  const inBeam = new THREE.Mesh(ribbon(BEAM_START, ENTRY, 0.065, 0.065), beamMaterial(white, 1.7, IN_LEN, 0, IN_FADE));
  const innerFan = new THREE.Mesh(
    strip(ENTRY, first.exit, ENTRY, last.exit, 12, 12),
    sheetMaterial(stops, { opacity: 0.85, whiteness: 1, fade: 0, length: first.lenIn }),
  );
  const outerFan = new THREE.Mesh(
    strip(first.exit, first.end, last.exit, last.end, 32, 24),
    sheetMaterial(stops, { opacity: 0.11, whiteness: 0, fade: 1, length: first.lenOut }),
  );
  scene.add(inBeam, innerFan, outerFan);
  for (const b of bands) {
    b.mesh = new THREE.Mesh(ribbon(b.exit, b.end, 0.05, 0.085), beamMaterial(b.color, 1.55, b.lenOut, 1));
    scene.add(b.mesh);
  }

  // One Points object for every glow: 2 flares, one node per band end, then the visitor pool.
  const NODE0 = 2;
  const PART0 = NODE0 + bands.length;
  const glowCount = PART0 + POOL;
  const glowGeo = new THREE.BufferGeometry();
  const attr = (n) => new THREE.BufferAttribute(new Float32Array(glowCount * n), n).setUsage(THREE.DynamicDrawUsage);
  const gPos = attr(3);
  const gColor = attr(3);
  const gSize = attr(1);
  const gIntensity = attr(1);
  glowGeo.setAttribute("position", gPos);
  glowGeo.setAttribute("aColor", gColor);
  glowGeo.setAttribute("aSize", gSize);
  glowGeo.setAttribute("aIntensity", gIntensity);
  const glowMat = glowMaterial();
  const glow = new THREE.Points(glowGeo, glowMat);
  glow.frustumCulled = false;
  scene.add(glow);

  const exitMid = first.exit.clone().lerp(last.exit, 0.5);
  gPos.setXYZ(0, ENTRY.x, ENTRY.y, 0);
  gColor.setXYZ(0, 1, 1, 1);
  gSize.setX(0, 0.5);
  gPos.setXYZ(1, exitMid.x, exitMid.y, 0);
  gColor.setXYZ(1, 1, 0.94, 0.86);
  gSize.setX(1, 0.34);
  bands.forEach((b, i) => {
    gPos.setXYZ(NODE0 + i, b.end.x, b.end.y, 0);
    gColor.setXYZ(NODE0 + i, b.color.r, b.color.g, b.color.b);
    gSize.setX(NODE0 + i, 0.1);
  });

  // Motes, scattered around the beam paths; the shader lights the ones a beam crosses.
  const segs = [{ a: ENTRY.clone().addScaledVector(IN_DIR, -IN_FADE[0]), b: ENTRY, c: white }].concat(
    bands.map((b) => ({ a: b.exit, b: b.end, c: b.color })),
  );
  const motesMat = motesMaterial(segs.length);
  segs.forEach((s, i) => {
    motesMat.uniforms.uA.value[i].set(s.a.x, s.a.y, 0);
    motesMat.uniforms.uB.value[i].set(s.b.x, s.b.y, 0);
    motesMat.uniforms.uC.value[i].copy(s.c).multiplyScalar(i === 0 ? 0.9 : 1.2);
  });
  {
    const N = 900;
    const lens = segs.map((s) => s.a.distanceTo(s.b));
    const total = lens.reduce((x, y) => x + y, 0);
    const pos = new Float32Array(N * 3);
    const seed = new Float32Array(N);
    const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
    const p = new V2();
    for (let k = 0; k < N; k++) {
      let r = Math.random() * total;
      let i = 0;
      while (r > lens[i] && i < lens.length - 1) r -= lens[i++];
      p.lerpVectors(segs[i].a, segs[i].b, r / lens[i]);
      pos.set([p.x + gauss() * 0.1, p.y + gauss() * 0.1, gauss() * 0.1], k * 3);
      seed[k] = Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    const motes = new THREE.Points(g, motesMat);
    motes.frustumCulled = false;
    scene.add(motes);
  }

  // ----- visitors -----
  const parts = Array.from({ length: POOL }, () => ({ live: false, band: 0, seg: 0, s: 0 }));
  let spawnIn = 0;
  const pickBand = () => {
    let r = Math.random() * weightSum;
    for (let i = 0; i < weights.length; i++) if ((r -= weights[i]) <= 0) return i;
    return weights.length - 1;
  };
  function spawn() {
    const p = parts.find((q) => !q.live);
    if (!p) return;
    p.live = true;
    p.band = pickBand();
    p.seg = 0;
    // start just left of the visible edge so nobody pops into view
    p.s = Math.max(0, IN_LEN - (ENTRY.x - (view.leftX - 0.6)) / IN_DIR.x);
  }
  const tmp = new V2();
  function stepVisitors(dt) {
    spawnIn -= dt;
    if (spawnIn <= 0) {
      spawn();
      spawnIn = 0.16 + Math.random() * 0.3;
    }
    parts.forEach((p, k) => {
      const i = PART0 + k;
      if (!p.live) {
        gIntensity.setX(i, 0);
        return;
      }
      const b = bands[p.band];
      const lens = [IN_LEN, b.lenIn, b.lenOut];
      p.s += dt * SPEED * (p.seg === 1 ? 1 / b.ior : 1); // light slows in glass
      while (p.live && p.s >= lens[p.seg]) {
        p.s -= lens[p.seg];
        if (++p.seg > 2) {
          p.live = false;
          b.flash = 1;
          lastHit = p.band;
        }
      }
      if (!p.live) {
        gIntensity.setX(i, 0);
        return;
      }
      const u = p.s / lens[p.seg];
      let mix = 0;
      let fade = 1;
      if (p.seg === 0) {
        tmp.lerpVectors(BEAM_START, ENTRY, u);
        fade = smooth(IN_FADE[0], IN_FADE[1], IN_LEN - p.s); // visitors emerge with the beam
      } else if (p.seg === 1) {
        tmp.lerpVectors(ENTRY, b.exit, u);
        mix = u;
      } else {
        tmp.lerpVectors(b.exit, b.end, u);
        mix = 1;
        fade = clamp01((1 - u) / 0.08);
      }
      gPos.setXYZ(i, tmp.x, tmp.y, 0);
      gColor.setXYZ(i, 1 + (b.color.r - 1) * mix, 1 + (b.color.g - 1) * mix, 1 + (b.color.b - 1) * mix);
      gSize.setX(i, p.seg === 0 ? 0.085 : 0.075);
      gIntensity.setX(i, (p.seg === 0 ? 2.4 : 2.0) * fade);
    });
  }
  function clearVisitors() {
    for (const p of parts) p.live = false;
    for (let k = 0; k < POOL; k++) gIntensity.setX(PART0 + k, 0);
  }

  // ----- layout: fit the optical bench into .prism-frame; the label column lives inside the frame -----
  const view = { w: 1, h: 1, cx: 0, cy: 0, D: 20, leftX: -5, sparse: false, yaw: 0, pitch: 0 };
  let lastHit = 0; // the label shown when band ends are too close for all of them (narrow phones)
  const fitY1 = APEX.y + 0.3;
  const fitY0 = last.end.y - 0.25;
  const fitPts = [
    new THREE.Vector3(FIT_X0, ENTRY.y + ((FIT_X0 - ENTRY.x) * IN_DIR.y) / IN_DIR.x, 0),
    new THREE.Vector3(0, fitY1, 0),
    new THREE.Vector3(X_END, fitY0, 0),
    ...[BASE_L, BASE_R, APEX].flatMap((p) => [new THREE.Vector3(p.x, p.y, zf), new THREE.Vector3(p.x, p.y, -zf)]),
    ...bands.map((b) => new THREE.Vector3(b.end.x, b.end.y, 0)),
  ];

  const v3 = new THREE.Vector3();
  const project = (v) => {
    v3.copy(v).project(camera);
    return [((v3.x + 1) / 2) * view.w, ((1 - v3.y) / 2) * view.h];
  };
  const toScreen = (p) => project(v3.set(p.x, p.y, 0));

  function layout() {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    if (!w || !h) return;
    view.w = w;
    view.h = h;
    const dpr = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(MAX_PIXELS / (w * h)));
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    composer.setPixelRatio(dpr);
    composer.setSize(w, h);
    glowMat.uniforms.uViewH.value = motesMat.uniforms.uViewH.value = h * dpr;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();

    // Target box in stage pixels: the frame, minus the label column on its right.
    const s = stage.getBoundingClientRect();
    const f = frameEl.getBoundingClientRect();
    const labelPx = Math.max(...items.map((li) => li.offsetWidth)) + LABEL_GAP;
    const box = { x0: f.left - s.left, x1: f.right - s.left - labelPx, y0: f.top - s.top, y1: f.bottom - s.top };
    const boxW = box.x1 - box.x0;
    const boxH = box.y1 - box.y0;

    // Orthographic first guess, then project the real bench and correct for yaw, pitch and
    // perspective. Fit at rest: pointer parallax only nudges the camera around this pose.
    const k = Math.min(boxW / (X_END - FIT_X0), boxH / (fitY1 - fitY0));
    const tanHalf = Math.tan(rad(FOV / 2));
    view.D = h / 2 / k / tanHalf;
    view.cx = (FIT_X0 + X_END) / 2;
    view.cy = (fitY0 + fitY1) / 2;
    const { yaw, pitch } = view;
    view.yaw = view.pitch = 0;
    for (let i = 0; i < 5; i++) {
      placeCamera();
      camera.updateMatrixWorld();
      let x0 = Infinity;
      let x1 = -Infinity;
      let y0 = Infinity;
      let y1 = -Infinity;
      for (const p of fitPts) {
        const [x, y] = project(p);
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
      const ppu = h / 2 / (view.D * tanHalf); // px per world unit at the target
      view.cx -= ((box.x0 + box.x1) / 2 - (x0 + x1) / 2) / ppu;
      view.cy += ((box.y0 + box.y1) / 2 - (y0 + y1) / 2) / ppu;
      view.D /= Math.min(boxW / (x1 - x0), boxH / (y1 - y0));
    }
    placeCamera();
    camera.updateMatrixWorld();
    const ends = bands.map((b) => toScreen(b.end)[1]);
    const minGap = Math.min(...ends.slice(1).map((y, i) => y - ends[i]));
    view.sparse = minGap < MIN_LABEL_GAP;
    fig.classList.toggle("is-sparse", view.sparse);
    view.leftX = view.cx - (w / 2 / (h / 2 / (view.D * tanHalf))) * 1.4; // generous: spawns stay off-screen
    view.yaw = yaw;
    view.pitch = pitch;
  }

  function placeCamera() {
    const yaw = BASE_YAW + view.yaw;
    const pitch = BASE_PITCH + view.pitch;
    camera.position.set(
      view.cx + Math.sin(yaw) * Math.cos(pitch) * view.D,
      view.cy + Math.sin(pitch) * view.D,
      Math.cos(yaw) * Math.cos(pitch) * view.D,
    );
    camera.lookAt(view.cx, view.cy, 0);
  }

  function placeLabels(tagReveal) {
    // Centred just under the white beam, which rises to the right, so it never sits on the hero
    // copy to the upper left. On phones the prism sits too close to the stage edge for the tag to
    // clear both beam and glass, and the copy right above already says "one beam in": hide it.
    const tagAt = ENTRY.clone().addScaledVector(IN_DIR, (-1.7 - ENTRY.x) / IN_DIR.x);
    const [ax, ay] = toScreen(tagAt);
    const [ex, ey] = toScreen(ENTRY);
    const half = tag.offsetWidth / 2;
    const clear = 10 + Math.abs((ey - ay) / (ex - ax)) * half; // the tilted beam is closest at one end
    tag.style.transform = `translate3d(${ax.toFixed(1)}px, ${ay.toFixed(1)}px, 0) translate(-50%, ${clear.toFixed(1)}px)`;
    tag.style.opacity = ax < 12 + half ? "0" : tagReveal.toFixed(3);
    const pts = bands.map((b) => toScreen(b.end));
    const col = Math.max(...pts.map((p) => p[0])) + LABEL_GAP; // one aligned column
    bands.forEach((b, i) => {
      const shown = view.sparse && i !== lastHit ? 0 : clamp01((b.progress - 0.85) / 0.17);
      b.li.style.transform = `translate3d(${col.toFixed(1)}px, ${pts[i][1].toFixed(1)}px, 0) translateY(-50%)`;
      b.li.style.opacity = shown.toFixed(3);
      b.li.style.setProperty("--hit", b.flash.toFixed(3));
    });
  }

  // ----- timeline -----
  const pointer = new V2();
  let intro = 0;
  let clock = 0;
  function update(dt) {
    clock += dt;
    intro += dt;
    const t = motion ? intro : 99;
    const k = 1 - Math.exp(-dt * 3);
    view.yaw += (pointer.x * 0.07 - view.yaw) * k;
    view.pitch += (pointer.y * 0.04 - view.pitch) * k;
    placeCamera();

    const inP = ease(clamp01((t - 0.1) / 0.9)) * 1.02;
    const glass = clamp01((t - 0.85) / 0.45);
    const fanP = ease(clamp01((t - 1.0) / 1.15)) * 1.02;
    edgeFront.material.opacity = 0.42 * clamp01(t / 0.7);
    edgeBack.material.opacity = 0.13 * clamp01(t / 0.7);
    inBeam.material.uniforms.uProgress.value = inP;
    inBeam.material.uniforms.uTime.value = clock;
    innerFan.material.uniforms.uProgress.value = glass * 1.02;
    outerFan.material.uniforms.uProgress.value = fanP;
    motesMat.uniforms.uTime.value = clock;
    motesMat.uniforms.uP.value[0] = inP;

    const decay = Math.exp(-dt * 3.2);
    bands.forEach((b, i) => {
      b.progress = ease(clamp01((t - 1.0 - i * 0.08) / 1.0)) * 1.02;
      b.flash *= decay;
      b.mesh.material.uniforms.uProgress.value = b.progress;
      b.mesh.material.uniforms.uTime.value = clock;
      motesMat.uniforms.uP.value[i + 1] = b.progress;
      gIntensity.setX(NODE0 + i, (0.45 + b.flash * 2.6) * clamp01((b.progress - 0.95) / 0.07));
    });
    gIntensity.setX(0, 0.75 * glass);
    gIntensity.setX(1, 0.3 * clamp01((t - 1.0) / 0.4));

    if (motion && t > 2.3) stepVisitors(dt);
    else if (!motion) clearVisitors();
    gPos.needsUpdate = gColor.needsUpdate = gSize.needsUpdate = gIntensity.needsUpdate = true;

    placeLabels(clamp01((t - 0.5) / 0.5));
  }

  // ----- loop: only while on screen and motion is allowed -----
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  let motion = !reduce.matches;
  let onScreen = false;
  let raf = 0;
  let prevNow = 0;
  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - prevNow) / 1000);
    prevNow = now;
    update(dt);
    composer.render();
  }
  function renderStill() {
    update(0);
    composer.render();
  }
  function sync() {
    const run = onScreen && motion;
    if (run && !raf) {
      prevNow = performance.now();
      raf = requestAnimationFrame(frame);
    } else if (!run && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    if (!run) renderStill();
  }

  reduce.addEventListener("change", () => {
    motion = !reduce.matches;
    if (!motion) pointer.set(0, 0);
    sync();
  });
  new IntersectionObserver(([e]) => {
    onScreen = e.isIntersecting;
    sync();
  }).observe(stage);
  new ResizeObserver(() => {
    layout();
    if (!raf) renderStill();
  }).observe(stage);
  document.fonts?.ready.then(() => {
    layout();
    if (!raf) renderStill();
  });
  window.addEventListener(
    "pointermove",
    (e) => {
      if (!motion || !onScreen) return;
      const r = stage.getBoundingClientRect();
      pointer.set(
        Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1)),
        Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height) * 2 - 1)),
      );
    },
    { passive: true },
  );

  fig.classList.add("is-3d");
  fig.classList.remove("is-loading");
  layout();
}
