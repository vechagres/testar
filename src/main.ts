import * as THREE from 'three';

const appEl = document.getElementById('app') as HTMLDivElement;
const startBtn = document.getElementById('startArBtn') as HTMLButtonElement;
const hintEl = document.getElementById('hint') as HTMLDivElement;

let renderer: THREE.WebGLRenderer;
let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let reticle: THREE.Mesh | null = null;
let controller: THREE.Group | null = null;
let xrHitTestSource: XRHitTestSource | null = null;
let xrLocalSpace: XRReferenceSpace | null = null;
let xrViewerSpace: XRReferenceSpace | null = null;

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

  // Lighting
  const ambient = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambient);
  const dir = new THREE.DirectionalLight(0xffffff, 0.8);
  dir.position.set(1, 2, 1);
  scene.add(dir);

  // Reticle
  const ringGeo = new THREE.RingGeometry(0.08, 0.1, 32);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x00ff88, opacity: 0.9, transparent: true, side: THREE.DoubleSide });
  reticle = new THREE.Mesh(ringGeo, ringMat);
  reticle.rotation.x = -Math.PI / 2;
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);

  // Controller for select (tap)
  controller = renderer.xr.getController(0);
  controller.addEventListener('select', onSelect);
  scene.add(controller);

  window.addEventListener('resize', onWindowResize);
}

function onWindowResize(): void {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function createBox(): THREE.Object3D {
  const geom = new THREE.BoxGeometry(0.15, 0.15, 0.15);
  const mat = new THREE.MeshStandardMaterial({ color: 0xff8844, roughness: 0.6, metalness: 0.2 });
  const mesh = new THREE.Mesh(geom, mat);
  const group = new THREE.Group();
  group.add(mesh);
  return group;
}

async function startAR(): Promise<void> {
  if (!('xr' in navigator)) {
    hintEl.textContent = 'WebXR не поддерживается на этом устройстве/браузере';
    return;
  }

  const supports = await (navigator as any).xr.isSessionSupported('immersive-ar');
  if (!supports) {
    hintEl.textContent = 'AR-сессии не поддерживаются';
    return;
  }

  setupThree();

  const session = await (navigator as any).xr.requestSession('immersive-ar', {
    requiredFeatures: ['hit-test', 'local-floor'],
    optionalFeatures: ['dom-overlay'],
    domOverlay: { root: document.body as any }
  });

  renderer.xr.setSession(session);

  const refSpace = await session.requestReferenceSpace('local');
  xrLocalSpace = refSpace;
  xrViewerSpace = await session.requestReferenceSpace('viewer');

  xrHitTestSource = await (session as any).requestHitTestSource?.({ space: xrViewerSpace });
  if (!xrHitTestSource) {
    hintEl.textContent = 'Hit-test недоступен';
  }

  session.addEventListener('end', () => {
    xrHitTestSource?.cancel();
    xrHitTestSource = null;
    xrLocalSpace = null;
    xrViewerSpace = null;
  });

  renderer.setAnimationLoop((time, frame) => {
    if (!frame || !reticle || !xrLocalSpace || !xrHitTestSource) {
      renderer.render(scene, camera);
      return;
    }

    const hitTestResults = (frame as any).getHitTestResults?.(xrHitTestSource) ?? [];
    if (hitTestResults.length > 0) {
      const pose = hitTestResults[0].getPose(xrLocalSpace as XRReferenceSpace);
      if (pose) {
        const mat = new THREE.Matrix4().fromArray(pose.transform.matrix as unknown as number[]);
        reticle.matrix = mat;
        reticle.visible = true;
      }
    } else {
      reticle.visible = false;
    }

    renderer.render(scene, camera);
  });

  startBtn.style.display = 'none';
  hintEl.textContent = 'Найдите плоскость и нажмите, чтобы разместить объект';
}

function onSelect(): void {
  if (!reticle || !reticle.visible) return;
  const obj = createBox();
  obj.applyMatrix4(reticle.matrix);
  obj.matrixAutoUpdate = true;
  scene.add(obj);
}

startBtn.addEventListener('click', () => {
  startAR().catch(err => {
    console.error(err);
    hintEl.textContent = 'Ошибка запуска AR: ' + (err?.message ?? err);
  });
});