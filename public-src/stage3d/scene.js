import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/**
 * The 3D stage: the rig in a dark, hazy room, drawn with three.js.
 *
 * Everything is instanced — one draw for every lamp head, one for every beam,
 * one for every cell of every bar — so a rig of a few hundred lights draws at
 * the display's rate on the machine running the show. Nothing is lit by real
 * lights (dozens of spotlights would not keep that rate): a lamp's lens, a
 * cell and a bulb glow in their own colour, a par's beam is a cone of light in
 * the haze, soft at its edges and fading along its length, and where a beam
 * meets the floor it leaves a pool. The haze setting thickens the beams and
 * the fog.
 *
 * Loaded on its own (three.js is most of it), the first time the Stage view
 * opens. `createStageScene` throws when the browser has no WebGL.
 *
 * It imports nothing of the app's: the room's size and the colour of a light
 * (world.js) are handed in, so this chunk shares no code with the page's and
 * the page loads, and opens offline, without it.
 */

const BG = 0x050507;
const OFF = 0.035;      // what an unlit lens or cell shows: its shape, not a light

const BEAM_VERTEX = /* glsl */`
  varying vec3 vColor;
  varying float vT;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vec4 world = instanceMatrix * vec4(position, 1.0);
    vec4 view = modelViewMatrix * world;
    vView = view.xyz;
    vNormal = normalize(normalMatrix * mat3(instanceMatrix) * normal);
    vColor = instanceColor;
    vT = -position.y;
    gl_Position = projectionMatrix * view;
  }
`;

const BEAM_FRAGMENT = /* glsl */`
  uniform float uHaze;
  varying vec3 vColor;
  varying float vT;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    // Brightest through the middle of the cone, where the eye looks through
    // the most haze, and fading from the lens to where it lands.
    float facing = pow(abs(dot(normalize(vNormal), normalize(-vView))), 1.6);
    float along = pow(clamp(1.0 - vT, 0.0, 1.0), 1.3) * smoothstep(0.0, 0.05, vT);
    gl_FragColor = vec4(vColor * uHaze * facing * along, 1.0);
    #include <colorspace_fragment>
  }
`;

const POOL_VERTEX = /* glsl */`
  varying vec3 vColor;
  varying vec2 vUv;
  void main() {
    vColor = instanceColor;
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`;

const POOL_FRAGMENT = /* glsl */`
  uniform float uStrength;
  varying vec3 vColor;
  varying vec2 vUv;
  void main() {
    float d = length(vUv - 0.5) * 2.0;
    float fall = pow(clamp(1.0 - d, 0.0, 1.0), 1.8);
    gl_FragColor = vec4(vColor * fall * uStrength, 1.0);
    #include <colorspace_fragment>
  }
`;

/** A soft round dot, for the glow around lenses, bulbs and cells. */
function glowTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * @param canvas   where to draw
 * @param options  `haze` 0–1; `room` — { width, depth, trussHeight } in metres
 *                 (world.js); `lightRGB` — a light's emitters as linear RGB
 *                 (world.lightRGB)
 */
export function createStageScene(canvas, { haze = 0.6, room, lightRGB }) {
  const { width: STAGE_W, depth: STAGE_D, trussHeight: TRUSS_H } = room;
  const VIEWS = {
    audience: { position: [0, 1.7, STAGE_D / 2 + 8], target: [0, 1.9, 0] },
    above: { position: [0, 15, 3], target: [0, 0, 0] },
    side: { position: [STAGE_W / 2 + 9, 3.2, 1.5], target: [0, 1.9, 0] },
  };

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setClearColor(BG, 1);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(BG, 0.03);
  const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 200);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI / 2 - 0.02;
  controls.minDistance = 2;
  controls.maxDistance = 45;

  // ── The room ──
  const disposables = [];
  const keep = (...things) => { disposables.push(...things); return things[0]; };
  const floor = new THREE.Mesh(
    keep(new THREE.PlaneGeometry(STAGE_W + 30, STAGE_D + 36)),
    keep(new THREE.MeshBasicMaterial({ color: 0x09090c })),
  );
  floor.rotation.x = -Math.PI / 2;
  const deck = new THREE.Mesh(
    keep(new THREE.PlaneGeometry(STAGE_W, STAGE_D)),
    keep(new THREE.MeshBasicMaterial({ color: 0x141418 })),
  );
  deck.rotation.x = -Math.PI / 2;
  deck.position.y = 0.002;
  const wall = new THREE.Mesh(
    keep(new THREE.PlaneGeometry(STAGE_W + 6, TRUSS_H + 3)),
    keep(new THREE.MeshBasicMaterial({ color: 0x0b0b0e })),
  );
  wall.position.set(0, (TRUSS_H + 3) / 2, -STAGE_D / 2 - 0.6);
  scene.add(floor, deck, wall);

  const trussMaterial = keep(new THREE.MeshBasicMaterial({ color: 0x2a2a30 }));
  const bodyMaterial = keep(new THREE.MeshBasicMaterial({ color: 0x1c1c21 }));
  const lensMaterial = keep(new THREE.MeshBasicMaterial({ color: 0xffffff }));
  const cellMaterial = keep(new THREE.MeshBasicMaterial({ color: 0xffffff }));
  const beamMaterial = keep(new THREE.ShaderMaterial({
    uniforms: { uHaze: { value: haze } },
    vertexShader: BEAM_VERTEX,
    fragmentShader: BEAM_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  }));
  const poolMaterial = keep(new THREE.ShaderMaterial({
    uniforms: { uStrength: { value: 0.9 } },
    vertexShader: POOL_VERTEX,
    fragmentShader: POOL_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }));
  const glowMap = keep(glowTexture());
  const glowMaterial = (size) => keep(new THREE.PointsMaterial({
    size, map: glowMap, vertexColors: true, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, sizeAttenuation: true,
  }));
  const lampGlowMaterial = glowMaterial(1.1);
  const cellGlowMaterial = glowMaterial(0.5);

  // The cone, apex at the origin, opening down −y to a radius of 1 at y = −1;
  // each beam scales it to its length and spread and turns it along its aim.
  const beamGeometry = keep(new THREE.ConeGeometry(1, 1, 36, 12, true).translate(0, -0.5, 0));
  const poolGeometry = keep(new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2));
  const bodyGeometry = keep(new THREE.CylinderGeometry(0.11, 0.15, 0.28, 18).translate(0, 0.14, 0));
  const lensGeometry = keep(new THREE.CircleGeometry(0.1, 24).rotateX(Math.PI / 2));
  const bulbGeometry = keep(new THREE.SphereGeometry(0.13, 18, 12));
  const cellGeometry = keep(new THREE.BoxGeometry(1, 1, 1));

  let rigGroup = null;
  let rigDisposables = [];
  let parts = null;
  let units = 0;

  const down = new THREE.Vector3(0, -1, 0);
  const tmpQ = new THREE.Quaternion();
  const tmpM = new THREE.Matrix4();
  const tmpV = new THREE.Vector3();
  const tmpS = new THREE.Vector3();

  function instanced(geometry, material, count) {
    const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, count));
    mesh.count = count;
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, count) * 3), 3);
    mesh.frustumCulled = false;
    return mesh;
  }

  function points(count, material) {
    const geometry = new THREE.BufferGeometry();
    rigDisposables.push(geometry);
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(Math.max(1, count) * 3), 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(Math.max(1, count) * 3), 3));
    geometry.setDrawRange(0, count);
    const p = new THREE.Points(geometry, material);
    p.frustumCulled = false;
    return p;
  }

  /** Build the rig from placeRig(): its lamps, beams, pools, cells and trusses. */
  function setRig(placed, unitCount) {
    if (rigGroup) {
      scene.remove(rigGroup);
      rigGroup.traverse((o) => { if (o.isInstancedMesh) o.dispose(); });
      for (const thing of rigDisposables) thing.dispose();
      rigDisposables = [];
    }
    rigGroup = new THREE.Group();
    units = unitCount;
    const pars = placed.lamps.filter((l) => l.kind === 'par');
    const bulbs = placed.lamps.filter((l) => l.kind === 'bulb');

    const bodies = instanced(bodyGeometry, bodyMaterial, pars.length);
    const lenses = instanced(lensGeometry, lensMaterial, pars.length);
    const beams = instanced(beamGeometry, beamMaterial, pars.length);
    const pools = instanced(poolGeometry, poolMaterial, pars.length);
    const bulbMesh = instanced(bulbGeometry, lensMaterial, bulbs.length);
    const cellMesh = instanced(cellGeometry, cellMaterial, placed.cells.length);
    const lampGlow = points(pars.length + bulbs.length, lampGlowMaterial);
    const cellGlow = points(placed.cells.length, cellGlowMaterial);

    pars.forEach((par, k) => {
      const aim = tmpV.set(par.aim.x, par.aim.y, par.aim.z).normalize();
      tmpQ.setFromUnitVectors(down, aim);
      // The body runs back from the lens (+y, which the turn sends behind it).
      tmpM.compose(new THREE.Vector3(par.position.x, par.position.y, par.position.z), tmpQ, tmpS.set(1, 1, 1));
      bodies.setMatrixAt(k, tmpM);
      tmpM.compose(new THREE.Vector3(par.position.x, par.position.y, par.position.z).addScaledVector(aim, 0.005), tmpQ, tmpS.set(1, 1, 1));
      lenses.setMatrixAt(k, tmpM);
      tmpM.compose(new THREE.Vector3(par.position.x, par.position.y, par.position.z), tmpQ, tmpS.set(par.radius, par.length, par.radius));
      beams.setMatrixAt(k, tmpM);
      const poolRadius = par.radius * (par.aim.y < 0 ? 1.35 / Math.max(0.35, -par.aim.y) : 0);
      tmpM.compose(new THREE.Vector3(par.end.x, 0.006, par.end.z), new THREE.Quaternion(), tmpS.set(poolRadius || 0.0001, 1, poolRadius || 0.0001));
      pools.setMatrixAt(k, tmpM);
      lampGlow.geometry.attributes.position.setXYZ(k, par.position.x + aim.x * 0.05, par.position.y + aim.y * 0.05, par.position.z + aim.z * 0.05);
    });
    bulbs.forEach((bulb, k) => {
      tmpM.compose(new THREE.Vector3(bulb.position.x, bulb.position.y, bulb.position.z), new THREE.Quaternion(), tmpS.set(1, 1, 1));
      bulbMesh.setMatrixAt(k, tmpM);
      lampGlow.geometry.attributes.position.setXYZ(pars.length + k, bulb.position.x, bulb.position.y, bulb.position.z);
    });
    placed.cells.forEach((cell, k) => {
      tmpM.compose(new THREE.Vector3(cell.position.x, cell.position.y, cell.position.z), new THREE.Quaternion(), tmpS.set(cell.size, cell.size, cell.size));
      cellMesh.setMatrixAt(k, tmpM);
      cellGlow.geometry.attributes.position.setXYZ(k, cell.position.x, cell.position.y, cell.position.z);
    });
    for (const truss of placed.trusses) {
      const geometry = new THREE.BoxGeometry(truss.to - truss.from, 0.22, 0.22);
      rigDisposables.push(geometry);
      const bar = new THREE.Mesh(geometry, trussMaterial);
      bar.position.set((truss.from + truss.to) / 2, truss.y + 0.11, truss.z);
      rigGroup.add(bar);
    }
    for (const mesh of [bodies, lenses, beams, pools, bulbMesh, cellMesh]) mesh.instanceMatrix.needsUpdate = true;
    lampGlow.geometry.attributes.position.needsUpdate = true;
    cellGlow.geometry.attributes.position.needsUpdate = true;
    rigGroup.add(beams, pools, bodies, lenses, bulbMesh, cellMesh, lampGlow, cellGlow);
    scene.add(rigGroup);
    parts = { pars, bulbs, cells: placed.cells, bodies, lenses, beams, pools, bulbMesh, cellMesh, lampGlow, cellGlow };
  }

  const rgb = new Float32Array(3);
  /** Colour every light from a frame: one emitter set per unit of the rig. */
  function setLights(frame) {
    if (!parts || !frame) return;
    const { pars, bulbs, cells, lenses, beams, pools, bulbMesh, cellMesh, lampGlow, cellGlow } = parts;
    const put = (attr, k, level) => {
      attr.array[k * 3] = Math.max(OFF, rgb[0] * level);
      attr.array[k * 3 + 1] = Math.max(OFF, rgb[1] * level);
      attr.array[k * 3 + 2] = Math.max(OFF, rgb[2] * level);
    };
    const glow = (attr, k, level) => {
      attr.array[k * 3] = rgb[0] * level;
      attr.array[k * 3 + 1] = rgb[1] * level;
      attr.array[k * 3 + 2] = rgb[2] * level;
    };
    pars.forEach((par, k) => {
      lightRGB(frame[par.unit], rgb);
      put(lenses.instanceColor, k, 1);
      glow(beams.instanceColor, k, 1);
      glow(pools.instanceColor, k, 1);
      glow(lampGlow.geometry.attributes.color, k, 0.9);
    });
    bulbs.forEach((bulb, k) => {
      lightRGB(frame[bulb.unit], rgb);
      put(bulbMesh.instanceColor, k, 1);
      glow(lampGlow.geometry.attributes.color, pars.length + k, 1);
    });
    cells.forEach((cell, k) => {
      lightRGB(frame[cell.unit], rgb);
      put(cellMesh.instanceColor, k, 1);
      glow(cellGlow.geometry.attributes.color, k, 0.8);
    });
    for (const mesh of [lenses, beams, pools, bulbMesh, cellMesh]) mesh.instanceColor.needsUpdate = true;
    lampGlow.geometry.attributes.color.needsUpdate = true;
    cellGlow.geometry.attributes.color.needsUpdate = true;
  }

  function setHaze(value) {
    const v = Math.max(0, Math.min(1, value));
    beamMaterial.uniforms.uHaze.value = v * 0.55;
    scene.fog.density = 0.012 + v * 0.03;
  }
  setHaze(haze);

  function view(name) {
    const v = VIEWS[name] || VIEWS.audience;
    camera.position.set(...v.position);
    controls.target.set(...v.target);
    controls.update();
  }
  view('audience');

  // Keys on the canvas: arrows orbit, + and − move closer and further.
  const spherical = new THREE.Spherical();
  function nudge({ turn = 0, tilt = 0, zoom = 1 }) {
    const offset = tmpV.copy(camera.position).sub(controls.target);
    spherical.setFromVector3(offset);
    spherical.theta += turn;
    spherical.phi = Math.max(0.15, Math.min(Math.PI / 2 - 0.02, spherical.phi + tilt));
    spherical.radius = Math.max(controls.minDistance, Math.min(controls.maxDistance, spherical.radius * zoom));
    camera.position.copy(controls.target).add(offset.setFromSpherical(spherical));
    controls.update();
  }

  function resize() {
    const box = canvas.parentElement ? canvas.parentElement.getBoundingClientRect() : canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(box.width));
    const h = Math.max(1, Math.round(box.height));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function render() {
    controls.update();
    renderer.render(scene, camera);
  }

  function dispose() {
    controls.dispose();
    if (rigGroup) {
      scene.remove(rigGroup);
      rigGroup.traverse((o) => { if (o.isInstancedMesh) o.dispose(); });
    }
    for (const thing of rigDisposables) thing.dispose();
    for (const thing of disposables) if (thing && thing.dispose) thing.dispose();
    renderer.dispose();
  }

  return {
    setRig, setLights, setHaze, view, nudge, resize, render, dispose,
    /** What is drawn, for tests and the page's description. */
    info: () => ({ units, pars: parts ? parts.pars.length : 0, bulbs: parts ? parts.bulbs.length : 0, cells: parts ? parts.cells.length : 0 }),
  };
}
