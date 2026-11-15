import { useEffect, useRef } from 'react';
import { Mesh, MeshBasicMaterial, PerspectiveCamera, Scene, SphereGeometry, TextureLoader, WebGLRenderer } from 'three';

export default function PanoramaViewer({ image, name }: { image: Blob; name: string }) {
  const host=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    const element=host.current;if(!element)return;
    const url=URL.createObjectURL(image);
    let renderer:WebGLRenderer, disposed=false;
    const scene=new Scene(),camera=new PerspectiveCamera(75,1,.1,1000);
    const geometry=new SphereGeometry(50,48,32);geometry.scale(-1,1,1);
    const material=new MeshBasicMaterial();const sphere=new Mesh(geometry,material);scene.add(sphere);
    let yaw=0,pitch=0,startX=0,startY=0,active=false;
    const draw=()=>{if(disposed)return;camera.rotation.order='YXZ';camera.rotation.y=yaw;camera.rotation.x=pitch;renderer.render(scene,camera);};
    const down=(event:PointerEvent)=>{active=true;startX=event.clientX;startY=event.clientY;element.setPointerCapture(event.pointerId);};
    const move=(event:PointerEvent)=>{if(!active)return;yaw-=(event.clientX-startX)*.004;pitch=Math.max(-Math.PI/2,Math.min(Math.PI/2,pitch-(event.clientY-startY)*.004));startX=event.clientX;startY=event.clientY;draw();};
    const up=()=>{active=false;};
    let observer:ResizeObserver | undefined;
    try {
      renderer=new WebGLRenderer({antialias:true,powerPreference:'low-power'});
      renderer.setPixelRatio(Math.min(devicePixelRatio||1,2));element.appendChild(renderer.domElement);
      observer=new ResizeObserver(()=>{const w=element.clientWidth,h=element.clientHeight;if(!w||!h)return;renderer.setSize(w,h);camera.aspect=w/h;camera.updateProjectionMatrix();draw();});observer.observe(element);
      new TextureLoader().load(url,texture=>{if(disposed){texture.dispose();return;}material.map=texture;material.needsUpdate=true;draw();});
      element.addEventListener('pointerdown',down);element.addEventListener('pointermove',move);element.addEventListener('pointerup',up);element.addEventListener('pointercancel',up);
    } catch (error) { console.error('Cannot show panorama viewer',error); }
    return ()=>{disposed=true;observer?.disconnect();element.removeEventListener('pointerdown',down);element.removeEventListener('pointermove',move);element.removeEventListener('pointerup',up);element.removeEventListener('pointercancel',up);material.map?.dispose();material.dispose();geometry.dispose();renderer?.dispose();renderer?.domElement.remove();URL.revokeObjectURL(url);};
  },[image]);
  return <div ref={host} className="panorama-viewer" role="img" aria-label={`Interactive 360-degree panorama of ${name}. Drag to look around.`} />;
}
