import { Hono } from 'hono';
import { jwtVerify, createRemoteJWKSet } from 'jose';

export type Env = { DB: D1Database; MEDIA: R2Bucket; ASSETS: Fetcher; AUTH_MODE?: string; ACCESS_AUD?: string; ACCESS_TEAM_DOMAIN?: string; UPLOAD_PART_SIZE?: string; MAX_UPLOAD_BYTES?: string; PROCESSOR_SECRET?: string };
type Vars = { user: string };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
export const generationDedupeKey = (uploadId: string) => `generate:${uploadId}`;
export function canServeScene(tour: {state:string;active_scene_version:string|null;published_at?:string|null},scene:{id:string;review_status:string}|null) {
  return tour.state==='published'&&!!tour.published_at&&!!tour.active_scene_version&&scene?.id===tour.active_scene_version&&scene.review_status==='approved';
}
export function processorInputError(duration:unknown,bytes:unknown):string|null {
  const seconds=Number(duration),size=Number(bytes);
  if(!Number.isFinite(seconds)||seconds<=0||seconds>30)return 'duration must be positive and <=30 seconds';
  if(!Number.isSafeInteger(size)||size<=0||size>100_000_000)return 'prepared provider input bytes must be 1..100,000,000';
  return null;
}
const DEMO_ASSETS = ['poster.webp','panorama.png','100k.spz','500k.spz'] as const;
export function canReviewScene(ownerId:string,requesterId:string,scene:{id:string}|null) { return !!scene&&ownerId===requesterId; }
export function demoImportError(worldId:unknown,assets:Iterable<string>):string|null {
  if(typeof worldId!=='string'||!worldId.trim())return 'worldId is required';
  const files=new Set(assets);return DEMO_ASSETS.some(name=>!files.has(name))?'poster.webp, panorama.png, 100k.spz, and 500k.spz are required':null;
}

async function verifyAccess(token: string, env: Env) {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) throw new Error('Cloudflare Access is not configured');
  const jwks = createRemoteJWKSet(new URL(`${env.ACCESS_TEAM_DOMAIN.replace(/\/$/, '')}/cdn-cgi/access/certs`));
  const { payload } = await jwtVerify(token, jwks, { audience: env.ACCESS_AUD, issuer: env.ACCESS_TEAM_DOMAIN });
  if (!payload.sub || !payload.email) throw new Error('Access identity missing subject or email');
  return { sub: String(payload.sub), email: String(payload.email) };
}
app.use('/api/*', async (c, next) => {
  if (c.req.path.startsWith('/api/public/')) return next();
  // Worker-to-processor endpoints use a separately configured high-entropy secret.
  if (c.req.path.startsWith('/api/internal/')) {
    if (!c.env.PROCESSOR_SECRET || c.req.header('authorization') !== `Bearer ${c.env.PROCESSOR_SECRET}`) return json({ error: 'unauthorized' }, 401);
    c.set('user', 'processor'); return next();
  }
  let subject: string;
  if (c.env.AUTH_MODE === 'local') {
    // Local mode is deliberately loopback-only and requires a generated per-developer credential.
    const host = new URL(c.req.url).hostname;
    const supplied = c.req.header('x-local-dev-key');
    if (!['localhost', '127.0.0.1'].includes(host) || !c.env.PROCESSOR_SECRET || supplied !== c.env.PROCESSOR_SECRET) return json({ error: 'unauthorized' }, 401);
    subject = 'local-operator';
  } else {
    try { const token = c.req.header('cf-access-jwt-assertion'); if (!token) throw new Error(); subject = (await verifyAccess(token, c.env)).sub; }
    catch { return json({ error: 'unauthorized' }, 401); }
  }
  c.set('user', subject); await next();
});

async function ensureUser(db: D1Database, sub: string) {
  const row = await db.prepare('SELECT id FROM users WHERE id=?').bind(sub).first<{id:string}>();
  if (!row) await db.prepare('INSERT INTO users(id,email,role,created_at) VALUES(?,?,?,?)').bind(sub, `${sub}@access.invalid`, 'operator', now()).run();
}
async function owned(db: D1Database, tourId: string, user: string) {
  return db.prepare('SELECT * FROM tours WHERE id=? AND owner_id=?').bind(tourId,user).first<any>();
}
const tourDTO = (t: any) => ({ id:t.id, title:t.title, roomName:t.room_name, slug:t.slug, state:t.state, publishedAt:t.published_at, failureReason:t.failure_reason, activeSceneVersion:t.active_scene_version, createdAt:t.created_at, updatedAt:t.updated_at });

app.get('/api/tours', async c => { await ensureUser(c.env.DB,c.get('user')); const {results=[]} = await c.env.DB.prepare('SELECT * FROM tours WHERE owner_id=? ORDER BY updated_at DESC').bind(c.get('user')).all<any>(); return json({tours:results.map(tourDTO)}); });
app.post('/api/tours', async c => {
  await ensureUser(c.env.DB,c.get('user')); const body=await c.req.json<any>().catch(()=>({}));
  const title=String(body.title??'').trim(), room=String(body.roomName??'').trim(); if(!title||title.length>120||room.length>120) return json({error:'title (1–120 chars) and roomName (0–120 chars) required'},400);
  const tourId=id(), slug=`${title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,48)||'tour'}-${tourId.slice(0,8)}`;
  await c.env.DB.prepare('INSERT INTO tours(id,owner_id,title,room_name,slug,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').bind(tourId,c.get('user'),title,room,slug,'draft',now(),now()).run();
  return json({tour:tourDTO(await owned(c.env.DB,tourId,c.get('user')))},201);
});
// Local-only raw-video fixture path: private by default and enters the same processor queue as uploads.
app.post('/api/local/demo-import',async c=>{
  if(c.env.AUTH_MODE!=='local')return json({error:'demo import is available only in local auth mode'},404);
  const bytes=Number(c.req.header('content-length')),max=Number(c.env.MAX_UPLOAD_BYTES??1073741824);if(!Number.isSafeInteger(bytes)||bytes<=0||bytes>max||!c.req.raw.body)return json({error:'valid Content-Length and raw video body required'},400);
  const title=(c.req.header('x-tour-title')??'Local demo').slice(0,120),room=(c.req.header('x-room-name')??'Demo room').slice(0,120),tourId=id(),uploadId=id(),slug=`demo-${tourId.slice(0,8)}`,key=`private/${tourId}/source/${uploadId}/demo-video`;
  await ensureUser(c.env.DB,c.get('user'));await c.env.MEDIA.put(key,c.req.raw.body,{httpMetadata:{contentType:c.req.header('content-type')??'application/octet-stream'}});
  await c.env.DB.prepare("INSERT INTO tours(id,owner_id,title,room_name,slug,state,created_at,updated_at) VALUES(?,?,?,?,?,'preparing',?,?)").bind(tourId,c.get('user'),title,room,slug,now(),now()).run();
  await c.env.DB.prepare("INSERT INTO uploads(id,tour_id,r2_key,provider_upload_id,bytes,mime,file_name,status,created_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(uploadId,tourId,key,'local-demo',bytes,c.req.header('content-type')??'application/octet-stream','demo-video','complete',now(),now()).run();
  await c.env.DB.prepare("INSERT INTO generation_jobs(id,tour_id,upload_id,dedupe_key,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").bind(id(),tourId,uploadId,generationDedupeKey(uploadId),'queued',now(),now()).run();return json({tour:tourDTO(await owned(c.env.DB,tourId,c.get('user')))},201);
});
// Local-only fixture path: import an already-generated scene without starting a paid job.
app.post('/api/local/demo-scene',async c=>{
  if(c.env.AUTH_MODE!=='local')return json({error:'local fixtures are disabled'},404);
  const b=await c.req.json<any>().catch(()=>({}));
  if(typeof b.title!=='string'||!b.title.trim()||b.title.length>120||typeof b.roomName!=='string'||b.roomName.length>120)return json({error:'title and roomName required'},400);
  await ensureUser(c.env.DB,c.get('user'));
  const tourId=id(),version=id(),stamp=now(),slug=`demo-${tourId.slice(0,8)}`;
  await c.env.DB.prepare("INSERT INTO tours(id,owner_id,title,room_name,slug,state,created_at,updated_at) VALUES(?,?,?,?,?,'draft',?,?)").bind(tourId,c.get('user'),b.title.trim(),b.roomName.trim(),slug,stamp,stamp).run();
  return json({tourId,version,slug},201);
});
app.put('/api/local/demo-scene/:id/assets/:file',async c=>{
  if(c.env.AUTH_MODE!=='local')return json({error:'local fixtures are disabled'},404);
  const t=await owned(c.env.DB,c.req.param('id'),c.get('user'));if(!t||t.state!=='draft')return json({error:'not found'},404);
  const file=c.req.param('file');if(!DEMO_ASSETS.includes(file as typeof DEMO_ASSETS[number])||!c.req.raw.body)return json({error:'unsupported asset'},400);
  const mime=assetDetails(file)?.type;if(c.req.header('content-type')!==mime)return json({error:'content type mismatch'},415);
  const version=c.req.query('version');if(!version||!/^[-a-f0-9]{36}$/.test(version))return json({error:'invalid version'},400);
  const key=`private/${t.id}/v/${version}/${file}`;
  const object=await c.env.MEDIA.put(key,c.req.raw.body,{httpMetadata:{contentType:mime}});
  return json({file,bytes:object.size});
});
app.post('/api/local/demo-scene/:id/complete',async c=>{
  if(c.env.AUTH_MODE!=='local')return json({error:'local fixtures are disabled'},404);
  const t=await owned(c.env.DB,c.req.param('id'),c.get('user'));if(!t||t.state!=='draft')return json({error:'not found'},404);
  const b=await c.req.json<any>().catch(()=>({}));if(typeof b.version!=='string'||!/^[-a-f0-9]{36}$/.test(b.version))return json({error:'invalid version'},400);
  const problem=demoImportError(b.worldId,DEMO_ASSETS);if(problem)return json({error:problem},400);
  const keys=DEMO_ASSETS.map(file=>`private/${t.id}/v/${b.version}/${file}`);
  for(const key of keys){const obj=await c.env.MEDIA.head(key);if(!obj||!obj.size)return json({error:`missing ${key.split('/').pop()}`},422);}
  const spatial=b.spatial??null;
  if(spatial&&(typeof spatial.metricScaleFactor!=='number'||typeof spatial.groundPlaneOffset!=='number'))return json({error:'invalid spatial metadata'},400);
  await c.env.DB.prepare("INSERT INTO scene_versions(id,tour_id,world_id,poster_key,panorama_key,small_spz_key,large_spz_key,spatial_json,review_status,created_at) VALUES(?,?,?,?,?,?,?,?,'pending',?)").bind(b.version,t.id,b.worldId,...keys,JSON.stringify(spatial),now()).run();
  await c.env.DB.prepare("UPDATE tours SET state='ready_for_review',updated_at=? WHERE id=?").bind(now(),t.id).run();
  return json({tour:tourDTO(await owned(c.env.DB,t.id,c.get('user'))),reviewUrl:`/studio/demo/${t.id}`});
});
app.put('/api/local/demo-scene/:id/source',async c=>{
  if(c.env.AUTH_MODE!=='local')return json({error:'local fixtures are disabled'},404);
  const t=await owned(c.env.DB,c.req.param('id'),c.get('user'));if(!t||!c.req.raw.body||c.req.header('content-type')!=='video/mp4')return json({error:'tour and MP4 source required'},400);
  const object=await c.env.MEDIA.put(`private/${t.id}/source/review.mp4`,c.req.raw.body,{httpMetadata:{contentType:'video/mp4'}});
  return json({bytes:object.size});
});
async function reviewScene(db:D1Database,tour:any) {
  const pending=await db.prepare(`SELECT s.* FROM scene_versions s LEFT JOIN generation_jobs j ON j.pending_version_id=s.id
    WHERE s.tour_id=? AND ((s.review_status='pending' AND (j.state='ready_for_review' OR (j.id IS NULL AND ?='ready_for_review')))
    OR (s.review_status='approved' AND s.id<>COALESCE(?, '') AND (j.state='approved' OR j.id IS NULL))) ORDER BY s.created_at DESC LIMIT 1`).bind(tour.id,tour.state,tour.active_scene_version).first<any>();
  if(pending)return pending;
  return tour.active_scene_version?db.prepare('SELECT * FROM scene_versions WHERE id=? AND tour_id=?').bind(tour.active_scene_version,tour.id).first<any>():null;
}
function reviewSceneDTO(tourId:string,v:any) { const base=`/api/tours/${encodeURIComponent(tourId)}/scenes/${encodeURIComponent(v.id)}/assets/`;return { ...sceneDTO(v),posterUrl:base+'poster',panoramaUrl:v.panorama_key?base+'panorama':null,smallSpzUrl:base+'small-spz',largeSpzUrl:v.large_spz_key?base+'large-spz':null,worldId:v.world_id }; }
app.get('/api/tours/:id', async c => { const t=await owned(c.env.DB,c.req.param('id'),c.get('user')); if(!t)return json({error:'not found'},404);const scene=await reviewScene(c.env.DB,t);const u=await c.env.DB.prepare("SELECT id FROM uploads WHERE tour_id=? AND status='complete' ORDER BY completed_at DESC LIMIT 1").bind(t.id).first<any>();const local=await c.env.MEDIA.head(`private/${t.id}/source/review.mp4`);return json({tour:tourDTO(t),scene:scene&&canReviewScene(t.owner_id,c.get('user'),scene)?reviewSceneDTO(t.id,scene):null,sourceUrl:u||local?`/api/tours/${t.id}/source`:null}); });
app.get('/api/tours/:id/source',async c=>{
  const t=await owned(c.env.DB,c.req.param('id'),c.get('user'));if(!t)return json({error:'not found'},404);
  const u=await c.env.DB.prepare("SELECT r2_key FROM uploads WHERE tour_id=? AND status='complete' ORDER BY completed_at DESC LIMIT 1").bind(t.id).first<any>();
  const key=u?.r2_key??`private/${t.id}/source/review.mp4`,meta=await c.env.MEDIA.head(key);if(!meta)return json({error:'not found'},404);
  const range=c.req.header('range'),match=range?.match(/^bytes=(\d+)-(\d*)$/);
  if(range&&!match)return new Response(null,{status:416,headers:{'content-range':`bytes */${meta.size}`}});
  const start=match?Number(match[1]):0,end=match?Math.min(match[2]?Number(match[2]):meta.size-1,meta.size-1):meta.size-1;
  if(start>=meta.size||end<start)return new Response(null,{status:416,headers:{'content-range':`bytes */${meta.size}`}});
  const object=await c.env.MEDIA.get(key,match?{range:{offset:start,length:end-start+1}}:undefined);if(!object)return json({error:'not found'},404);
  const headers=new Headers({'cache-control':'private, no-store','accept-ranges':'bytes','content-length':String(end-start+1)});
  object.writeHttpMetadata(headers);if(match)headers.set('content-range',`bytes ${start}-${end}/${meta.size}`);
  return new Response(object.body,{status:match?206:200,headers});
});
app.get('/api/tours/:id/scenes/:version/assets/:kind',async c=>{const tour=await owned(c.env.DB,c.req.param('id'),c.get('user'));if(!tour)return json({error:'not found'},404);const scene=await c.env.DB.prepare('SELECT * FROM scene_versions WHERE id=? AND tour_id=?').bind(c.req.param('version'),tour.id).first<any>();if(!canReviewScene(tour.owner_id,c.get('user'),scene))return json({error:'not found'},404);const field:Record<string,string>={poster:'poster_key',panorama:'panorama_key','small-spz':'small_spz_key','large-spz':'large_spz_key'},key=scene[field[c.req.param('kind')]];if(!key)return json({error:'not found'},404);const object=await c.env.MEDIA.get(key);if(!object)return json({error:'not found'},404);const headers=new Headers({'cache-control':'private, no-store'});object.writeHttpMetadata(headers);headers.set('etag',object.httpEtag);return new Response(object.body,{headers});});
const PART_SIZE=8*1024*1024;
const partSizeFor = (env: Env) => Math.max(5*1024*1024,Math.min(10*1024*1024,Number(env.UPLOAD_PART_SIZE??PART_SIZE)));
app.post('/api/tours/:id/uploads', async c=>{
  const t=await owned(c.env.DB,c.req.param('id'),c.get('user')); if(!t)return json({error:'not found'},404);
  const b=await c.req.json<any>().catch(()=>({})), bytes=Number(b.bytes), max=Number(c.env.MAX_UPLOAD_BYTES??1073741824), partSize=partSizeFor(c.env);
  if(!Number.isSafeInteger(bytes)||bytes<=0||bytes>max)return json({error:`bytes must be 1–${max}`},400);
  const uploadId=id(), key=`private/${t.id}/source/${uploadId}/${String(b.fileName??'video').replace(/[^a-zA-Z0-9._-]/g,'_')}`;
  const multipart=await c.env.MEDIA.createMultipartUpload(key,{httpMetadata:{contentType:String(b.mime??'application/octet-stream')}});
  await c.env.DB.prepare('INSERT INTO uploads(id,tour_id,r2_key,provider_upload_id,bytes,mime,file_name,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(uploadId,t.id,key,multipart.uploadId,bytes,String(b.mime??'application/octet-stream'),String(b.fileName??'video'), 'uploading',now()).run();
  await c.env.DB.prepare("UPDATE tours SET state='uploading',updated_at=? WHERE id=?").bind(now(),t.id).run(); return json({uploadId,partSize},201);
});
app.get('/api/uploads/:uploadId',async c=>{
  const u=await c.env.DB.prepare('SELECT u.*,t.owner_id FROM uploads u JOIN tours t ON t.id=u.tour_id WHERE u.id=?').bind(c.req.param('uploadId')).first<any>();
  if(!u||u.owner_id!==c.get('user'))return json({error:'not found'},404);
  const {results=[]}=await c.env.DB.prepare('SELECT part_number,etag FROM upload_parts WHERE upload_id=? ORDER BY part_number').bind(u.id).all<any>();
  return json({uploadId:u.id,status:u.status,bytes:u.bytes,partSize:partSizeFor(c.env),parts:results.map((p:any)=>({partNumber:p.part_number,etag:p.etag}))});
});
app.put('/api/uploads/:uploadId/parts/:partNumber',async c=>{
  const u=await c.env.DB.prepare('SELECT u.*,t.owner_id FROM uploads u JOIN tours t ON t.id=u.tour_id WHERE u.id=?').bind(c.req.param('uploadId')).first<any>(); if(!u||u.owner_id!==c.get('user'))return json({error:'not found'},404);
  const n=Number(c.req.param('partNumber')), size=partSizeFor(c.env), body=c.req.raw.body; if(!Number.isInteger(n)||n<1||n>10000||!body)return json({error:'invalid part'},400);
  const start=(n-1)*size, expected=Math.min(size,u.bytes-start), declared=Number(c.req.header('content-length')); if(expected<=0||Number.isFinite(declared)&&declared!==expected)return json({error:'part size does not match declared upload size'},400);
  const obj=await c.env.MEDIA.resumeMultipartUpload(u.r2_key,u.provider_upload_id).uploadPart(n,body); await c.env.DB.prepare('INSERT INTO upload_parts(upload_id,part_number,etag) VALUES(?,?,?) ON CONFLICT(upload_id,part_number) DO UPDATE SET etag=excluded.etag').bind(u.id,n,obj.etag).run(); return json({etag:obj.etag});
});
app.post('/api/uploads/:uploadId/complete',async c=>{
  const u=await c.env.DB.prepare('SELECT u.*,t.owner_id,t.id AS tid FROM uploads u JOIN tours t ON t.id=u.tour_id WHERE u.id=?').bind(c.req.param('uploadId')).first<any>(); if(!u||u.owner_id!==c.get('user'))return json({error:'not found'},404);
  if(u.status==='complete'){const t=await owned(c.env.DB,u.tid,c.get('user')); return json({tour:tourDTO(t)});}
  const body=await c.req.json<any>().catch(()=>({})), parts=Array.isArray(body.parts)?body.parts:[], size=partSizeFor(c.env), count=Math.ceil(u.bytes/size);
  if(parts.length!==count||parts.some((p:any,i:number)=>p.partNumber!==i+1||typeof p.etag!=='string'))return json({error:'complete requires all parts in ascending order'},400);
  const stored=await c.env.DB.prepare('SELECT part_number,etag FROM upload_parts WHERE upload_id=? ORDER BY part_number').bind(u.id).all<any>(); if(stored.results.length!==count||parts.some((p:any,i:number)=>stored.results[i].part_number!==p.partNumber||stored.results[i].etag!==p.etag))return json({error:'part manifest mismatch'},409);
  const m=c.env.MEDIA.resumeMultipartUpload(u.r2_key,u.provider_upload_id); await m.complete(parts.map((p:any)=>({partNumber:p.partNumber,etag:p.etag})));
  await c.env.DB.prepare("UPDATE uploads SET status='complete',completed_at=? WHERE id=?").bind(now(),u.id).run();
  const jobId=id(); await c.env.DB.prepare("INSERT INTO generation_jobs(id,tour_id,upload_id,dedupe_key,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(dedupe_key) DO NOTHING").bind(jobId,u.tid,u.id,generationDedupeKey(u.id),'queued',now(),now()).run();
  await c.env.DB.prepare("UPDATE tours SET state='preparing',updated_at=? WHERE id=?").bind(now(),u.tid).run(); return json({tour:tourDTO(await owned(c.env.DB,u.tid,c.get('user')))});
});
app.get('/api/tours/:id/status',async c=>{const t=await owned(c.env.DB,c.req.param('id'),c.get('user'));if(!t)return json({error:'not found'},404);const job=await c.env.DB.prepare('SELECT id,state,attempts,provider_error,provider_operation_id FROM generation_jobs WHERE tour_id=? ORDER BY created_at DESC LIMIT 1').bind(t.id).first<any>(),scene=await reviewScene(c.env.DB,t);return json({tour:tourDTO(t),job:job??null,scene:scene&&canReviewScene(t.owner_id,c.get('user'),scene)?reviewSceneDTO(t.id,scene):null});});
app.post('/api/tours/:id/approve',async c=>{const t=await owned(c.env.DB,c.req.param('id'),c.get('user'));if(!t)return json({error:'not found'},404);const scene=await c.env.DB.prepare("SELECT * FROM scene_versions WHERE tour_id=? AND review_status='pending' ORDER BY created_at DESC LIMIT 1").bind(t.id).first<any>();if(!scene)return json({error:'no pending scene ready for review'},409);if(!scene.poster_key||!scene.small_spz_key)return json({error:'pending scene is missing required assets'},409);const r=await c.env.DB.prepare("UPDATE scene_versions SET review_status='approved' WHERE id=? AND tour_id=? AND review_status='pending'").bind(scene.id,t.id).run();if(!r.meta.changes)return json({error:'pending scene not found'},409);await c.env.DB.prepare("UPDATE generation_jobs SET state='approved',updated_at=? WHERE pending_version_id=?").bind(now(),scene.id).run();await c.env.DB.prepare("UPDATE tours SET state=CASE WHEN published_at IS NULL THEN 'approved' ELSE state END,updated_at=? WHERE id=?").bind(now(),t.id).run();return json({tour:tourDTO(await owned(c.env.DB,t.id,c.get('user')))});});
app.post('/api/tours/:id/publish',async c=>{const t=await owned(c.env.DB,c.req.param('id'),c.get('user'));if(!t)return json({error:'not found'},404);const candidate=await c.env.DB.prepare("SELECT id FROM scene_versions WHERE tour_id=? AND review_status='approved' ORDER BY created_at DESC LIMIT 1").bind(t.id).first<any>();const version=candidate?.id??t.active_scene_version;if(!version)return json({error:'no approved scene ready'},409);const v=await c.env.DB.prepare("SELECT * FROM scene_versions WHERE id=? AND tour_id=? AND review_status='approved'").bind(version,t.id).first<any>();if(!v||!v.poster_key||!v.small_spz_key)return json({error:'approved scene requires poster and 100k SPZ assets'},409);const stamp=now();await c.env.DB.prepare("UPDATE tours SET active_scene_version=?,state='published',published_at=COALESCE(published_at,?),updated_at=? WHERE id=?").bind(version,stamp,stamp,t.id).run();return json({tour:tourDTO(await owned(c.env.DB,t.id,c.get('user')))});});

// Contract implemented by app/processor/src/cli.ts. The bearer secret authenticates every route;
// claim is atomic and deterministic because current processor protocol has no worker identity token.
app.post('/api/internal/jobs/claim',async c=>{
  // A timed-out preparation lease cannot be retried automatically: the first processor
  // may still be working and might otherwise submit a duplicate paid generation.
  const stamp=Date.now(),candidate=await c.env.DB.prepare("SELECT * FROM generation_jobs WHERE state='queued' ORDER BY created_at LIMIT 1").first<any>();
  if(!candidate)return json({job:null});
  const version=candidate.pending_version_id??id(),lease='processor',until=stamp+120000;
  const result=await c.env.DB.prepare("UPDATE generation_jobs SET state='leased',lease_owner=?,lease_until=?,attempts=attempts+1,pending_version_id=COALESCE(pending_version_id,?),updated_at=? WHERE id=? AND state='queued'").bind(lease,until,version,now(),candidate.id).run();
  if(!result.meta.changes)return json({job:null});
  const row=await c.env.DB.prepare('SELECT j.id,j.tour_id,u.id upload_id,u.r2_key,u.bytes,t.title FROM generation_jobs j JOIN uploads u ON u.id=j.upload_id JOIN tours t ON t.id=j.tour_id WHERE j.id=?').bind(candidate.id).first<any>();
  // Preserve published state and active pointer while a replacement is being generated.
  await c.env.DB.prepare("UPDATE tours SET state=CASE WHEN published_at IS NULL THEN 'preparing' ELSE state END,updated_at=? WHERE id=?").bind(now(),row.tour_id).run();
  return json({job:{id:row.id,tourId:row.tour_id,uploadKey:row.upload_id,sourceBytes:row.bytes,title:row.title}});
});
app.get('/api/internal/media/:key',async c=>{
  const u=await c.env.DB.prepare("SELECT u.r2_key FROM uploads u JOIN generation_jobs j ON j.upload_id=u.id WHERE u.id=? AND u.status='complete'").bind(c.req.param('key')).first<any>();if(!u)return json({error:'not found'},404);const object=await c.env.MEDIA.get(u.r2_key);if(!object)return json({error:'not found'},404);const headers=new Headers();object.writeHttpMetadata(headers);headers.set('content-length',String(object.size));return new Response(object.body,{headers});
});
function assetDetails(file:string):{name:string;type:string}|null {
  if(/^poster\.(webp|jpg|png)$/.test(file))return {name:'poster',type:file.endsWith('.png')?'image/png':file.endsWith('.jpg')?'image/jpeg':'image/webp'};
  if(/^panorama\.(jpg|png)$/.test(file))return {name:'panorama',type:file.endsWith('.png')?'image/png':'image/jpeg'};
  if(file==='100k.spz')return {name:'100k',type:'application/octet-stream'};
  if(file==='500k.spz')return {name:'500k',type:'application/octet-stream'};
  return null;
}
app.post('/api/internal/jobs/:id/assets',async c=>{
  const job=await c.env.DB.prepare("SELECT * FROM generation_jobs WHERE id=? AND state IN ('leased','validating','uploaded','start_uncertain','generating','collecting')").bind(c.req.param('id')).first<any>();if(!job||!job.pending_version_id)return json({error:'job not currently leased'},409);
  const file=c.req.query('name')??'',meta=assetDetails(file),body=c.req.raw.body;if(!meta||!body)return json({error:'unsupported asset name or empty body'},400);
  const contentType=(c.req.header('content-type')??'').split(';')[0].toLowerCase();if(contentType!==meta.type)return json({error:'asset content-type mismatch'},415);
  const key=`private/${job.tour_id}/v/${job.pending_version_id}/${file}`,obj=await c.env.MEDIA.put(key,body,{httpMetadata:{contentType:meta.type}});
  await c.env.DB.prepare('INSERT INTO job_assets(job_id,name,r2_key,bytes,content_type,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(job_id,name) DO UPDATE SET r2_key=excluded.r2_key,bytes=excluded.bytes,content_type=excluded.content_type,created_at=excluded.created_at').bind(job.id,meta.name,key,obj.size,meta.type,now()).run();return json({key,bytes:obj.size});
});
app.post('/api/internal/jobs/:id/events',async c=>{
  const job=await c.env.DB.prepare('SELECT * FROM generation_jobs WHERE id=?').bind(c.req.param('id')).first<any>();if(!job||!job.pending_version_id)return json({error:'job not found or not claimed'},404);
  const b=await c.req.json<any>().catch(()=>({})),phase=String(b.phase??'');const transitions:Record<string,string[]>={leased:['validating','failed'],validating:['uploaded','failed'],uploaded:['start_uncertain','failed'],start_uncertain:['generating','failed'],generating:['collecting','failed'],collecting:['ready_for_review','failed']};
  if(job.state===phase)return json({ok:true});
  if(!(transitions[job.state]??[]).includes(phase))return json({error:`invalid job transition ${job.state} -> ${phase}`},409);
  if(phase==='start_uncertain'&&!job.provider_operation_id){await c.env.DB.prepare("UPDATE generation_jobs SET state='start_uncertain',updated_at=? WHERE id=?").bind(now(),job.id).run();}
  else if(phase==='ready_for_review'){
    const duration=Number(b.durationSeconds),bytes=Number(b.bytes),limitError=processorInputError(b.durationSeconds,b.bytes);if(limitError)return json({error:limitError},422);
    if(!b.worldId||!Array.isArray(b.assets))return json({error:'worldId and staged assets are required'},400);
    const staged=await c.env.DB.prepare('SELECT * FROM job_assets WHERE job_id=?').bind(job.id).all<any>(),byName=new Map(staged.results.map((a:any)=>[a.name,a]));
    for(const metadata of b.assets){const file=String(metadata.file??'').split('/').pop(),meta=assetDetails(file??'');if(!meta)return json({error:`unsupported staged asset ${metadata.file}`},422);const actual=byName.get(meta.name) as any;if(!actual||metadata.name!==meta.name||actual.bytes!==Number(metadata.bytes)||actual.content_type!==metadata.contentType)return json({error:`asset ${metadata.name??metadata.file} does not match verified staged R2 object`},422);const object=await c.env.MEDIA.head(actual.r2_key);if(!object||object.size!==actual.bytes)return json({error:'staged asset missing or size changed'},422);}
    const poster=byName.get('poster') as any,small=byName.get('100k') as any;if(!poster||!small)return json({error:'poster and 100k SPZ assets are required'},422);
    const panorama=byName.get('panorama') as any,large=byName.get('500k') as any;
    await c.env.DB.prepare('INSERT INTO scene_versions(id,tour_id,world_id,poster_key,panorama_key,small_spz_key,large_spz_key,spatial_json,review_status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(job.pending_version_id,job.tour_id,b.worldId,poster.r2_key,panorama?.r2_key??null,small.r2_key,large?.r2_key??null,JSON.stringify(b.spatial??null),'pending',now()).run();
    const cost= b.cost===null||b.cost===undefined?null:JSON.stringify(b.cost);
    await c.env.DB.prepare("UPDATE generation_jobs SET state='ready_for_review',world_id=?,duration_seconds=?,provider_bytes=?,cost_json=?,updated_at=? WHERE id=?").bind(b.worldId,duration,bytes,cost,now(),job.id).run();
    // Keep the old active version and published URL live until approval swaps the pointer.
    await c.env.DB.prepare("UPDATE tours SET state=CASE WHEN published_at IS NULL THEN 'ready_for_review' ELSE state END,updated_at=? WHERE id=?").bind(now(),job.tour_id).run();return json({ok:true});
  } else {
    const op=b.operationId??null,error=b.error??b.reason??null,updates:Record<string,string>={validating:'validating',uploaded:'uploaded',generating:'generating',collecting:'collecting',failed:'failed'};
    await c.env.DB.prepare('UPDATE generation_jobs SET state=?,provider_operation_id=COALESCE(?,provider_operation_id),provider_error=COALESCE(?,provider_error),duration_seconds=COALESCE(?,duration_seconds),provider_bytes=COALESCE(?,provider_bytes),transcoded=COALESCE(?,transcoded),cost_json=COALESCE(?,cost_json),world_id=COALESCE(?,world_id),updated_at=? WHERE id=?').bind(updates[phase],op,error,b.durationSeconds??null,b.bytes??null,b.transcoded===undefined?null:(b.transcoded?1:0),b.cost===undefined?null:JSON.stringify(b.cost),b.worldId??null,now(),job.id).run();
    if(phase==='failed')await c.env.DB.prepare("UPDATE tours SET state=CASE WHEN published_at IS NULL THEN 'failed' ELSE state END,failure_reason=?,updated_at=? WHERE id=?").bind(error??'Processor failed',now(),job.tour_id).run();
  }
  return json({ok:true});
});

function sceneDTO(v:any){const base=`/api/public/assets/${v.id}/`;return {posterUrl:base+'poster',panoramaUrl:v.panorama_key?base+'panorama':null,smallSpzUrl:base+'small-spz',largeSpzUrl:v.large_spz_key?base+'large-spz':null,spatial:v.spatial_json?JSON.parse(v.spatial_json):undefined};}
app.get('/api/public/tours/:slug',async c=>{const t=await c.env.DB.prepare('SELECT * FROM tours WHERE slug=?').bind(c.req.param('slug')).first<any>();if(!t)return json({error:'not found'},404);const s=t.active_scene_version?await c.env.DB.prepare('SELECT * FROM scene_versions WHERE id=? AND tour_id=?').bind(t.active_scene_version,t.id).first<any>():null;if(!canServeScene(t,s))return json({error:'not found'},404);c.header('cache-control','public, max-age=30');return json({tour:{title:t.title,roomName:t.room_name,slug:t.slug},scene:sceneDTO(s)});});
app.get('/api/public/assets/:version/:kind',async c=>{const v=await c.env.DB.prepare('SELECT s.*,t.state,t.active_scene_version,t.published_at,t.id AS tid FROM scene_versions s JOIN tours t ON t.id=s.tour_id WHERE s.id=?').bind(c.req.param('version')).first<any>();if(!v||!canServeScene(v,v))return json({error:'not found'},404);const field:Record<string,string>={'poster':'poster_key','panorama':'panorama_key','small-spz':'small_spz_key','large-spz':'large_spz_key'},key=v[field[c.req.param('kind')]];if(!key)return json({error:'not found'},404);const obj=await c.env.MEDIA.get(key);if(!obj)return json({error:'not found'},404);const headers=new Headers({'cache-control':'public, max-age=31536000, immutable'});obj.writeHttpMetadata(headers);headers.set('etag',obj.httpEtag);return new Response(obj.body,{headers});});
app.get('/t/:slug',async c=>{
  const t=await c.env.DB.prepare("SELECT * FROM tours WHERE slug=? AND state='published' AND active_scene_version IS NOT NULL").bind(c.req.param('slug')).first<any>();
  if(!t)return c.text('Tour not found',404);
  const v=await c.env.DB.prepare("SELECT * FROM scene_versions WHERE id=? AND tour_id=? AND review_status='approved'").bind(t.active_scene_version,t.id).first<any>();
  if(!v)return c.text('Tour not found',404);
  const scene=sceneDTO(v), shell=await c.env.ASSETS.fetch(new URL('/index.html',c.req.url));
  if(!shell.ok)return c.text('Web application build is unavailable',503);
  const markup=(await shell.text()).replace('<div id="root"></div>',`<div id="root"><main style="font:16px system-ui;max-width:900px;margin:auto"><img src="${scene.posterUrl}" alt="${escapeHtml(t.room_name)} room" fetchpriority="high" style="display:block;width:100%;height:auto"><h1>${escapeHtml(t.title)}</h1><p>${escapeHtml(t.room_name)}</p></main></div>`).replace('</head>',`<meta property="og:image" content="${scene.posterUrl}"><title>${escapeHtml(t.title)} — Property Tour</title></head>`);
  return c.html(markup);
});
app.get('/studio',c=>c.env.ASSETS.fetch(new URL('/index.html',c.req.url)));
app.get('/studio/*',c=>c.env.ASSETS.fetch(new URL('/index.html',c.req.url)));
function escapeHtml(v:string){return v.replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]!));}
export default app;
