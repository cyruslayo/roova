import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, House } from 'lucide-react';
import { api, type PublicPanorama } from '../api';
import PanoramaViewer from '../capture/PanoramaViewer';

export default function PanoramaTour({slug}:{slug:string}) {
  const [data,setData]=useState<PublicPanorama|null>(null),[index,setIndex]=useState(0),[blob,setBlob]=useState<Blob|null>(null),[error,setError]=useState('');
  useEffect(()=>{let active=true;api.publicPanorama(slug).then(value=>{if(active){setData(value);setIndex(0);setError('');}}).catch(()=>{if(active)setError('This panorama tour is unavailable.');});return()=>{active=false;};},[slug]);
  const room=data?.rooms[index];
  useEffect(()=>{if(!room)return;let active=true;setBlob(null);setError('');fetch(room.panoramaUrl).then(response=>{if(!response.ok)throw new Error('Room image unavailable.');return response.blob();}).then(value=>{if(active)setBlob(value);}).catch(()=>{if(active)setError('Could not load this room panorama. Please retry.');});return()=>{active=false;};},[room]);
  return <main className="capture-page panorama-page"><header className="capture-header"><span><House size={18}/> stillroom<span>.</span></span><strong>{data?.tour.title??'Panorama tour'}</strong></header><section className="panorama-workspace"><span className="section-overline">EXPLORE THE PROPERTY</span><h1>{room?.name??'Opening tour…'}</h1>
    {blob&&room?<PanoramaViewer image={blob} name={room.name}/>:<div className="panorama-viewer panorama-loading" role="status">{error||'Loading room panorama…'}</div>}
    <nav className="panorama-room-nav" aria-label="Tour rooms"><button type="button" disabled={index===0} onClick={()=>setIndex(index-1)}><ArrowLeft size={16}/> Previous</button>
      <span>Room {index+1} of {data?.rooms.length??'…'}</span><button type="button" disabled={!data||index>=data.rooms.length-1} onClick={()=>setIndex(index+1)}>Next <ArrowRight size={16}/></button></nav>
    {data&&<div className="panorama-room-tabs">{data.rooms.map((item,position)=><button type="button" key={item.id} aria-current={position===index?'page':undefined} onClick={()=>setIndex(position)}><img src={item.thumbnailUrl} alt="" loading="lazy"/><span>{item.name}</span></button>)}</div>}
  </section></main>;
}
