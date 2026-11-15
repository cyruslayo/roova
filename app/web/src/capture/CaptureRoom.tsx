import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Camera, Check, Compass, Focus, House, RotateCcw, ShieldAlert } from 'lucide-react';
import type { Quaternion } from 'three';
import { api, type Tour } from '../api';
import { ALIGNMENT_THRESHOLD, APPROACH_THRESHOLD, CAPTURE_HOLD_MS, LEVEL_TOLERANCE, TARGETS, nearestTarget, orientationQuaternion, poseFromQuaternion, type Target } from './core';
import { loadFrames, saveFrame, type SavedFrame } from './storage';
import { GuideScene } from './GuideScene';

type Alignment = { target: Target | null; distance: number; level: boolean; holding: boolean };
const INITIAL: Alignment = { target: null, distance: Infinity, level: true, holding: false };

function errorText(error: unknown, action: 'camera' | 'motion' | 'storage') {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return `${action === 'camera' ? 'Camera' : 'Motion'} access was denied. Allow it in your browser/site settings, then try again.`;
  if (name === 'NotFoundError') return 'No camera was found. Connect a camera and try again.';
  if (name === 'QuotaExceededError') return 'Device storage is full. Free space, then retry capture. This target has not been marked complete.';
  if (action === 'storage') return 'Could not save or restore local room images. Check browser storage settings and available space, then retry.';
  return error instanceof Error ? error.message : `Could not enable ${action}. Please try again.`;
}

export default function CaptureRoom({ roomId }: { roomId: string }) {
  const [tour, setTour] = useState<Tour | null>(null);
  const [frames, setFrames] = useState<SavedFrame[]>([]);
  const [ready, setReady] = useState(false);
  const [camera, setCamera] = useState(false);
  const [motion, setMotion] = useState(false);
  const [sensor, setSensor] = useState(false);
  const [alignment, setAlignment] = useState<Alignment>(INITIAL);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [previewUrl, setPreviewUrl] = useState('');
  const video = useRef<HTMLVideoElement>(null);
  const guideContainer = useRef<HTMLDivElement>(null);
  const guide = useRef<GuideScene | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const captured = useRef(new Set<number>());
  const pose = useRef<Quaternion | null>(null);
  const lastSensor = useRef(0);
  const tilt = useRef<number | null>(null);
  const current = useRef<Alignment>(INITIAL);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  const captureBlocked = useRef(false);

  const clearHold = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    current.current = { ...current.current, holding: false };
  }, []);

  const restore = useCallback(async () => {
    try {
      const [result, saved] = await Promise.all([api.get(roomId), loadFrames(roomId)]);
      captured.current = new Set(saved.map(frame => frame.targetId));
      setTour(result.tour); setFrames(saved); setReady(true); setError('');
    } catch (err) { setError(errorText(err, 'storage')); setReady(false); }
  }, [roomId]);

  useEffect(() => { void restore(); }, [restore]);
  useEffect(() => {
    if (!camera || !guideContainer.current) return;
    try {
      const scene = new GuideScene(guideContainer.current);
      guide.current = scene;
      scene.syncFrames(frames);
      if (pose.current) scene.update(pose.current, current.current.target, current.current.distance, captured.current);
      return () => { guide.current = null; scene.dispose(); };
    } catch (err) { setError(err instanceof Error ? `Could not start the 3D guide: ${err.message}` : 'Could not start the 3D guide.'); }
  // Scene lifetime is tied to the camera; subsequent frame changes sync below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera]);
  useEffect(() => { guide.current?.syncFrames(frames); }, [frames]);
  useEffect(() => {
    const image = frames.at(-1);
    if (!image) { setPreviewUrl(''); return; }
    const url = URL.createObjectURL(image.imageBlob);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [frames]);
  useEffect(() => () => {
    clearHold(); stream.current?.getTracks().forEach(track => track.stop());
  }, [clearHold]);

  const startCamera = async () => {
    setError('');
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setError('Camera capture needs HTTPS or localhost in a browser with camera support.'); return;
    }
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
      if (!video.current) { media.getTracks().forEach(track => track.stop()); return; }
      stream.current?.getTracks().forEach(track => track.stop());
      stream.current = media;
      video.current.srcObject = media;
      await video.current.play();
      setCamera(true);
    } catch (err) { stream.current?.getTracks().forEach(track => track.stop()); stream.current = null; setError(errorText(err, 'camera')); }
  };

  const startMotion = async () => {
    setError('');
    if (!window.isSecureContext || !('DeviceOrientationEvent' in window)) { setError('Motion sensing needs HTTPS and a phone with orientation sensors.'); return; }
    try {
      // Safari requires this call directly inside the tap handler, before any other await.
      const orientationEvent = window.DeviceOrientationEvent as typeof DeviceOrientationEvent & { requestPermission?: () => Promise<string> };
      const motionEvent = window.DeviceMotionEvent as typeof DeviceMotionEvent & { requestPermission?: () => Promise<string> } | undefined;
      // Request both in the same tap activation; Safari may reject a second request after an await.
      const orientationPermission = orientationEvent.requestPermission?.();
      const motionPermission = motionEvent?.requestPermission?.();
      if ((orientationPermission && await orientationPermission !== 'granted') || (motionPermission && await motionPermission !== 'granted')) throw new DOMException('Motion access was denied.', 'NotAllowedError');
      setMotion(true);
    } catch (err) { setError(errorText(err, 'motion')); }
  };

  const capture = useCallback(async (target: Target) => {
    const source = video.current;
    if (!source || !pose.current || savingRef.current || captureBlocked.current || captured.current.has(target.id) || Date.now() - lastSensor.current > 800) return;
    savingRef.current = true; setSaving(true); clearHold();
    try {
      if (source.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !source.videoWidth || !source.videoHeight) throw new Error('Camera frame is not ready. Point the camera at the room and retry.');
      const scale = Math.min(1, 1080 / source.videoWidth, 1920 / source.videoHeight);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(source.videoWidth * scale); canvas.height = Math.round(source.videoHeight * scale);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Could not prepare the camera image.');
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      // Snapshot sensor pose in the same synchronous turn as the video frame copy.
      const measured = poseFromQuaternion(pose.current.clone());
      if (!measured) throw new Error('The phone orientation is unavailable. Hold steady and retry.');
      const timestamp = new Date().toISOString();
      const videoTime = source.currentTime;
      const jpeg = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob && blob.type === 'image/jpeg' ? resolve(blob) : reject(new Error('The camera could not encode a JPEG.')), 'image/jpeg', 0.85));
      const saved = await saveFrame(roomId, target, jpeg, canvas.width, canvas.height, timestamp, videoTime, measured);
      captured.current.add(target.id);
      setFrames(previous => [...previous.filter(frame => frame.targetId !== target.id), saved]);
      setAlignment(INITIAL); setError('');
    } catch (err) { captureBlocked.current = true; setError(errorText(err, 'storage')); }
    finally { savingRef.current = false; setSaving(false); }
  }, [roomId, clearHold]);

  useEffect(() => {
    if (!motion || !camera || !ready) return;
    const onOrientation = (event: DeviceOrientationEvent) => {
      if (event.alpha === null || event.beta === null || event.gamma === null) return;
      lastSensor.current = Date.now();
      setSensor(true);
      pose.current = orientationQuaternion(event.alpha, event.beta, event.gamma);
      const { target, distance } = nearestTarget(pose.current, captured.current);
      guide.current?.update(pose.current, target, distance, captured.current);
      const level = !target || Math.abs(target.pitch) > 60 || (tilt.current !== null && Math.abs(tilt.current) < LEVEL_TOLERANCE);
      const next = { target: distance < APPROACH_THRESHOLD ? target : null, distance, level, holding: false };
      if (!next.target || distance >= ALIGNMENT_THRESHOLD || !level || savingRef.current || captureBlocked.current || (timer.current && current.current.target?.id !== next.target.id)) clearHold();
      if (next.target && distance < ALIGNMENT_THRESHOLD && level && !timer.current && !savingRef.current && !captureBlocked.current) {
        next.holding = true;
        const id = next.target.id;
        timer.current = setTimeout(() => {
          timer.current = null;
          if (current.current.target?.id === id && current.current.distance < ALIGNMENT_THRESHOLD && current.current.level && Date.now() - lastSensor.current < 800) void capture(next.target!);
        }, CAPTURE_HOLD_MS);
      } else next.holding = timer.current !== null;
      current.current = next; setAlignment(next);
    };
    const onMotion = (event: DeviceMotionEvent) => {
      const x = event.accelerationIncludingGravity?.x;
      if (typeof x === 'number') tilt.current = Math.asin(Math.max(-1, Math.min(1, x / 9.8))) * 180 / Math.PI;
    };
    addEventListener('deviceorientation', onOrientation);
    addEventListener('devicemotion', onMotion);
    return () => { removeEventListener('deviceorientation', onOrientation); removeEventListener('devicemotion', onMotion); clearHold(); };
  }, [motion, camera, ready, capture, clearHold]);

  const status = saving ? 'Saving your frame…' : captureBlocked.current ? 'Save failed · retry when ready' : !camera ? 'Enable the rear camera to begin' : !motion ? 'Enable motion to guide your capture' : !sensor ? 'Waiting for phone orientation… Keep this page open on a phone.' : !alignment.target ? 'Turn slowly to find a target' : tilt.current === null && Math.abs(alignment.target.pitch) <= 60 ? 'Waiting for phone level sensor…' : !alignment.level ? 'Level your phone' : alignment.holding ? 'Hold steady for one second' : alignment.distance < ALIGNMENT_THRESHOLD ? 'Aligned' : 'Almost there · move toward the target';

  return <main className="capture-page">
    <header className="capture-header"><a href="/studio" className="capture-back"><ArrowLeft size={18}/> Studio</a><span className="capture-brand"><House size={17}/> stillroom<span>.</span></span><span className="capture-private">PRIVATE CAPTURE</span></header>
    <div className="capture-layout"><section className="capture-view" aria-label="Live room camera and target guidance">
      <video ref={video} muted playsInline autoPlay className="capture-video" />
      {camera && <div ref={guideContainer} className="capture-guide" aria-hidden="true" />}
      {camera && sensor && <div className={`capture-reticle ${alignment.holding ? 'holding' : alignment.target ? 'approaching' : ''}`} aria-hidden="true"><Focus size={74} strokeWidth={1.2}/></div>}
      <div className="capture-view-label"><span>ROOM / {tour?.roomName ?? 'Loading…'}</span><strong>{alignment.target ? `TARGET ${String(alignment.target.id).padStart(2, '0')}` : 'GUIDED CAPTURE'}</strong></div>
      <div className="capture-feedback" role="status">{status}</div>
    </section><section className="capture-panel"><span className="section-overline">ROOM SESSION</span><h1>{tour?.roomName ?? 'Opening room…'}</h1><p>Move your phone toward a target. When aligned, hold steady to capture automatically. Frames stay on this device.</p>
      {error && <div className="capture-error" role="alert"><ShieldAlert size={20}/><span>{error}</span>{(!ready || captureBlocked.current) && <button type="button" onClick={() => { if (!ready) void restore(); else { captureBlocked.current = false; setError(''); } }}><RotateCcw size={15}/> {ready ? 'Retry capture' : 'Retry loading'}</button>}</div>}
      <div className="capture-permissions"><button type="button" className="capture-action" disabled={!ready || camera} onClick={() => void startCamera()}><Camera size={20}/><span>{camera ? 'Camera ready' : 'Enable camera'}</span>{camera && <Check size={18}/>}</button><button type="button" className="capture-action" disabled={!ready || !camera || motion} onClick={() => void startMotion()}><Compass size={20}/><span>{motion ? 'Motion enabled' : 'Enable motion'}</span>{motion && <Check size={18}/>}</button></div>
      <div className="capture-progress"><div><span>CAPTURE PROGRESS</span><strong>{frames.length} / {TARGETS.length}</strong></div><div className="capture-targets" aria-label="37 capture targets">{TARGETS.map(target => <span key={target.id} className={frames.some(frame => frame.targetId === target.id) ? 'saved' : alignment.target?.id === target.id ? 'active' : ''} title={`Target ${target.id}, ${target.yaw}° yaw, ${target.pitch}° pitch`} aria-label={`Target ${target.id}: ${frames.some(frame => frame.targetId === target.id) ? 'captured' : 'not captured'}`} />)}</div></div>
      {frames.length > 0 && <div className="capture-saved"><h2>Saved on this device</h2><img src={previewUrl} alt={`Captured room frame for target ${frames.at(-1)?.targetId}`} /><p>Target {frames.at(-1)?.targetId} · {frames.at(-1)?.width} × {frames.at(-1)?.height} px · {new Date(frames.at(-1)!.timestamp).toLocaleString()}</p><p>Measured pose: yaw {frames.at(-1)?.pose.yaw.toFixed(1)}°, pitch {frames.at(-1)?.pose.pitch.toFixed(1)}°, roll {frames.at(-1)?.pose.roll.toFixed(1)}°</p></div>}
    </section></div>
  </main>;
}
