import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { OFFSET_LIMIT, OFFSET_STEP, modeBaseFov, saveCameraSettings, type CameraSettings, type CaptureMode } from './camera-settings';

// This phone's camera settings for stitching: capture mode, field-of-view
// offsets per mode (which replace automatic calibration when non-zero), and the
// tripod floor fill. After VFTCam's FOV fine-tuning card and mode/tripod
// switches; the product's own controls and wording.
export default function CameraSettingsPanel({ settings, onChange, frameWidth, frameHeight, lastFov, busy, onApply, applyLabel }: {
  settings: CameraSettings; onChange: (next: CameraSettings) => void;
  frameWidth: number; frameHeight: number;
  lastFov?: { horizontal: number; vertical: number; source: string } | null;
  busy: boolean; onApply?: () => void; applyLabel?: string;
}) {
  const [saveFailed, setSaveFailed] = useState(false);
  const base = modeBaseFov(frameWidth, frameHeight, settings.mode);
  const offsets = settings.offsets[settings.mode];
  const manual = offsets.horizontal !== 0 || offsets.vertical !== 0;
  const update = (next: CameraSettings) => { onChange(next); setSaveFailed(!saveCameraSettings(next)); };
  const setMode = (mode: CaptureMode) => update({ ...settings, mode });
  const setOffset = (axis: 'horizontal' | 'vertical', value: number) =>
    update({ ...settings, offsets: { ...settings.offsets, [settings.mode]: { ...offsets, [axis]: value } } });
  const reset = () => update({ ...settings, offsets: { ...settings.offsets, [settings.mode]: { horizontal: 0, vertical: 0 } } });
  const sign = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(1)}°`;
  const slider = (axis: 'horizontal' | 'vertical', label: string) => {
    const id = `fov-${axis}`, value = offsets[axis], total = base[axis] + value;
    return <div className="camera-slider">
      <label htmlFor={id}><span>{label}</span><b>{total.toFixed(1)}°</b><small>{sign(value)}</small></label>
      <input id={id} type="range" min={-OFFSET_LIMIT} max={OFFSET_LIMIT} step={OFFSET_STEP} value={value} disabled={busy}
        aria-valuetext={`${total.toFixed(1)} degrees, ${sign(value)} from ${base[axis].toFixed(1)}`}
        onChange={event => setOffset(axis, parseFloat(event.target.value))}/>
    </div>;
  };
  return <details className="panorama-report camera-settings">
    <summary>Camera settings for this phone</summary>
    <p>These settings are saved in this browser on this phone and apply to every room you stitch here.</p>
    <fieldset className="camera-mode" disabled={busy}>
      <legend>Where you capture</legend>
      {(['indoor', 'outdoor'] as const).map(mode => <label key={mode} className={settings.mode === mode ? 'selected' : ''}>
        <input type="radio" name="capture-mode" value={mode} checked={settings.mode === mode} onChange={() => setMode(mode)}/>{mode === 'indoor' ? 'Indoors' : 'Outdoors'}
      </label>)}
    </fieldset>
    <div className="camera-fov">
      <p className="camera-fov-status"><b>Field of view</b> · {manual
        ? `set by hand for ${settings.mode === 'indoor' ? 'indoor' : 'outdoor'} captures; automatic calibration is skipped`
        : 'automatic: measured from your photos at each stitch'}</p>
      {slider('horizontal', 'Across (narrow side)')}
      {slider('vertical', 'Along (long side)')}
      <p className="fineprint-line">Starting point {base.horizontal.toFixed(1)}° × {base.vertical.toFixed(1)}° for {settings.mode} frames of this shape. If straight edges look doubled or broken, lower both a little and restitch; if objects look stretched apart at the seams, raise them.{lastFov ? ` Last stitch used ${lastFov.horizontal.toFixed(1)}° × ${lastFov.vertical.toFixed(1)}° (${lastFov.source}).` : ''}</p>
      <button type="button" className="text-action" disabled={busy || !manual} onClick={reset}><RotateCcw size={14}/> Back to automatic</button>
    </div>
    <label className="camera-toggle">
      <input type="checkbox" checked={settings.tripod} disabled={busy} onChange={event => update({ ...settings, tripod: event.target.checked })}/>
      <span><b>I use a tripod or stand</b><small>Covers the area straight below the camera with the surrounding floor, so the stand does not show.</small></span>
    </label>
    {saveFailed && <p role="alert">This browser did not keep the setting; it applies to this page only.</p>}
    {onApply && <button type="button" className="outline" disabled={busy} onClick={onApply}><RotateCcw size={16}/> {applyLabel ?? 'Restitch with these settings'}</button>}
  </details>;
}
