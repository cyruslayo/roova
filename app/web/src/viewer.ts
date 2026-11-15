import * as THREE from 'three';
import { constrainLook } from './camera';
import { spatialTransform } from './spatialTransform';

// The caller imports this module only after explicit visitor intent.
export async function mountSplat(
  host: HTMLElement,
  url: string,
  spatial: { metricScaleFactor?: number | null; groundPlaneOffset?: number | null } | null | undefined,
  onReady: () => void,
  onError: () => void,
  signal: AbortSignal
) {
  const [{ SparkRenderer, SplatMesh }] = await Promise.all([import('@sparkjsdev/spark')]);
  if (signal.aborted) return () => {};

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(58, 1, 0.01, 1000);
  // A fixed eye-height anchor prevents traversing inferred geometry. This
  // starting view is provisional until approved against the source footage.
  const eyeHeight = 1.4;
  camera.position.set(0, eyeHeight, 0);
  camera.lookAt(0, eyeHeight, -1);
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setSize(host.clientWidth, host.clientHeight);
  renderer.setClearColor(0x000000, 0);
  host.appendChild(renderer.domElement);

  // World Labs marble_raw_opencv uses OpenCV camera axes. Compose T * Rx(180°) * S:
  // scale the raw coordinates, rotate into the viewer frame, then apply ground offset in world Y.
  const worldTransform = new THREE.Group();
  const transform = spatialTransform(spatial);
  worldTransform.position.y = transform.groundPlaneOffset;
  worldTransform.rotation.x = transform.rotationX;
  const scaleTransform = new THREE.Group();
  scaleTransform.scale.setScalar(transform.metricScaleFactor);
  const splats = new SplatMesh({ url });
  scene.add(worldTransform);
  worldTransform.add(scaleTransform);
  scaleTransform.add(splats);

  let frame = 0, dragging = false, lastX = 0, lastY = 0, yaw = 0, pitch = 0, zoom = 1, pinchDistance = 0;
  let disposed = false, ready = false, initialized = false, readyFrameAttempts = 0;
  const pointers = new Map<number, { x: number; y: number }>();
  let spark: InstanceType<typeof SparkRenderer>;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener('abort', cleanup);
    host.removeEventListener('tour-reset', reset);
    observer.disconnect();
    cancelAnimationFrame(frame);
    renderer.domElement.removeEventListener('pointerdown', down);
    renderer.domElement.removeEventListener('pointermove', move);
    renderer.domElement.removeEventListener('pointerup', up);
    renderer.domElement.removeEventListener('pointercancel', up);
    renderer.domElement.removeEventListener('wheel', wheel);
    renderer.domElement.removeEventListener('webglcontextlost', lost);
    scene.remove(worldTransform, spark);
    splats.dispose?.();
    renderer.dispose();
    renderer.domElement.remove();
  };
  const fail = () => { if (disposed) return; cleanup(); onError(); };
  const draw = () => {
    frame = 0;
    if (disposed || renderer.getContext().isContextLost()) return;
    try {
      renderer.render(scene, camera);
      if (!ready && initialized && spark.activeSplats > 0) {
        // Swap away from the poster only on the frame after Spark has drawn usable splats.
        ready = true;
        requestAnimationFrame(() => { if (!disposed && !signal.aborted) onReady(); });
      } else if (!ready && initialized && readyFrameAttempts++ < 5) {
        invalidate();
      }
    } catch { fail(); }
  };
  const invalidate = () => { if (!disposed && !frame) frame = requestAnimationFrame(draw); };
  const resize = () => {
    if (!host.clientWidth || !host.clientHeight) return;
    camera.aspect = host.clientWidth / host.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(host.clientWidth, host.clientHeight);
    invalidate();
  };
  const applyLook = () => {
    const direction = new THREE.Vector3(
      Math.sin(yaw) * Math.cos(pitch),
      Math.sin(pitch),
      -Math.cos(yaw) * Math.cos(pitch)
    );
    camera.position.set(0, eyeHeight, 0);
    camera.lookAt(direction.add(new THREE.Vector3(0, eyeHeight, 0)));
    camera.fov = 58 / zoom;
    camera.updateProjectionMatrix();
    invalidate();
  };
  const down = (e: PointerEvent) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinchDistance = Math.hypot(a.x - b.x, a.y - b.y); }
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent) => {
    if (!dragging || !pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size > 1) {
      const [a, b] = [...pointers.values()], distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      if (pinchDistance) zoom = constrainLook(yaw, pitch, zoom * distance / pinchDistance).zoom;
      pinchDistance = distance;
    } else {
      const bounded = constrainLook(yaw - (e.clientX - lastX) * 0.004, pitch + (e.clientY - lastY) * 0.004, zoom);
      yaw = bounded.yaw; pitch = bounded.pitch; lastX = e.clientX; lastY = e.clientY;
    }
    applyLook();
  };
  const up = (e: PointerEvent) => {
    pointers.delete(e.pointerId); dragging = pointers.size > 0; pinchDistance = 0;
    if (dragging) { const remaining = [...pointers.values()][0]; lastX = remaining.x; lastY = remaining.y; }
  };
  const wheel = (e: WheelEvent) => {
    e.preventDefault(); zoom = constrainLook(yaw, pitch, zoom + Math.sign(-e.deltaY) * 0.08).zoom; applyLook();
  };
  const reset = () => { yaw = 0; pitch = 0; zoom = 1; applyLook(); };
  const lost = (event: Event) => { event.preventDefault(); fail(); };
  const observer = new ResizeObserver(resize);

  spark = new SparkRenderer({ renderer, onDirty: invalidate });
  spark.onDirty = invalidate;
  scene.add(spark);
  host.addEventListener('tour-reset', reset);
  renderer.domElement.addEventListener('pointerdown', down);
  renderer.domElement.addEventListener('pointermove', move);
  renderer.domElement.addEventListener('pointerup', up);
  renderer.domElement.addEventListener('pointercancel', up);
  renderer.domElement.addEventListener('wheel', wheel, { passive: false });
  renderer.domElement.addEventListener('webglcontextlost', lost);
  observer.observe(host);
  signal.addEventListener('abort', cleanup, { once: true });
  try {
    await splats.initialized;
    if (disposed || signal.aborted) return cleanup;
    initialized = true;
    invalidate();
  } catch { fail(); }
  return cleanup;
}
