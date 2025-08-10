import * as THREE from 'three';

const appEl = document.getElementById('app') as HTMLDivElement;
const hintEl = document.getElementById('hint') as HTMLDivElement;
const overlayEl = document.getElementById('gestureOverlay') as HTMLDivElement;
const scoreEl = document.getElementById('score') as HTMLSpanElement;
const ammoEl = document.getElementById('ammo') as HTMLSpanElement;
const reloadEl = document.getElementById('reload') as HTMLSpanElement;

let renderer: THREE.WebGLRenderer;
let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let reticle: THREE.Mesh | null = null;
let controller: THREE.Group | null = null;
let xrHitTestSource: XRHitTestSource | null = null;
let xrLocalSpace: XRReferenceSpace | null = null;
let xrViewerSpace: XRReferenceSpace | null = null;
let started = false;

// HUD/game state
let score = 0;
let ammo = 6;
let reserve = 24;
let reloading = false;

// Flies state
interface Fly {
  group: THREE.Group;
  velocity: THREE.Vector3;
  state: 'flying' | 'landing' | 'landed';
  targetPos: THREE.Vector3 | null;
  landNormal: THREE.Vector3 | null;
  flapPhase: number;
}
const flies: Fly[] = [];
const maxFlies = 10;
const worldPlanes: { position: THREE.Vector3; normal: THREE.Vector3 }[] = [];
const raycaster = new THREE.Raycaster();

// WebAudio
let audioContext: AudioContext | null = null;
function playClick(freq = 800, durationMs = 70, volume = 0.3): void {
  try {
    audioContext = audioContext || new (window.AudioContext || (window as any).webkitAudioContext)();
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    osc.type = 'square';
    osc.frequency.value = freq;
    gain.gain.value = volume;
    osc.connect(gain); gain.connect(audioContext.destination);
    osc.start();
    setTimeout(() => { osc.stop(); osc.disconnect(); gain.disconnect(); }, durationMs);
  } catch {}
}
function playHit(): void { playClick(200, 100, 0.4); }

function updateHUD(): void {
  scoreEl.textContent = `Счёт: ${score}`;
  ammoEl.textContent = `Патроны: ${ammo}/${reserve}`;
  reloadEl.style.display = reloading ? 'inline-block' : 'none';
}

function setupThree(): void {
  scene = new THREE.Scene();
  scene.background = null;

  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 40);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local');

  appEl.appendChild(renderer.domElement);

  const ambient = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambient);
  const dir = new THREE.DirectionalLight(0xffffff, 0.8);
  dir.position.set(1, 2, 1);
  scene.add(dir);

  const ringGeo = new THREE.RingGeometry(0.08, 0.1, 32);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x00ff88, opacity: 0.9, transparent: true, side: THREE.DoubleSide });
  reticle = new THREE.Mesh(ringGeo, ringMat);
  reticle.rotation.x = -Math.PI / 2;
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);

  controller = renderer.xr.getController(0);
  controller.addEventListener('select', onShoot); // tap to shoot
  scene.add(controller);

  window.addEventListener('resize', onWindowResize);
  updateHUD();
}

function onWindowResize(): void {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function createFly(): THREE.Group {
  const bodyGeom = new THREE.SphereGeometry(0.03, 12, 12);
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.4, roughness: 0.6 });
  const body = new THREE.Mesh(bodyGeom, bodyMat);

  const headGeom = new THREE.SphereGeometry(0.02, 12, 12);
  const headMat = new THREE.MeshStandardMaterial({ color: 0x111111, metalness: 0.3, roughness: 0.7 });
  const head = new THREE.Mesh(headGeom, headMat);
  head.position.set(0, 0, 0.035);

  const wingGeom = new THREE.PlaneGeometry(0.05, 0.02);
  const wingMat = new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, side: THREE.DoubleSide });
  const wingL = new THREE.Mesh(wingGeom, wingMat);
  const wingR = new THREE.Mesh(wingGeom, wingMat);
  wingL.position.set(-0.03, 0.01, 0);
  wingR.position.set(0.03, 0.01, 0);
  wingL.rotation.y = Math.PI / 8;
  wingR.rotation.y = -Math.PI / 8;

  const fly = new THREE.Group();
  fly.add(body);
  fly.add(head);
  fly.add(wingL);
  fly.add(wingR);

  fly.userData = { body, head, wingL, wingR };
  return fly;
}

function spawnFly(origin: THREE.Vector3): Fly {
  const group = createFly();
  group.position.copy(origin.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.5, 0.1 + Math.random() * 0.2, (Math.random() - 0.5) * 0.5)));
  scene.add(group);
  return {
    group,
    velocity: new THREE.Vector3((Math.random() - 0.5) * 0.2, (Math.random() - 0.2) * 0.1, (Math.random() - 0.5) * 0.2),
    state: 'flying',
    targetPos: null,
    landNormal: null,
    flapPhase: Math.random() * Math.PI * 2
  };
}

function updateFlies(dt: number): void {
  const center = new THREE.Vector3();
  for (const f of flies) center.add(f.group.position);
  if (flies.length > 0) center.multiplyScalar(1 / flies.length);
  const camPos = new THREE.Vector3();
  camera.getWorldPosition(camPos);

  for (const f of flies) {
    f.flapPhase += dt * 40;
    const { wingL, wingR } = f.group.userData;
    const flap = Math.sin(f.flapPhase) * 0.6;
    wingL.rotation.z = flap;
    wingR.rotation.z = -flap;

    if (f.state === 'flying') {
      const toCenter = center.clone().sub(f.group.position).multiplyScalar(0.2);
      const avoidCam = f.group.position.clone().sub(camPos).setLength(0.3);
      const random = new THREE.Vector3((Math.random() - 0.5) * 0.03, (Math.random() - 0.5) * 0.02, (Math.random() - 0.5) * 0.03);
      f.velocity.add(toCenter.multiplyScalar(0.5)).add(random).add(avoidCam.multiplyScalar(0.05));
      f.velocity.clampLength(0, 0.6);
      f.group.position.add(f.velocity.clone().multiplyScalar(dt));
      f.group.lookAt(f.group.position.clone().add(f.velocity));

      if (worldPlanes.length > 0 && Math.random() < 0.01) {
        const p = worldPlanes[Math.floor(Math.random() * worldPlanes.length)];
        f.state = 'landing';
        f.targetPos = p.position.clone().add(p.normal.clone().multiplyScalar(0.02));
        f.landNormal = p.normal.clone();
      }
    } else if (f.state === 'landing') {
      if (!f.targetPos || !f.landNormal) { f.state = 'flying'; continue; }
      const toTarget = f.targetPos.clone().sub(f.group.position);
      const dist = toTarget.length();
      f.velocity.add(toTarget.normalize().multiplyScalar(0.4)).clampLength(0, 0.5);
      f.group.position.add(f.velocity.clone().multiplyScalar(dt));
      if (dist < 0.01) {
        f.state = 'landed';
        f.velocity.set(0, 0, 0);
        const up = new THREE.Vector3(0, 1, 0);
        const q = new THREE.Quaternion().setFromUnitVectors(up, f.landNormal);
        f.group.quaternion.slerp(q, 0.6);
      }
    } else if (f.state === 'landed') {
      if (Math.random() < 0.003) {
        f.state = 'flying';
        f.velocity.set((Math.random() - 0.5) * 0.3, 0.2 + Math.random() * 0.2, (Math.random() - 0.5) * 0.3);
      }
    }
  }
}

function spawnHitEffect(position: THREE.Vector3): void {
  const geom = new THREE.SphereGeometry(0.02, 10, 10);
  const mat = new THREE.MeshBasicMaterial({ color: 0xff3333 });
  const p = new THREE.Mesh(geom, mat);
  p.position.copy(position);
  scene.add(p);
  let t = 0;
  const update = (dt: number) => {
    t += dt;
    p.scale.setScalar(1 + t * 6);
    (p.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - t * 2);
    (p.material as any).transparent = true;
    if (t > 0.5) { scene.remove(p); }
  };
  // integrate effect into main loop by piggybacking dt updates
  const tick = () => { update(0.016); if (t <= 0.5) requestAnimationFrame(tick); };
  tick();
}

function tryReload(): void {
  if (reloading || ammo >= 6 || reserve <= 0) return;
  reloading = true; updateHUD();
  setTimeout(() => {
    const need = 6 - ammo;
    const take = Math.min(need, reserve);
    ammo += take; reserve -= take;
    reloading = false; updateHUD();
  }, 900);
}

function onShoot(): void {
  if (!started) return; // ignore taps before start
  if (reloading) return;
  if (ammo <= 0) { playClick(300, 120, 0.4); tryReload(); return; }
  ammo -= 1; updateHUD(); playClick(900, 60, 0.35);

  const centerNDC = new THREE.Vector2(0, 0);
  raycaster.setFromCamera(centerNDC, camera);
  const flyMeshes: THREE.Object3D[] = flies.map(f => f.group);
  const intersections = raycaster.intersectObjects(flyMeshes, true);
  if (intersections.length > 0) {
    const hit = intersections[0];
    const obj = hit.object;
    const fly = flies.find(f => f.group === obj || f.group.children.includes(obj as THREE.Object3D));
    if (fly) {
      scene.remove(fly.group);
      const idx = flies.indexOf(fly);
      if (idx >= 0) flies.splice(idx, 1);
      score += 1; updateHUD(); playHit();
      spawnHitEffect(hit.point);
    }
  }

  if (ammo === 0) tryReload();
}

async function startAR(): Promise<void> {
  if (started) return;
  if (!('xr' in navigator)) { hintEl.textContent = 'WebXR не поддерживается'; return; }
  const supports = await (navigator as any).xr.isSessionSupported('immersive-ar');
  if (!supports) { hintEl.textContent = 'AR-сессии не поддерживаются'; return; }

  setupThree();

  const session = await (navigator as any).xr.requestSession('immersive-ar', {
    requiredFeatures: ['hit-test', 'local-floor'],
    optionalFeatures: ['dom-overlay'],
    domOverlay: { root: document.body as any }
  });

  started = true;
  overlayEl.style.display = 'none';

  renderer.xr.setSession(session);

  const refSpace = await session.requestReferenceSpace('local');
  xrLocalSpace = refSpace;
  xrViewerSpace = await session.requestReferenceSpace('viewer');

  xrHitTestSource = await (session as any).requestHitTestSource?.({ space: xrViewerSpace });
  if (!xrHitTestSource) { hintEl.textContent = 'Hit-test недоступен'; }

  session.addEventListener('end', () => {
    xrHitTestSource?.cancel();
    xrHitTestSource = null;
    xrLocalSpace = null;
    xrViewerSpace = null;
    started = false;
  });

  const origin = new THREE.Vector3(0, 0, -0.5);
  for (let i = 0; i < maxFlies; i++) flies.push(spawnFly(origin));

  let lastTime = 0;
  renderer.setAnimationLoop((time, frame) => {
    const t = time / 1000;
    const dt = lastTime === 0 ? 0.016 : Math.min(0.05, t - lastTime);
    lastTime = t;

    if (frame && xrLocalSpace && xrHitTestSource && reticle) {
      const hitTestResults = (frame as any).getHitTestResults?.(xrHitTestSource) ?? [];
      if (hitTestResults.length > 0) {
        const pose = hitTestResults[0].getPose(xrLocalSpace as XRReferenceSpace);
        if (pose) {
          const mat = new THREE.Matrix4().fromArray(pose.transform.matrix as unknown as number[]);
          reticle.matrix = mat;
          reticle.visible = true;

          const pos = new THREE.Vector3();
          const quat = new THREE.Quaternion();
          const scl = new THREE.Vector3();
          (mat as THREE.Matrix4).decompose(pos, quat, scl);
          const normal = new THREE.Vector3(0, 1, 0).applyQuaternion(quat).normalize();
          if (worldPlanes.length < 50) {
            worldPlanes.push({ position: pos.clone(), normal });
          } else if (Math.random() < 0.1) {
            worldPlanes[Math.floor(Math.random() * worldPlanes.length)] = { position: pos.clone(), normal };
          }
        }
      } else {
        reticle.visible = false;
      }
    }

    updateFlies(dt);
    renderer.render(scene, camera);
  });

  hintEl.textContent = 'Наведите перекрестие и нажмите, чтобы стрелять в мух';
}

async function tryStartARAuto(): Promise<void> {
  const attempt = async () => {
    try { await startAR(); } catch (e) { /* ignored */ }
  };
  // attempt immediately and also on first interactions
  await attempt();
  const once = async () => { document.removeEventListener('click', once); document.removeEventListener('touchstart', once); await attempt(); };
  document.addEventListener('click', once, { once: true });
  document.addEventListener('touchstart', once, { once: true });
}

window.addEventListener('load', () => {
  setTimeout(() => { void tryStartARAuto(); }, 50);
});