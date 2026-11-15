import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Camera, Plus } from 'lucide-react';
import { api, type PanoramaRoom, type Tour } from '../api';

export default function RoomManager({tour}:{tour:Tour}) {
  const [rooms,setRooms]=useState<PanoramaRoom[]>([]),[name,setName]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{let active=true;setRooms([]);api.rooms(tour.id).then(data=>{if(active){setRooms(data.rooms);setError('');}}).catch(e=>{if(active)setError(e instanceof Error?e.message:'Could not load rooms.');});return()=>{active=false;};},[tour.id]);
  const add=async(event:React.FormEvent)=>{
    event.preventDefault();if(busy)return;setBusy(true);setError('');
    try{const result=await api.createRoom(tour.id,name.trim());setRooms(previous=>[...previous,result.room]);setName('');}
    catch(e){setError(e instanceof Error?e.message:'Could not add room.');}finally{setBusy(false);}
  };
  const reorder=async(index:number,direction:number)=>{
    const copy=[...rooms],next=index+direction;if(next<0||next>=copy.length)return;
    [copy[index],copy[next]]=[copy[next],copy[index]];setBusy(true);setError('');
    try{await api.reorderRooms(tour.id,copy.map(room=>room.id));setRooms(copy);}
    catch(e){setError(e instanceof Error?e.message:'Could not change room order.');}finally{setBusy(false);}
  };
  return <section className="capture-entry room-manager"><div><span className="section-overline">ON-DEVICE PANORAMA ROOMS</span><h3>Capture {tour.title}</h3><p>Each room keeps its own 37 captures and panorama on this device.</p></div>
    <ol>{rooms.map((room,index)=><li key={room.id}><div><strong>{room.name}</strong><small>{room.state==='published'?'Published':room.pending?'Ready to publish':'On this device'}</small></div><div className="room-actions"><button type="button" aria-label={`Move ${room.name} up`} disabled={busy||index===0} onClick={()=>void reorder(index,-1)}><ArrowUp size={16}/></button><button type="button" aria-label={`Move ${room.name} down`} disabled={busy||index===rooms.length-1} onClick={()=>void reorder(index,1)}><ArrowDown size={16}/></button><a className="primary action-anchor" href={`/studio/capture/${encodeURIComponent(room.id)}`}><Camera size={16}/> Capture</a><a className="outline action-anchor" href={`/studio/panorama/${encodeURIComponent(room.id)}`}>Panorama</a></div></li>)}</ol>
    <form onSubmit={e=>void add(e)} className="room-create"><label htmlFor="new-room">Add a room</label><input id="new-room" value={name} maxLength={80} required placeholder="e.g. Kitchen" onChange={e=>setName(e.target.value)}/><button className="outline" type="submit" disabled={busy||!name.trim()}><Plus size={16}/> Add room</button></form>
    {tour.slug && rooms.some(room=>room.state==='published') && <a href={`/p/${encodeURIComponent(tour.slug)}`}>View published panorama tour →</a>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
