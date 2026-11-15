import { TARGETS } from './core';
import type { SavedFrame } from './storage';

const WIDTH = 4096, HEIGHT = 2048;
type Progress = (percent: number, message: string) => void;
type Sample = { yaw:number; data:Uint8Array };

function overlapDifference(a:Sample,b:Sample,angle:number,tanH:number):number {
  let difference=0,count=0;
  for(const spread of [-4,-2,0,2,4])for(const v of [.32,.43,.57,.68]) {
    const first=.5+Math.tan((angle/2+spread)*Math.PI/180)/(2*tanH);
    const second=.5+Math.tan((-angle/2+spread)*Math.PI/180)/(2*tanH);
    if(first>=1||second<=0)continue;
    const x1=Math.round(first*127),x2=Math.round(second*127),y=Math.round(v*191);
    difference+=Math.abs(a.data[y*128+x1]-b.data[y*128+x2]);count++;
  }
  return count?difference/count:Infinity;
}

function calibrateFov(samples:Sample[],portrait:boolean):number | null {
  if(samples.length<9)return null;
  const pixels=(sample:Sample,u:number,v:number)=>sample.data[Math.min(191,Math.max(0,Math.round(v*191)))*128+Math.min(127,Math.max(0,Math.round(u*127)))];
  let best={fov:43.2,score:Infinity},worst=0;
  for(let short=40;short<=48;short+=.5){
    const tanH=Math.tan(short*Math.PI/360)*(portrait?1:1.5);
    let score=0,count=0,variation=0;
    for(let i=0;i<samples.length;i++){
      const a=samples[i],b=samples[(i+1)%samples.length];
      const angle=((b.yaw-a.yaw+540)%360)-180;
      if(angle<24||angle>36)continue;
      for(const spread of [-4,-2,0,2,4])for(const v of [.32,.43,.57,.68]){
        const first=.5+Math.tan((angle/2+spread)*Math.PI/180)/(2*tanH);
        const second=.5+Math.tan((-angle/2+spread)*Math.PI/180)/(2*tanH);
        if(first>=1||second<=0)continue;
        const left=pixels(a,first,v),right=pixels(b,second,v);
        score+=Math.abs(left-right);variation+=Math.abs(left-pixels(a,first+.008,v));count++;
      }
    }
    if(count<80||variation/count<2)return null;
    const average=score/count+.03*Math.abs(short-43.2);
    worst=Math.max(worst,average);
    if(average<best.score)best={fov:short,score:average};
  }
  return worst-best.score>1.5?best.fov:null;
}

function alignEquator(samples:Sample[],poses:number[],shortFov:number,portrait:boolean) {
  const tanH=Math.tan(shortFov*Math.PI/360)*(portrait?1:1.5);
  for(let i=0;i<samples.length;i++) {
    const next=(i+1)%samples.length,a=samples[i],b=samples[next];
    const angle=((b.yaw-a.yaw+540)%360)-180;
    if(angle<24||angle>36)continue;
    const baseline=overlapDifference(a,b,angle,tanH);
    if(!Number.isFinite(baseline))continue;
    let best={offset:0,score:baseline};
    for(const offset of [-2,-1.5,-1,-.5,.5,1,1.5,2]) {
      const score=overlapDifference(a,b,angle+offset,tanH);
      if(score<best.score)best={offset,score};
    }
    // Reject low-confidence matches: preserve the sensor pose rather than creating ghost seams.
    if(baseline-best.score>3&&best.score<baseline*.85)poses[(next+12)*4]+=best.offset*Math.PI/180;
  }
}

export function requireCompleteRoom(frames: SavedFrame[]) {
  const ids = new Set(frames.map(frame => frame.targetId));
  const missing = TARGETS.filter(target => !ids.has(target.id)).map(target => target.id);
  if (frames.length !== 37 || ids.size !== 37 || missing.length) throw new Error(`All 37 distinct images are required. Missing targets: ${missing.join(', ') || 'check for duplicates'}.`);
  for (const frame of frames) {
    if (frame.imageBlob.type !== 'image/jpeg' || !frame.imageBlob.size || !frame.width || !frame.height || !Number.isFinite(frame.pose.yaw) || !Number.isFinite(frame.pose.pitch))
      throw new Error(`Target ${frame.targetId} has an invalid image or pose. Restore this frame before stitching.`);
  }
}

// Adapted from the WebGL2 texture-array/best-pixel route in VFTCam app.js
// (performBestPixelStitching/renderBestPixelPanorama), never its OpenCV startStitching route.
const vertex = `#version 300 es
layout(location=0) in vec2 pos;
out vec2 uv;
void main() { uv = pos * .5 + .5; gl_Position = vec4(pos,0.,1.); }`;
const fragment = `#version 300 es
precision highp float;
precision highp sampler2DArray;
in vec2 uv;
out vec4 color;
uniform sampler2DArray images;
uniform vec4 pose[37]; // yaw, pitch, roll, exposure gain
uniform vec2 focal;
uniform float poleLimit;
const float PI=3.141592653589793;
void main() {
  float lon = (uv.x * 2. - 1.) * PI;
  // Extend the nearest valid nadir/zenith sample into the unsupported pole region.
  float lat = clamp((uv.y - .5) * PI, -poleLimit, PI * .5);
  vec3 dir = vec3(cos(lat)*sin(lon), sin(lat), cos(lat)*cos(lon));
  float best = -1.; float second = -1.;
  vec3 firstColor = vec3(0.); vec3 secondColor = vec3(0.);
  for (int i=0; i<37; i++) {
    float yaw=pose[i].x, pitch=pose[i].y, roll=pose[i].z;
    float sy=sin(yaw), cy=cos(yaw), sp=sin(pitch), cp=cos(pitch);
    vec3 forward=vec3(cp*sy,sp,cp*cy);
    float depth=dot(dir,forward);
    if(depth <= 0.) continue;
    vec3 right=vec3(cy,0.,-sy), up=vec3(-sp*sy,cp,-sp*cy);
    float x=dot(dir,right)/depth, y=dot(dir,up)/depth;
    float cr=cos(roll), sr=sin(roll);
    vec2 local=vec2(cr*x+sr*y,-sr*x+cr*y);
    vec2 texCoord=local/(2.*focal)+.5;
    if(any(lessThan(texCoord,vec2(0.))) || any(greaterThan(texCoord,vec2(1.)))) continue;
    vec3 sampleColor=texture(images,vec3(texCoord,float(i))).rgb;
    float clipped=smoothstep(.90,.98,max(max(sampleColor.r,sampleColor.g),sampleColor.b));
    sampleColor=pow(sampleColor,vec3(2.2));
    sampleColor*=mix(pose[i].w,1.,clipped);
    float score=1.-length(local/focal)*.5;
    if(score>best) { second=best; secondColor=firstColor; best=score; firstColor=sampleColor; }
    else if(score>second) { second=score; secondColor=sampleColor; }
  }
  if(best<0.) { color=vec4(0.,0.,0.,1.); return; }
  // As in the reference, feather only where overlapping samples agree; avoid ghosting detail.
  float agreement=1.-smoothstep(.12,.40,length(firstColor-secondColor));
  float feather=second>=0. ? (.08*agreement) : 0.;
  float blend=feather>0. ? .5 * (1.-clamp((best-second)/feather,0.,1.)) : 0.;
  color=vec4(pow(max(mix(firstColor,secondColor,blend),vec3(0.)),vec3(1./2.2)),1.);
}`;

function shader(gl: WebGL2RenderingContext, type: number, source: string) {
  const s = gl.createShader(type);
  if (!s) throw new Error('Could not allocate stitch shader.');
  gl.shaderSource(s, source); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'Stitch shader failed to compile.');
  return s;
}

async function imageFor(frame: SavedFrame): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(frame.imageBlob);
  try {
    const image = new Image(); image.src = url; await image.decode(); return image;
  } finally { URL.revokeObjectURL(url); }
}

export async function stitchRoom(frames: SavedFrame[], progress: Progress): Promise<Blob> {
  requireCompleteRoom(frames);
  const sorted = [...frames].sort((a,b) => a.targetId-b.targetId);
  const portrait = sorted[0].height > sorted[0].width;
  const w = portrait ? 512 : 768, h = portrait ? 768 : 512;
  const erp = document.createElement('canvas'); erp.width=WIDTH; erp.height=HEIGHT;
  const gl = erp.getContext('webgl2', { preserveDrawingBuffer:true, premultipliedAlpha:false });
  if (!gl) throw new Error('WebGL2 is required to stitch this room on this device. Source images remain saved.');
  const maxLayers = gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number;
  const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  if (maxLayers < 37 || maxSize < WIDTH) throw new Error(`This device cannot stitch a ${WIDTH} × ${HEIGHT} panorama in WebGL2. Source images remain saved.`);
  let texture: WebGLTexture | null = null, program: WebGLProgram | null = null, buffer: WebGLBuffer | null = null, vao: WebGLVertexArrayObject | null = null;
  let worker:Worker | null=null;
  try {
    texture=gl.createTexture(); if (!texture) throw new Error('Could not allocate image texture.');
    gl.bindTexture(gl.TEXTURE_2D_ARRAY,texture);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY,1,gl.RGBA8,w,h,37);
    const source=document.createElement('canvas'); source.width=w; source.height=h;
    const ctx=source.getContext('2d',{willReadFrequently:true}); if (!ctx) throw new Error('Cannot prepare camera images.');
    const samples:Sample[]=[];
    const sampling=document.createElement('canvas');sampling.width=128;sampling.height=192;
    const sampleContext=sampling.getContext('2d',{willReadFrequently:true});
    try { if(typeof OffscreenCanvas!=='undefined')worker=new Worker(new URL('./stitch-worker.ts',import.meta.url),{type:'module'}); }catch { /* main-thread fallback below */ }
    const prepare=async(frame:SavedFrame,index:number):Promise<Uint8ClampedArray>=>{
      if(worker){
        try {return await new Promise<Uint8ClampedArray>((resolve,reject)=>{
          const timeout=setTimeout(()=>reject(new Error('Worker timed out')),15000);
          worker!.onmessage=event=>{if(event.data.id!==index)return;clearTimeout(timeout);event.data.error?reject(new Error(event.data.error)):resolve(new Uint8ClampedArray(event.data.pixels));};
          worker!.onerror=()=>{clearTimeout(timeout);reject(new Error('Worker preparation failed'));};
          worker!.postMessage({id:index,image:frame.imageBlob,width:w,height:h});
        });}catch {worker.terminate();worker=null;}
      }
      const image=await imageFor(frame);
      ctx.clearRect(0,0,w,h);ctx.drawImage(image,0,0,w,h);
      return ctx.getImageData(0,0,w,h).data;
    };
    const poses: number[]=[]; const luminance: number[]=[];
    for (const [index,frame] of sorted.entries()) {
      progress(Math.floor(index/37*65),`Preparing frame ${index+1} of 37`);
      const pixels=await prepare(frame,index);
      let sum=0,count=0;
      for(let j=0;j<pixels.length;j+=256){const r=pixels[j]/255,g=pixels[j+1]/255,b=pixels[j+2]/255; const value=.2126*r+.7152*g+.0722*b;if(value<.9&&value>.04){sum+=value;count++;}}
      luminance.push(count?sum/count:.5);
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY,0,0,0,index,w,h,1,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
      if(index>=12&&index<24&&sampleContext){
        ctx.putImageData(new ImageData(pixels,w,h),0,0);
        sampleContext.drawImage(source,0,0,128,192);
        const small=sampleContext.getImageData(0,0,128,192).data,gray=new Uint8Array(128*192);
        for(let j=0;j<gray.length;j++)gray[j]=Math.round(.21*small[j*4]+.72*small[j*4+1]+.07*small[j*4+2]);
        samples.push({yaw:frame.pose.yaw,data:gray});
      }
      const {yaw,pitch,roll}=frame.pose;
      poses.push(yaw*Math.PI/180,pitch*Math.PI/180,roll*Math.PI/180,1);
      // Yield on iOS Safari rather than blocking the UI for the full 37-frame decode.
      if(index%3===2) await new Promise<void>(resolve=>setTimeout(resolve,0));
    }
    worker?.terminate();worker=null;source.width=source.height=1;sampling.width=sampling.height=1;
    const median=[...luminance].sort((a,b)=>a-b)[18];
    for(let i=0;i<37;i++) poses[i*4+3]=Math.max(.72,Math.min(1.4,Math.pow(median/luminance[i],2.2)));
    progress(68,'Compositing the 37 views on the device');
    program=gl.createProgram(); if (!program) throw new Error('Cannot allocate stitch program.');
    const vs=shader(gl,gl.VERTEX_SHADER,vertex),fs=shader(gl,gl.FRAGMENT_SHADER,fragment);
    gl.attachShader(program,vs);gl.attachShader(program,fs);gl.linkProgram(program);
    gl.deleteShader(vs);gl.deleteShader(fs);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program)||'Stitch program failed to link.');
    gl.useProgram(program);
    vao=gl.createVertexArray();gl.bindVertexArray(vao);
    buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
    gl.uniform1i(gl.getUniformLocation(program,'images'),0);
    gl.uniform4fv(gl.getUniformLocation(program,'pose[0]'),new Float32Array(poses));
    // VFTCam's indoor FOV prior; retain the actual frame aspect instead of assuming 9:16.
    const calibrated=calibrateFov(samples,portrait);
    progress(72,calibrated?`Calibrated camera field of view: ${calibrated.toFixed(1)}°`:'Using camera field-of-view baseline');
    alignEquator(samples,poses,calibrated??43.2,portrait);
    gl.uniform4fv(gl.getUniformLocation(program,'pose[0]'),new Float32Array(poses));
    const shortFov=(calibrated??43.2)*Math.PI/180;
    const tanH=portrait?Math.tan(shortFov/2):Math.tan(shortFov/2)*(w/h);
    const tanV=portrait?Math.tan(shortFov/2)*(h/w):Math.tan(shortFov/2);
    gl.uniform2f(gl.getUniformLocation(program,'focal'),tanH,tanV);
    gl.uniform1f(gl.getUniformLocation(program,'poleLimit'), Math.min(Math.PI/2, Math.PI/4+Math.atan(tanV)));
    gl.viewport(0,0,WIDTH,HEIGHT);gl.drawArrays(gl.TRIANGLES,0,3);
    if(gl.getError()!==gl.NO_ERROR)throw new Error('GPU stitch failed; your source frames are intact.');
    progress(88,'Encoding 4096 × 2048 panorama');
    const pixels=new Uint8Array(WIDTH*HEIGHT*4);
    gl.readPixels(0,0,WIDTH,HEIGHT,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
    if(gl.getError()!==gl.NO_ERROR)throw new Error('Could not read the stitched image from the GPU.');
    const rows=new Uint8ClampedArray(pixels.length);
    for(let y=0;y<HEIGHT;y++)rows.set(pixels.subarray(y*WIDTH*4,(y+1)*WIDTH*4),(HEIGHT-1-y)*WIDTH*4);
    const output=document.createElement('canvas');output.width=WIDTH;output.height=HEIGHT;
    const context=output.getContext('2d');if(!context)throw new Error('Could not encode the panorama.');
    context.putImageData(new ImageData(rows,WIDTH,HEIGHT),0,0);
    const blob=await new Promise<Blob>((resolve,reject)=>output.toBlob(result=>result?.type==='image/jpeg'?resolve(result):reject(new Error('JPEG encoding failed.')),'image/jpeg',.9));
    output.width=output.height=1;progress(100,'Panorama ready');return blob;
  } finally {
    worker?.terminate();
    if(texture)gl.deleteTexture(texture);if(buffer)gl.deleteBuffer(buffer);if(vao)gl.deleteVertexArray(vao);if(program)gl.deleteProgram(program);
    gl.getExtension('WEBGL_lose_context')?.loseContext();erp.width=erp.height=1;
  }
}
