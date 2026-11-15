import test from 'node:test';
import assert from 'node:assert/strict';
import { WorldLabsClient, WorldLabsHttpError } from '../dist/worldlabs.js';
import { assetCandidates, validateFileInput, worldIdFromOperation, sceneFacts } from '../dist/contract.js';
import { buildManifest } from '../dist/manifest.js';

const json = (obj, status=200, headers={}) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json', ...headers }
});
const world = {
  world_id: 'w123', display_name: 'Living Room', world_marble_url: 'https://marble.worldlabs.ai/worlds/w123',
  assets: {
    thumbnail_url: 'https://static.example.com/poster.webp',
    imagery: { pano_url: 'https://static.example.com/pano.jpg' },
    splats: { spz_urls: { '100k':'https://static.example.com/100k.spz', '500k':'https://static.example.com/500k.spz', 'full_res':'https://static.example.com/full.spz'},
      semantics_metadata: {metric_scale_factor: 0.78, ground_plane_offset: 0.32} }
  }
};
test('media upload uses required API request, separate signed upload without API key', async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({url, init});
    if (url.endsWith('media-assets:prepare_upload')) return json({
      media_asset: {media_asset_id: 'm123'},
      upload_info: {upload_url: 'https://uploads.example.com/signed', upload_method: 'PUT', required_headers: {'x-required': 'signed'}}
    });
    if (url === 'https://uploads.example.com/signed') return new Response(null, {status: 200});
    throw Error('Unexpected URL');
  };
  const client = new WorldLabsClient('a-private-key', fetcher);
  const prep = await client.prepareUpload('living.mp4','mp4');
  assert.equal(prep.media_asset.media_asset_id, 'm123');
  assert.equal(JSON.parse(calls[0].init.body).kind, 'video');
  await client.uploadBytes(prep.upload_info, new Blob(['video'],{type:'video/mp4'}), 'video/mp4', 5);
  assert.equal(calls[1].init.headers.get('x-required'), 'signed');
  assert.equal(calls[1].init.headers.has('WLT-Api-Key'), false);
  assert.equal(calls[1].init.headers.get('content-type'), 'video/mp4');
  assert.equal(calls[1].init.headers.get('content-length'), '5');
});
test('generate uses explicitly private marble-1.1 video prompt', async () => {
  let payload;
  const client = new WorldLabsClient('secret', async (url, init) => {
    assert.equal(url, 'https://api.worldlabs.ai/marble/v1/worlds:generate');
    assert.equal(init.headers['WLT-Api-Key'], 'secret');
    payload = JSON.parse(init.body);
    return json({operation_id:'op123',done:false});
  });
  const op = await client.generateVideo({mediaAssetId:'m123',displayName:'Living Room'});
  assert.equal(op.operation_id, 'op123');
  assert.equal(payload.model,'marble-1.1');
  assert.equal(payload.permission.public,false);
  assert.deepEqual(payload.world_prompt,{type:'video', video_prompt:{source:'media_asset',media_asset_id:'m123'}});
});
test('operation handling supports pending, successful, and failed jobs', async () => {
  const responses = [
    {operation_id:'op',done:false},
    {operation_id:'op',done:true, response:{world_id:'w123'}, cost:{total_credits:1600}},
    {operation_id:'op',done:true,error:{code:500,message:'Failed'}}
  ];
  const client = new WorldLabsClient('secret', async () => json(responses.shift()));
  assert.equal(worldIdFromOperation(await client.operation('op')),null);
  assert.equal(worldIdFromOperation(await client.operation('op')),'w123');
  assert.equal(worldIdFromOperation(await client.operation('op')),null);
});
test('429 propagates retry-after without a hidden duplicate POST', async () => {
  let calls=0;
  const client = new WorldLabsClient('secret', async () => { calls++; return json({detail:'rate limited'}, 429, {'retry-after':'45','x-request-id':'request1'}); });
  await assert.rejects(client.generateVideo({mediaAssetId:'m123',displayName:'Living Room'}), err => {
    assert.ok(err instanceof WorldLabsHttpError);
    assert.equal(err.status,429); assert.equal(err.retryAfterSeconds,45); return true;
  });
  assert.equal(calls,1);
});
test('unknown provider response fails closed', async () => {
  const client = new WorldLabsClient('secret', async () => json({unexpected:true}));
  await assert.rejects(client.operation('op'), /does not match/);
});
test('validate file type and decimal 100MB boundary', () => {
  assert.deepEqual(validateFileInput('walkthrough.MP4',100_000_000),{extension:'mp4',mime:'video/mp4'});
  assert.throws(()=>validateFileInput('walkthrough.mp4',100_000_001),/at most/);
  assert.throws(()=>validateFileInput('walkthrough.exe',10),/Unsupported/);
});
test('mobile manifest selects downloaded assets, not temporary provider URLs', () => {
  const operation = {operation_id:'op',done:true,cost:{total_credits:1600}};
  const stored=[
    {name:'poster',relativePath:'assets/poster.webp',bytes:30000,contentType:'image/webp'},
    {name:'100k',relativePath:'assets/100k.spz',bytes:100000,contentType:'application/octet-stream'}
  ];
  const manifest = buildManifest(world,operation,stored);
  assert.equal(manifest.poster,'assets/poster.webp');
  assert.equal(manifest.splats['100k'],'assets/100k.spz');
  assert.equal(manifest.splats['500k'],undefined);
  assert.equal(manifest.spatial.metricScaleFactor,0.78);
  assert.equal(manifest.published,false);
  assert.equal(manifest.needsOperatorReview,true);
  assert.equal(JSON.stringify(manifest).includes('https://static'),false);
  assert.deepEqual(assetCandidates(world).filter(a=>a.kind==='spz').map(a=>a.name),['100k','500k']);
  assert.deepEqual(sceneFacts(world),{metricScaleFactor:0.78,groundPlaneOffset:0.32});
});
test('missing SPZ blocks publication manifest', () => {
  assert.throws(()=>buildManifest(world,{operation_id:'op',done:true},[]),/No usable mobile SPZ/);
});
