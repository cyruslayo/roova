import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Check, Download, RotateCcw, ShieldAlert } from 'lucide-react';
import { api, type PanoramaRoom as Room, type Tour } from '../api';
import { loadFrames, loadPanorama, loadStitchJob, savePanorama, saveStitchJob, type SavedPanorama, type StitchJob } from './storage';
import { requireCompleteRoom, stitchRoom } from './stitch';
import PanoramaViewer from './PanoramaViewer';

export default function PanoramaRoom({roomId}:{roomId:string}) {
  const [tour,setTour]=useState<Tour | null>(null),[panorama,setPanorama]=useState<SavedPanorama | null>(null);
  const [room,setRoom]=useState<Room | null>(null),[uploadProgress,setUploadProgress]=useState(0);
  const [job,setJob]=useState<StitchJob | null>(null),[count,setCount]=useState(0),[progress,setProgress]=useState(0);
  const [persisted,setPersisted]=useState(false);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[ready,setReady]=useState(false);
  const refresh=useCallback(async()=>{
    try {
      const [result,frames,saved,previous]=await Promise.all([api.room(roomId),loadFrames(roomId),loadPanorama(roomId),loadStitchJob(roomId)]);
      setTour(result.tour);setRoom(result.room);setCount(frames.length);setPanorama(saved);setPersisted(!!saved);setJob(previous??null);setReady(true);setError('');
    } catch(e) {setError(e instanceof Error?e.message:'Could not restore this room.');setReady(false);}
  },[roomId]);
  useEffect(()=>{void refresh();},[refresh]);

  const stitch=async()=>{
    if(busy)return;setBusy(true);setProgress(0);setError('');
    try {
      const frames=await loadFrames(roomId);requireCompleteRoom(frames);
      const running:StitchJob={roomId,state:'running',message:'Preparing frames',updatedAt:new Date().toISOString()};
      await saveStitchJob(running);setJob(running);
      const jpeg=await stitchRoom(frames,(value,message)=>{setProgress(value);setJob({...running,message});});
      const result:SavedPanorama={roomId,imageBlob:jpeg,width:4096,height:2048,timestamp:new Date().toISOString(),sourceIds:frames.map(frame=>frame.targetId)};
      setPanorama(result);setPersisted(false);
      await savePanorama(result);
      setPersisted(true);
      const done:StitchJob={roomId,state:'complete',message:'Panorama ready',updatedAt:new Date().toISOString()};
      await saveStitchJob(done);setJob(done);setPanorama(result);
    } catch(e) {
      const message=e instanceof Error?e.message:'Panorama preparation failed.';
      setError(panorama ? message : `Panorama processing or local save failed: ${message}`);
      const failed:StitchJob={roomId,state:'failed',message,updatedAt:new Date().toISOString()};
      try{await saveStitchJob(failed);setJob(failed);}catch{/* preserve original error */}
    } finally{setBusy(false);}
  };
  const retrySave=async()=>{
    if(!panorama||busy)return;
    setBusy(true);setError('');
    try {
      await savePanorama(panorama);setPersisted(true);
      const done:StitchJob={roomId,state:'complete',message:'Panorama saved on this device',updatedAt:new Date().toISOString()};
      await saveStitchJob(done);setJob(done);
    } catch(e){setError(e instanceof Error?`Could not save panorama locally: ${e.message}`:'Could not save panorama locally.');}
    finally{setBusy(false);}
  };
  const download=()=>{
    if(!panorama)return;
    const url=URL.createObjectURL(panorama.imageBlob),link=document.createElement('a');
    link.href=url;link.download=`stillroom-${roomId}-panorama.jpg`;document.body.appendChild(link);link.click();link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),60000);
  };
  const upload=async()=>{
    if(!panorama||busy)return;
    setBusy(true);setError('');setUploadProgress(0);
    try {
      const url=URL.createObjectURL(panorama.imageBlob);
      let thumbnail:Blob;
      try {
        const image=new Image();image.src=url;await image.decode();
        const canvas=document.createElement('canvas');canvas.width=768;canvas.height=384;
        const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Could not prepare the panorama thumbnail.');
        ctx.drawImage(image,0,0,768,384);
        thumbnail=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('Could not encode panorama thumbnail.')),'image/jpeg',.8));
        canvas.width=canvas.height=1;
      } finally {URL.revokeObjectURL(url);}
      const response=await api.uploadPanorama(roomId,panorama.imageBlob,thumbnail,setUploadProgress);
      setRoom(response.room);
    } catch(e){setError(e instanceof Error?e.message:'Upload failed. Your local panorama remains saved.');}
    finally{setBusy(false);}
  };
  const publish=async()=>{
    if(busy)return;setBusy(true);setError('');
    try {const response=await api.publishRoom(roomId);setRoom(response.room);}
    catch(e){setError(e instanceof Error?e.message:'Could not publish this room.');}
    finally{setBusy(false);}
  };
  return <main className="capture-page panorama-page">
    <header className="capture-header"><a href={`/studio/capture/${encodeURIComponent(roomId)}`}><ArrowLeft size={18}/> Capture</a><strong>stillroom<span>.</span></strong><span className="capture-private">ON-DEVICE PANORAMA</span></header>
    <section className="panorama-workspace"><span className="section-overline">ROOM / {tour?.roomName??'Loading…'}</span><h1>Your room, all around.</h1>
      {!ready && !error && <p role="status">Loading saved room images…</p>}
      {error && <div className="capture-error" role="alert"><ShieldAlert size={20}/>{error}{!panorama && <button type="button" onClick={()=>void refresh()}><RotateCcw size={16}/> Reload</button>}</div>}
      {panorama ? <>
        <PanoramaViewer image={panorama.imageBlob} name={tour?.roomName??'room'}/>
        <p role="status"><Check size={17}/> {panorama.width} × {panorama.height} JPEG · {panorama.sourceIds.length} saved frames · drag to explore{persisted?' · saved on this device':' · not yet saved on this device'}</p>
        <div className="panorama-actions"><button className="primary" type="button" onClick={download}><Download size={18}/> Save JPEG</button><button type="button" className="outline" disabled={busy} onClick={()=>void stitch()}><RotateCcw size={16}/> Restitch from originals</button></div>
        {!persisted && <div className="capture-error" role="status">The stitched JPEG is available to download now, but local saving did not finish. Keep this page open and retry saving without stitching again. <button type="button" disabled={busy} onClick={()=>void retrySave()}><RotateCcw size={16}/> Retry save</button></div>}
        <section className="panorama-publish"><h2>Share this room</h2><p>Your captured frames stay on this device. Upload only the finished panorama when you're happy with the preview.</p>
          <div className="panorama-actions"><button type="button" className="outline" disabled={busy} onClick={()=>void upload()}>{busy?'Uploading or processing…':'Upload finished panorama'}</button>
            {room?.pending && <button type="button" className="primary" disabled={busy} onClick={()=>void publish()}>Publish room</button>}</div>
          {busy && uploadProgress>0 && uploadProgress<100 && <><label htmlFor="upload-progress">Upload {uploadProgress}%</label><progress id="upload-progress" value={uploadProgress} max={100}/></>}
          {room?.pending && <p role="status">Uploaded and ready to publish. Visitors cannot see the new panorama yet.</p>}
          {room?.publishedAt && tour?.slug && <p role="status"><Check size={16}/> Published: <a href={`/p/${encodeURIComponent(tour.slug)}`}>Open visitor tour</a></p>}
        </section>
      </> : ready && <div className="panorama-ready"><strong>{count} / 37 views saved</strong><p>{count===37?'Your original frames are ready for on-device panorama processing.':'Return to capture and finish all 37 targets before stitching.'}</p>
        {job?.state==='running' && !busy && <p role="status">Previous processing was interrupted. Your source frames remain saved; retry below.</p>}
        <button type="button" className="primary" disabled={busy||count!==37} onClick={()=>void stitch()}>{busy?'Processing on this device…':job?'Retry panorama':'Create panorama'}</button>
        {busy && <><label htmlFor="stitch-progress">{job?.message}</label><progress id="stitch-progress" max={100} value={progress}/></>}
      </div>}
    </section>
  </main>;
}
