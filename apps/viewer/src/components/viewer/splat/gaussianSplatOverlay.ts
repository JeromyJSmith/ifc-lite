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
  visible?: boolean;
}

export interface GaussianSplatState {
  enabled: boolean;
  status: 'idle' | 'loading' | 'ready' | 'error';
  message: string;
  opacity: number;
  splats: number;
  spec: GaussianSplatSpec | null;
}

const DEFAULT_SPEC: GaussianSplatSpec = {
  id: 'gsplat-f003-8k-clean-v1',
  name: 'Drone Gaussian Splat f003 8K clean_v1 (Spark)',
  url: '/ifcx-model/scans/f003_8k_local_v2_step28000_clean_v1.spz',
  visible: false,
};

let state: GaussianSplatState = {
  enabled: false, status: 'idle', message: '', opacity: 1, splats: 0, spec: null,
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

interface Runtime {
  THREE: typeof THREE_NS;
  canvas: HTMLCanvasElement;
  renderer: THREE_NS.WebGLRenderer;
  scene: THREE_NS.Scene;
  persp: THREE_NS.PerspectiveCamera;
  ortho: THREE_NS.OrthographicCamera;
  mesh: THREE_NS.Object3D & { dispose?: () => void };
  raf: number;
  resize: ResizeObserver;
}
let rt: Runtime | null = null;
let loading: Promise<void> | null = null;

async function resolveSpec(): Promise<GaussianSplatSpec> {
  try {
    const res = await fetch('/ifcx-model/workbench-autoload.json', { cache: 'no-store' });
    if (res.ok) {
      const manifest = (await res.json()) as { gaussianSplats?: GaussianSplatSpec[] };
      const first = manifest.gaussianSplats?.[0];
      if (first?.url) return first;
    }
  } catch {
    // Fall through to the recorded default.
  }
  return DEFAULT_SPEC;
}

function mainCanvas(): HTMLCanvasElement | null {
  return document.querySelector<HTMLCanvasElement>('canvas[data-viewport="main"]');
}

/** Copy the viewer camera into the three.js camera; returns the active one. */
function syncCamera(r: Runtime): THREE_NS.Camera | null {
  const viewer = getGlobalRenderer();
  if (!viewer) return null;
  const cam = viewer.getCamera();
  const p = cam.getPosition();
  const t = cam.getTarget();
  const u = cam.getUp();
  const w = r.canvas.clientWidth || 1;
  const h = r.canvas.clientHeight || 1;
  const aspect = w / h;
  const dist = Math.hypot(p.x - t.x, p.y - t.y, p.z - t.z);
  const far = Math.max(2000, dist * 20);
  if (cam.getProjectionMode() === 'orthographic') {
    const half = cam.getOrthoSize();
    const o = r.ortho;
    o.left = -half * aspect; o.right = half * aspect; o.top = half; o.bottom = -half;
    o.near = -far; o.far = far;
    o.position.set(p.x, p.y, p.z); o.up.set(u.x, u.y, u.z); o.lookAt(t.x, t.y, t.z);
    o.updateProjectionMatrix(); o.updateMatrixWorld();
    return o;
  }
  const c = r.persp;
  c.fov = (cam.getFOV() * 180) / Math.PI;
  c.aspect = aspect;
  c.near = Math.max(0.01, dist / 2000);
  c.far = far;
  c.position.set(p.x, p.y, p.z); c.up.set(u.x, u.y, u.z); c.lookAt(t.x, t.y, t.z);
  c.updateProjectionMatrix(); c.updateMatrixWorld();
  return c;
}

function sizeCanvas(r: Runtime) {
  const main = mainCanvas();
  if (!main) return;
  const w = main.clientWidth, h = main.clientHeight;
  r.renderer.setPixelRatio(window.devicePixelRatio || 1);
  r.renderer.setSize(w, h, false);
}

async function start(): Promise<void> {
  const main = mainCanvas();
  if (!main?.parentElement) throw new Error('viewport canvas not found');
  const spec = state.spec ?? (await resolveSpec());
  setState({ spec, status: 'loading', message: `Loading ${spec.url.split('/').pop()}…` });

  const THREE = await import('three');
  const { SparkRenderer, SplatMesh } = await import('@sparkjsdev/spark');

  const canvas = document.createElement('canvas');
  canvas.dataset.viewport = 'gaussian-splat';
  Object.assign(canvas.style, {
    position: 'absolute', inset: '0', width: '100%', height: '100%',
    pointerEvents: 'none', zIndex: '2', opacity: String(state.opacity),
  });
  main.parentElement.insertBefore(canvas, main.nextSibling);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, premultipliedAlpha: true });
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const spark = new SparkRenderer({ renderer });
  scene.add(spark);
  const mesh = new SplatMesh({ url: spec.url });
  mesh.rotation.x = -Math.PI / 2; // local Z-up metres -> viewer GL Y-up
  scene.add(mesh);

  const persp = new THREE.PerspectiveCamera(45, 1, 0.05, 2000);
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -2000, 2000);
  const r: Runtime = {
    THREE, canvas, renderer, scene, persp, ortho, mesh, raf: 0,
    resize: new ResizeObserver(() => sizeCanvas(r)),
  };
  r.resize.observe(main);
  sizeCanvas(r);
  rt = r;

  const frame = () => {
    if (rt !== r) return;
    const cam = syncCamera(r);
    if (cam) renderer.render(scene, cam);
    r.raf = requestAnimationFrame(frame);
  };
  r.raf = requestAnimationFrame(frame);

  await mesh.initialized;
  const n = (mesh as unknown as { packedSplats?: { numSplats: number } }).packedSplats?.numSplats ?? 0;
  setState({ status: 'ready', splats: n, message: `${(n / 1e6).toFixed(2)}M Gaussians` });
}

function stop() {
  if (!rt) return;
  cancelAnimationFrame(rt.raf);
  rt.resize.disconnect();
  rt.mesh.dispose?.();
  rt.renderer.dispose();
  rt.canvas.remove();
  rt = null;
}

export async function setGaussianSplatEnabled(enabled: boolean): Promise<void> {
  setState({ enabled });
  if (!enabled) {
    stop();
    setState({ status: 'idle', message: '' });
    return;
  }
  if (rt || loading) return;
  loading = start()
    .catch((err: unknown) => {
      console.error('[gaussian-splat] load failed', err);
      stop();
      setState({ enabled: false, status: 'error', message: (err as Error).message });
    })
    .finally(() => { loading = null; });
  await loading;
}

export function setGaussianSplatOpacity(opacity: number) {
  setState({ opacity });
  if (rt) rt.canvas.style.opacity = String(opacity);
}

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__MARPA_GAUSSIAN_SPLAT__ = {
    setEnabled: setGaussianSplatEnabled,
    setOpacity: setGaussianSplatOpacity,
    getState: getGaussianSplatState,
  };
}
