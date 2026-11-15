import { BufferGeometry, CanvasTexture, DoubleSide, Float32BufferAttribute, LineBasicMaterial, LineLoop, Mesh, MeshBasicMaterial, PerspectiveCamera, Scene, SphereGeometry, Vector3, WebGLRenderer, type Quaternion } from 'three';
import { ALIGNMENT_THRESHOLD, APPROACH_THRESHOLD, TARGETS, type Target } from './core';
import type { SavedFrame } from './storage';

// Adapted from VFTCam's scene.js: the viewer stands inside the guide sphere.
// Rendering and nearest-target selection use the same world directions and quaternion.
export function targetPosition(target: Target, radius = 98): Vector3 {
  const phi = (90 - target.pitch) * Math.PI / 180;
  const theta = target.yaw * Math.PI / 180;
  return new Vector3(radius * Math.sin(phi) * Math.sin(theta), radius * Math.cos(phi), radius * Math.sin(phi) * Math.cos(theta));
}

function patchGeometry(target: Target): BufferGeometry {
  const width = 40 * 1.05, height = 40 * (16 / 9) * 1.05;
  const columns = 24, rows = 18, radius = 96;
  const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
  const yaw = target.yaw * Math.PI / 180, pitch = target.pitch * Math.PI / 180;
  for (let v = 0; v <= rows; v++) {
    const vy = v / rows;
    for (let h = 0; h <= columns; h++) {
      const hx = h / columns;
      let point: Vector3;
      if (Math.abs(target.pitch) > 60) {
        // VFTCam's pinhole projection keeps the zenith patch from folding at the pole.
        const a = Math.tan(width * Math.PI / 360) * (2 * hx - 1);
        const b = Math.tan(height * Math.PI / 360) * (2 * vy - 1);
        point = new Vector3(
          Math.cos(pitch) * Math.sin(yaw) + a * Math.cos(yaw) - b * Math.sin(pitch) * Math.sin(yaw),
          Math.sin(pitch) + b * Math.cos(pitch),
          Math.cos(pitch) * Math.cos(yaw) - a * Math.sin(yaw) - b * Math.sin(pitch) * Math.cos(yaw)
        ).normalize().multiplyScalar(radius);
      } else {
        point = targetPosition({ ...target, yaw: target.yaw - width / 2 + width * hx, pitch: target.pitch - height / 2 + height * vy }, radius);
      }
      positions.push(point.x, point.y, point.z);
      uvs.push(1 - hx, vy);
      if (v < rows && h < columns) {
        const i = v * (columns + 1) + h;
        indices.push(i, i + columns + 1, i + 1, i + columns + 1, i + columns + 2, i + 1);
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

export class GuideScene {
  private scene = new Scene();
  private camera = new PerspectiveCamera(75, 1, 0.1, 200);
  private renderer: WebGLRenderer;
  private resizeObserver: ResizeObserver;
  private markers = new Map<number, Mesh<SphereGeometry, MeshBasicMaterial>>();
  private patches = new Map<number, Mesh<BufferGeometry, MeshBasicMaterial>>();
  private pending = new Set<number>();
  private disposed = false;

  constructor(private container: HTMLElement) {
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.domElement.className = 'capture-guide-canvas';
    this.renderer.domElement.setAttribute('aria-hidden', 'true');
    container.appendChild(this.renderer.domElement);

    const sphere = new Mesh(new SphereGeometry(100, 24, 16), new MeshBasicMaterial({ color: 0xcee5d8, wireframe: true, transparent: true, opacity: 0.23, depthWrite: false }));
    this.scene.add(sphere);
    for (const pitch of [0, 45, -45]) {
      const points = Array.from({ length: 96 }, (_, i) => targetPosition({ id: 0, yaw: i * 360 / 96, pitch }, 99));
      const ring = new LineLoop(new BufferGeometry().setFromPoints(points), new LineBasicMaterial({ color: pitch === 0 ? 0x95e5c0 : 0xd3e6d9, transparent: true, opacity: pitch === 0 ? 0.55 : 0.25 }));
      this.scene.add(ring);
    }
    for (let yaw = 0; yaw < 360; yaw += 45) {
      const points = Array.from({ length: 65 }, (_, i) => targetPosition({ id: 0, yaw, pitch: -90 + i * 180 / 64 }, 99));
      this.scene.add(new LineLoop(new BufferGeometry().setFromPoints(points), new LineBasicMaterial({ color: 0xd3e6d9, transparent: true, opacity: 0.2 })));
    }

    for (const target of TARGETS) {
      const marker = new Mesh(new SphereGeometry(2.7, 12, 10), new MeshBasicMaterial({ color: 0xffcf85, transparent: true, opacity: 0.9, depthTest: false }));
      marker.position.copy(targetPosition(target));
      marker.renderOrder = 2;
      this.markers.set(target.id, marker);
      this.scene.add(marker);
    }
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  private resize() {
    if (this.disposed) return;
    const { width, height } = this.container.getBoundingClientRect();
    if (!width || !height) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.render();
  }

  update(q: Quaternion, selected: Target | null, distance: number, completed: ReadonlySet<number>) {
    this.camera.quaternion.copy(q);
    for (const [id, marker] of this.markers) {
      marker.visible = !completed.has(id);
      const near = id === selected?.id && distance < APPROACH_THRESHOLD;
      const aligned = near && distance < ALIGNMENT_THRESHOLD;
      marker.material.color.setHex(aligned ? 0x9ee1b5 : near ? 0xffffff : 0xffcf85);
      marker.scale.setScalar(aligned ? 1.7 : near ? 1.35 : 1);
    }
    this.render();
  }

  private render() {
    if (!this.disposed && !document.hidden) this.renderer.render(this.scene, this.camera);
  }

  syncFrames(frames: SavedFrame[]) {
    const ids = new Set(frames.map(frame => frame.targetId));
    for (const [id, patch] of this.patches) {
      if (ids.has(id)) continue;
      this.scene.remove(patch);
      patch.geometry.dispose(); patch.material.map?.dispose(); patch.material.dispose();
      this.patches.delete(id);
    }
    for (const [id, marker] of this.markers) marker.visible = !ids.has(id);
    for (const frame of frames) {
      if (!this.patches.has(frame.targetId) && !this.pending.has(frame.targetId)) void this.addPatch(frame);
    }
    this.render();
  }

  private async addPatch(frame: SavedFrame) {
    const target = TARGETS.find(item => item.id === frame.targetId);
    if (!target) return;
    this.pending.add(frame.targetId);
    const url = URL.createObjectURL(frame.imageBlob);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      if (this.disposed) return;
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 1024 / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) return;
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      // Keep the reference scene's soft, transparent patch edges without a full-size pixel readback.
      context.globalCompositeOperation = 'destination-in';
      const gradient = context.createRadialGradient(canvas.width / 2, canvas.height / 2, Math.min(canvas.width, canvas.height) * 0.38, canvas.width / 2, canvas.height / 2, Math.hypot(canvas.width, canvas.height) / 2);
      gradient.addColorStop(0, 'rgba(0,0,0,1)'); gradient.addColorStop(0.85, 'rgba(0,0,0,1)'); gradient.addColorStop(1, 'rgba(0,0,0,0)');
      context.fillStyle = gradient; context.fillRect(0, 0, canvas.width, canvas.height);
      const texture = new CanvasTexture(canvas);
      const patch = new Mesh(patchGeometry(target), new MeshBasicMaterial({ map: texture, side: DoubleSide, transparent: true, opacity: 0.95, depthWrite: false }));
      patch.renderOrder = 1;
      this.patches.set(frame.targetId, patch);
      this.scene.add(patch);
      this.render();
    } catch (error) { console.error(`Could not display saved target ${frame.targetId} in the guide sphere`, error); }
    finally { URL.revokeObjectURL(url); this.pending.delete(frame.targetId); }
  }

  dispose() {
    this.disposed = true;
    this.resizeObserver.disconnect();
    this.scene.traverse(object => {
      if (object instanceof Mesh || object instanceof LineLoop) {
        object.geometry.dispose();
        const material = object.material as MeshBasicMaterial;
        material.map?.dispose(); material.dispose();
      }
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
