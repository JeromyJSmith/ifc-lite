/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * MARPA: real Gaussian-splat overlay for the 401 Pearl workbench.
 *
 * The ifc-lite renderer (WebGPU) has no Gaussian rasterizer, so the trained
 * splat is drawn by Spark (three.js / WebGL2) on a transparent canvas laid
 * over the main viewport, with its camera copied from the viewer's camera on
 * every animation frame.
 *
 * Placement (not re-derived; recorded in the walk-in sidecar
 * splat_drone_f003_8k_property.splat.json, D576/D595): the trained splat's
 * local frame is metres, Z up, +Y grid north, origin EPSG:2876
 * E 3058724 / N 1248744 ftUS, H 5396 ft NAVD88 — the same point and axes as
 * the model's IfcMapConversion (no rotation). The viewer draws IFC local
 * (x, y, z) at GL (x, z, -y) (see teleportCameraUVZ in Viewport.tsx), so the
 * only transform is the Z-up -> Y-up turn: rotation.x = -90 deg.
 *
 * Known limit: the overlay is composited above the WebGPU canvas without a
 * shared depth buffer, so walls do not occlude the splat.
 *
 * Lives outside React so closing the layer panel does not drop the splat.
 */

import type * as THREE_NS from 'three';
import { getGlobalRenderer } from '@/hooks/useBCF';

export interface GaussianSplatSpec {
  id: string;
  name: string;
  url: string;
  kind?: 'gaussian-splat' | 'photoreal-mesh' | string;
  visible?: boolean;
}

export interface GaussianSplatState {
  enabled: boolean;
  status: 'idle' | 'loading' | 'ready' | 'error';
  message: string;
  opacity: number;
  cadOpacity: number;
  splats: number;
  spec: GaussianSplatSpec | null;
  specs: GaussianSplatSpec[];
}

const DEFAULT_SPEC: GaussianSplatSpec = {
  id: 'solomon-full-estate-3dgs',
  name: 'Solomon 2500 Linden Full Estate 3DGS (2.83M Gaussians · Photorealistic)',
  url: '/ifcx-model/scans/solomon_2500_linden_3dgs.spz',
  kind: 'gaussian-splat',
  visible: true,
};

const DEFAULT_SPECS: GaussianSplatSpec[] = [
  DEFAULT_SPEC,
  { id: 'solomon-ground-hardscape-3dgs', name: 'Solomon 2500 Linden Ground & Hardscape 3DGS', url: '/ifcx-model/scans/solomon_2500_linden_hardscape_3dgs.spz', kind: 'gaussian-splat', visible: false },
  { id: 'solomon-photoreal-hardscape-mesh', name: 'Spirula Studio Photorealistic Hardscape Surface Mesh (1.97M Triangles GLB)', url: '/ifcx-model/scans/solomon_2500_linden_hardscape_mesh.glb', kind: 'photoreal-mesh', visible: false },
  { id: 'solomon-photoreal-full-mesh', name: 'Spirula Studio Photorealistic Full Surface Mesh (1.97M Triangles GLB)', url: '/ifcx-model/scans/solomon_2500_linden_full_mesh.glb', kind: 'photoreal-mesh', visible: false },
];

let state: GaussianSplatState = {
  enabled: false, status: 'idle', message: '', opacity: 1.0, cadOpacity: 0.0, splats: 0, spec: null, specs: [],
};
const listeners = new Set<() => void>();
function setState(patch: Partial<GaussianSplatState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}
export function subscribeGaussianSplat(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function getGaussianSplatState(): GaussianSplatState {
  return state;
}

interface Disposables {
  raf: number;
  resize: ResizeObserver | null;
  mesh: (THREE_NS.Object3D & { dispose?: () => void }) | null;
  renderer: THREE_NS.WebGLRenderer | null;
  canvas: HTMLCanvasElement | null;
}
interface Runtime extends Disposables {
  THREE: typeof THREE_NS;
  canvas: HTMLCanvasElement;
  renderer: THREE_NS.WebGLRenderer;
  scene: THREE_NS.Scene;
  persp: THREE_NS.PerspectiveCamera;
  ortho: THREE_NS.OrthographicCamera;
  mesh: THREE_NS.Object3D & { dispose?: () => void };
  resize: ResizeObserver;
}
let rt: Runtime | null = null, loading: Promise<void> | null = null, generation = 0;
let activeCleanup: (() => void) | null = null, pendingSpecId: string | null = null;
let savedCanvasOpacity: string | null = null, savedParentBg: string | null = null, baseCanvasOpacity: number | null = null;

export function configureGaussianSplatSpecs(specs: GaussianSplatSpec[] | undefined): GaussianSplatSpec | null {
  if (!specs || specs.length === 0) return null;
  const requested = pendingSpecId ? specs.find((s) => s.id === pendingSpecId) : undefined;
  if (requested) pendingSpecId = null;
  const visibleSpec = specs.find((s) => s.visible) ?? specs[0];
  const nextSpec = requested ?? (state.spec ? specs.find((s) => s.id === state.spec?.id) ?? state.spec : visibleSpec);
  const prevSpec = state.spec;
  setState({ specs, spec: nextSpec });
  if (state.enabled && requested && (prevSpec?.id !== requested.id || prevSpec?.url !== requested.url)) {
    stop();
    void setGaussianSplatEnabled(true);
  }
  return nextSpec;
}

async function resolveSpec(): Promise<GaussianSplatSpec> {
  if (state.spec && (!pendingSpecId || state.spec.id === pendingSpecId)) return state.spec;
  try {
    const res = await fetch('/ifcx-model/workbench-autoload.json', { cache: 'no-store' });
    if (res.ok) {
      const manifest = (await res.json()) as { gaussianSplats?: GaussianSplatSpec[] };
      const chosen = configureGaussianSplatSpecs(manifest.gaussianSplats);
      if (chosen?.url) return chosen;
    }
  } catch {
    // Fall through to the recorded default.
  }
  return (pendingSpecId ? DEFAULT_SPECS.find((s) => s.id === pendingSpecId) : undefined) ?? state.spec ?? DEFAULT_SPEC;
}

function mainCanvas(): HTMLCanvasElement | null {
  return document.querySelector<HTMLCanvasElement>('canvas[data-viewport="main"]');
}

export function applyCadCanvasOpacity(baseOpacity?: number) {
  if (baseOpacity !== undefined) baseCanvasOpacity = baseOpacity;
  const main = mainCanvas();
  if (!main) return;
  const parent = main.parentElement;
  if (state.enabled) {
    if (savedCanvasOpacity === null) savedCanvasOpacity = main.style.opacity;
    if (parent) {
      if (savedParentBg === null) savedParentBg = parent.style.backgroundColor;
      parent.style.backgroundColor = '#0b0f17';
    }
    const effectiveBase = baseCanvasOpacity ?? (savedCanvasOpacity === '0' ? 0 : 1);
    main.style.opacity = String(effectiveBase === 0 ? 0 : state.cadOpacity);
  } else {
    if (parent && savedParentBg !== null) {
      parent.style.backgroundColor = savedParentBg;
      savedParentBg = null;
    }
    if (baseCanvasOpacity !== null) main.style.opacity = baseCanvasOpacity === 0 ? '0' : (savedCanvasOpacity ?? '');
    else if (savedCanvasOpacity !== null) main.style.opacity = savedCanvasOpacity;
    savedCanvasOpacity = null;
  }
}

function clampCameraOnEnable() {
  const viewer = getGlobalRenderer();
  if (!viewer) return;
  const cam = viewer.getCamera();
  const p = cam.getPosition(), t = cam.getTarget();
  const dist = Math.hypot(p.x - t.x, p.y - t.y, p.z - t.z);
  // Guard against IFCX geometry streaming auto-fitting the camera to +1,628m NAVD88 or >90m away
  if (Math.abs(t.y) > 50 || dist > 90 || !Number.isFinite(dist)) {
    cam.stopInertia();
    cam.setUp(0, 1, 0);
    cam.setPosition(0, 7.5, 21);
    cam.setTarget(-2, 1.0, 0);
    cam.setOrbitCenter(null);
    viewer.requestRender();
  }
}

/** Copy the viewer camera into the three.js camera; returns the active one. */
function syncCamera(r: Runtime): THREE_NS.Camera | null {
  const viewer = getGlobalRenderer();
  if (!viewer) return null;
  const cam = viewer.getCamera();
  const p = cam.getPosition(), t = cam.getTarget(), u = cam.getUp();
  const rawDist = Math.hypot(p.x - t.x, p.y - t.y, p.z - t.z);
  const dist = Number.isFinite(rawDist) && rawDist > 0 ? rawDist : 1;
  const aspect = (r.canvas.clientWidth || 1) / (r.canvas.clientHeight || 1);
  const far = Math.max(2000, dist * 20);
  if (cam.getProjectionMode() === 'orthographic') {
    const half = cam.getOrthoSize(), o = r.ortho;
    o.left = -half * aspect; o.right = half * aspect; o.top = half; o.bottom = -half;
    o.near = -far; o.far = far;
    o.position.set(p.x, p.y, p.z); o.up.set(u.x, u.y, u.z); o.lookAt(t.x, t.y, t.z);
    o.updateProjectionMatrix(); o.updateMatrixWorld();
    return o;
  }
  const c = r.persp;
  c.fov = (cam.getFOV() * 180) / Math.PI;
  c.aspect = aspect;
  c.near = Math.max(0.05, dist / 2000);
  c.far = far;
  c.position.set(p.x, p.y, p.z); c.up.set(u.x, u.y, u.z); c.lookAt(t.x, t.y, t.z);
  c.updateProjectionMatrix(); c.updateMatrixWorld();
  return c;
}

function sizeCanvas(r: Runtime) {
  const main = mainCanvas();
  if (!main) return;
  r.renderer.setPixelRatio(window.devicePixelRatio || 1);
  r.renderer.setSize(main.clientWidth, main.clientHeight, false);
}

function disposeRuntime(r: Disposables) {
  if (r.raf) { cancelAnimationFrame(r.raf); r.raf = 0; }
  r.resize?.disconnect(); r.resize = null;
  r.mesh?.dispose?.(); r.mesh = null;
  r.renderer?.dispose(); r.renderer = null;
  r.canvas?.remove(); r.canvas = null;
}

async function start(gen: number): Promise<void> {
  const isStale = () => gen !== generation || !state.enabled;
  if (isStale()) return;
  const main = mainCanvas();
  if (!main?.parentElement) throw new Error('viewport canvas not found');
  const spec = state.spec ?? (await resolveSpec());
  if (isStale()) return;
  const isGlbMesh = spec.kind === 'photoreal-mesh' || spec.url.toLowerCase().endsWith('.glb');
  setState({ spec, status: 'loading', message: `Loading ${spec.url.split('/').pop()}…` });
  applyCadCanvasOpacity();

  const local: Disposables = { raf: 0, resize: null, mesh: null, renderer: null, canvas: null };
  const cleanup = () => disposeRuntime(local);
  activeCleanup = cleanup;

  try {
    const THREE = await import('three');
    if (isStale()) { cleanup(); return; }

    const canvas = document.createElement('canvas');
    local.canvas = canvas;
    canvas.dataset.viewport = 'gaussian-splat';
    Object.assign(canvas.style, {
      position: 'absolute', inset: '0', width: '100%', height: '100%',
      pointerEvents: 'none', zIndex: '2', opacity: String(state.opacity),
    });
    main.parentElement.insertBefore(canvas, main.nextSibling);

    const renderer = new THREE.WebGLRenderer({
      canvas, antialias: isGlbMesh, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true,
    });
    local.renderer = renderer;
    renderer.setClearColor(0x0b0f17, state.cadOpacity < 0.05 ? 1.0 : 0.0);
    const scene = new THREE.Scene();
    let readyMessage = '', readySplats = 0;

    if (isGlbMesh) {
      const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
      if (isStale()) { cleanup(); return; }
      const gltf = await new GLTFLoader().loadAsync(spec.url);
      const root = gltf.scene;
      let totalVerts = 0, totalTris = 0;
      root.traverse((child) => {
        const m = child as THREE_NS.Mesh;
        if (!m.isMesh || !m.geometry) return;
        totalVerts += m.geometry.getAttribute('position')?.count ?? 0;
        if (m.geometry.index) totalTris += m.geometry.index.count / 3;
        m.material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
      });
      root.rotation.set(0, Math.PI, 0);
      scene.add(root);
      local.mesh = Object.assign(root, {
        dispose: () => root.traverse((child) => {
          const m = child as THREE_NS.Mesh;
          if (!m.isMesh) return;
          m.geometry?.dispose();
          if (Array.isArray(m.material)) m.material.forEach((mat) => mat.dispose());
          else m.material?.dispose();
        }),
      });
      if (isStale()) { cleanup(); return; }
      readySplats = totalVerts;
      readyMessage = `${(totalVerts / 1e6).toFixed(2)}M Verts · ${(totalTris / 1e6).toFixed(2)}M Tris Photoreal Mesh`;
    } else {
      const { SparkRenderer, SplatMesh } = await import('@sparkjsdev/spark');
      if (isStale()) { cleanup(); return; }
      scene.add(new SparkRenderer({ renderer }));
      const splatMesh = new SplatMesh({ url: spec.url });
      splatMesh.rotation.set(0, 0, 0);
      scene.add(splatMesh);
      local.mesh = splatMesh;
    }

    if (isStale() || !local.mesh) { cleanup(); return; }

    const persp = new THREE.PerspectiveCamera(45, 1, 0.05, 2000);
    const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -2000, 2000);
    const r: Runtime = {
      THREE, canvas, renderer, scene, persp, ortho, mesh: local.mesh, raf: 0,
      resize: new ResizeObserver(() => sizeCanvas(r)),
    };
    local.resize = r.resize;
    r.resize.observe(main);
    sizeCanvas(r);
    clampCameraOnEnable();
    rt = r;

    const frame = () => {
      if (rt !== r || isStale()) return;
      r.renderer.setClearColor(0x0b0f17, state.cadOpacity < 0.05 ? 1.0 : 0.0);
      const cam = syncCamera(r);
      if (cam) r.renderer.render(r.scene, cam);
      local.raf = r.raf = requestAnimationFrame(frame);
    };
    local.raf = r.raf = requestAnimationFrame(frame);

    if (isGlbMesh) {
      setState({ status: 'ready', splats: readySplats, message: readyMessage });
    } else {
      const splatMesh = local.mesh as unknown as { initialized: Promise<unknown>; packedSplats?: { numSplats: number } };
      await splatMesh.initialized;
      if (isStale() || rt !== r) {
        if (rt === r) rt = null;
        cleanup();
        return;
      }
      const n = splatMesh.packedSplats?.numSplats ?? 0;
      setState({ status: 'ready', splats: n, message: `${(n / 1e6).toFixed(2)}M Photoreal 3DGS` });
    }
  } catch (err) {
    cleanup();
    throw err;
  } finally {
    if (activeCleanup === cleanup && rt === null) activeCleanup = null;
  }
}

function stop() {
  generation++;
  activeCleanup?.();
  activeCleanup = null;
  if (rt) { disposeRuntime(rt); rt = null; }
  loading = null;
  applyCadCanvasOpacity();
}

export async function setGaussianSplatEnabled(enabled: boolean): Promise<void> {
  setState({ enabled });
  applyCadCanvasOpacity();
  if (!enabled) {
    stop();
    setState({ status: 'idle', message: '' });
    return;
  }
  if (rt || loading) return;
  const gen = ++generation;
  const currentLoad = start(gen)
    .catch((err: unknown) => {
      if (gen !== generation) return;
      console.error('[gaussian-splat] load failed', err);
      stop();
      setState({ enabled: false, status: 'error', message: (err as Error).message });
    })
    .finally(() => { if (loading === currentLoad) loading = null; });
  loading = currentLoad;
  await currentLoad;
}

export async function setGaussianSplatSpec(specId: string): Promise<void> {
  pendingSpecId = specId;
  const prevId = state.spec?.id;
  if (state.specs.length === 0) await resolveSpec();
  const fromSpecs = state.specs.find((s) => s.id === specId);
  const found = fromSpecs ?? DEFAULT_SPECS.find((s) => s.id === specId);
  if (!found) return;
  if (fromSpecs) pendingSpecId = null;
  if (found.id === prevId && state.spec?.id === found.id) return;
  const wasEnabled = state.enabled;
  stop();
  setState({ spec: found, status: 'idle', message: '', splats: 0 });
  if (wasEnabled) await setGaussianSplatEnabled(true);
}

export function setGaussianSplatOpacity(opacity: number) {
  setState({ opacity });
  if (rt) rt.canvas.style.opacity = String(opacity);
}

export function setCadOverlayOpacity(cadOpacity: number) {
  setState({ cadOpacity });
  applyCadCanvasOpacity();
}

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__MARPA_GAUSSIAN_SPLAT__ = {
    setEnabled: setGaussianSplatEnabled, setOpacity: setGaussianSplatOpacity,
    setCadOpacity: setCadOverlayOpacity, setSpec: setGaussianSplatSpec,
    getState: getGaussianSplatState, getRuntime: () => rt,
    getCamera: () => getGlobalRenderer()?.getCamera(),
  };
}
