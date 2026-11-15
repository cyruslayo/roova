#!/usr/bin/env node
/** First live integration harness. No Cloudflare account required yet. */
import { stat, mkdir, readFile, writeFile, rename, access, unlink } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { basename, resolve, join, dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { WorldLabsClient, WorldLabsHttpError } from '../dist/worldlabs.js';
import { validateFileInput, worldIdFromOperation, assetCandidates } from '../dist/contract.js';
import { buildManifest } from '../dist/manifest.js';

function flags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) throw Error(`Unexpected value: ${args[i]}`);
    const key = args[i].slice(2);
    if (['confirm-paid'].includes(key)) out[key] = true;
    else out[key] = args[++i];
  }
  return out;
}
const args = process.argv.slice(2);
const command = args.shift() || 'help';
const opts = flags(args);
const outDir = opts.out ? resolve(opts.out) : null;
const apiKey = process.env.WLT_API_KEY || process.env.WORLD_LABS_API_KEY;
const client = apiKey ? new WorldLabsClient(apiKey) : null;
function requireClient() { if (!client) throw Error('Set WLT_API_KEY or WORLD_LABS_API_KEY on the server terminal'); return client; }
function requireOut() { if (!outDir) throw Error('Specify --out .runs/my-room'); return outDir; }
const stateFile = () => join(requireOut(), 'state.json');
async function saveJson(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n');
  await rename(tmp, file);
}
async function state() { return JSON.parse(await readFile(stateFile(), 'utf8')); }
function log(msg) { process.stdout.write(msg + '\n'); }
async function submit() {
  requireClient(); requireOut();
  if (!opts['confirm-paid']) throw Error('Add --confirm-paid to authorize one paid World Labs generation request');
  if (!opts.video || !opts.title) throw Error('Required: --video PATH --title "Living room" --out DIR');
  const filePath = resolve(opts.video);
  const info = await stat(filePath);
  if (!info.isFile()) throw Error('Video path is not a file');
  const sourceName = basename(filePath);
  const { extension, mime } = validateFileInput(sourceName, info.size);
  if (opts.title.length > 64) throw Error('Room title must be 64 characters or fewer');
  try { await access(stateFile()); throw Error('Run directory already exists. Resume it instead of paying again.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const model = opts.model ?? 'marble-1.1';
  if (!['marble-1.1', 'marble-1.1-plus', 'marble-1.0', 'marble-1.0-draft'].includes(model)) throw Error('Unsupported model');
  const job = { version: 1, title: opts.title, model, fileName: sourceName, fileBytes: info.size,
    phase: 'preparing', createdAt: new Date().toISOString() };
  await saveJson(stateFile(), job);
  log('Preparing World Labs video upload...');
  // Prevent provider upload filename >64 chars without truncating the extension.
  const fileName = sourceName.length <= 64 ? sourceName : `${sourceName.slice(0, 60 - extension.length)}.${extension}`;
  const prep = await client.prepareUpload(fileName, extension);
  job.mediaAssetId = prep.media_asset.media_asset_id;
  job.phase = 'uploading'; await saveJson(stateFile(), job);
  log('Uploading source video to signed World Labs storage...');
  const bytes = Readable.toWeb(createReadStream(filePath));
  await client.uploadBytes(prep.upload_info, bytes, mime, info.size);
  job.phase = 'uploaded'; await saveJson(stateFile(), job);
  // Everything after this point is treated as a paid-submission boundary.
  // No automatic retry, including timeouts and ambiguous network errors.
  const credits = await client.credits();
  log(`Available API credits (informational): ${credits}`);
  if (credits <= 0) throw Error('No remaining credits. Add credits before submitting generation.');
  job.phase = 'start_uncertain'; await saveJson(stateFile(), job);
  log('Starting ONE paid world generation request...');
  const op = await client.generateVideo({ mediaAssetId: job.mediaAssetId, displayName: job.title, model });
  job.operationId = op.operation_id;
  job.phase = 'submitted';
  job.submittedAt = new Date().toISOString();
  await saveJson(stateFile(), job);
  log(`Started operation ${op.operation_id}. Run: npm run cli -- resume --out "${outDir}"`);
}
function extensionFor(kind, contentType, url) {
  if (kind === 'spz') return 'spz';
  const mime = contentType.split(';')[0].trim().toLowerCase();
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/avif') return 'avif';
  if (mime === 'image/jpeg') return 'jpg';
  try {
    const suffix = new URL(url).pathname.match(/\.(jpg|jpeg|webp|png|avif)$/i)?.[1];
    return suffix?.toLowerCase() || 'jpg';
  } catch { return 'jpg'; }
}
async function downloadAsset(asset) {
  const url = new URL(asset.url);
  if (url.protocol !== 'https:') throw Error('Asset URL must use HTTPS');
  const response = await fetch(url, { signal: AbortSignal.timeout(240_000) });
  if (!response.ok || !response.body) throw Error(`Failed downloading ${asset.name}: HTTP ${response.status}`);
  const mime = response.headers.get('content-type') || 'application/octet-stream';
  const ext = extensionFor(asset.kind, mime, asset.url);
  const relativePath = `assets/${asset.name}.${ext}`;
  const path = join(requireOut(), relativePath);
  await mkdir(dirname(path), { recursive: true });
  let bytes = 0;
  const limit = 250_000_000;
  const guard = new Transform({ transform(chunk, _, callback) {
    bytes += chunk.length;
    if (bytes > limit) callback(Error(`Asset exceeds ${limit} byte safety cap`));
    else callback(null, chunk);
  } });
  try { await pipeline(Readable.fromWeb(response.body), guard, createWriteStream(path + '.tmp')); await rename(path + '.tmp', path); }
  catch (error) { await unlink(path + '.tmp').catch(() => {}); throw error; }
  return { name: asset.name, relativePath, bytes, contentType: mime };
}
async function resume() {
  requireClient(); requireOut();
  const job = await state();
  if (job.phase === 'ready_for_review') { log('Already ready for review. Open viewer-manifest.json.'); return true; }
  if (!job.operationId) throw Error(`Cannot safely resume phase '${job.phase}'. No operation ID. Investigate before paying again.`);
  const op = await client.operation(job.operationId);
  await saveJson(join(outDir, 'latest-operation.json'), op);
  if (!op.done) {
    job.phase = 'generating'; job.lastCheckedAt = new Date().toISOString();
    await saveJson(stateFile(), job);
    log(`Still generating: ${job.operationId}. Resume again later.`);
    return false;
  }
  if (op.error) {
    job.phase = 'failed'; job.providerError = op.error;
    await saveJson(stateFile(), job);
    throw Error(`Generation failed: ${JSON.stringify(op.error)}. Do not resubmit automatically.`);
  }
  const worldId = worldIdFromOperation(op);
  if (!worldId) throw Error('Operation succeeded without identifiable world ID; inspect latest-operation.json');
  job.worldId = worldId;
  job.phase = 'collecting'; await saveJson(stateFile(), job);
  const world = await client.world(worldId);
  // Private diagnostic record. Never serve this file through a public tour route.
  await saveJson(join(outDir, 'provider-world-private.json'), world);
  const candidates = assetCandidates(world);
  const splats = candidates.filter(x => x.kind === 'spz');
  if (!splats.length) throw Error('World has no 100k or 500k SPZ output; inspect provider response');
  const downloaded = [];
  for (const asset of candidates) {
    log(`Downloading ${asset.name}...`);
    try { downloaded.push(await downloadAsset(asset)); }
    catch (error) {
      // Poster/panorama are optional in the provider schema. 3D is required.
      if (asset.kind === 'spz' && splats.length === 1) throw error;
      log(`Warning: ${asset.name} failed: ${String(error)}`);
    }
  }
  const manifest = buildManifest(world, op, downloaded);
  await saveJson(join(outDir, 'viewer-manifest.json'), manifest);
  job.phase = 'ready_for_review'; job.completedAt = new Date().toISOString();
  job.creditsCharged = op.cost?.total_credits ?? null;
  await saveJson(stateFile(), job);
  log(`READY FOR REVIEW. Assets and viewer-manifest.json: ${outDir}`);
  log('This tool does NOT publish the scene. Human accuracy review and public hosting remain required.');
  return true;
}
async function watch() {
  if (!outDir) throw Error('Specify --out directory');
  const interval = Math.max(15, Math.min(120, Number(opts.interval) || 30));
  for (let i = 0; i < 60; i++) {
    try { if (await resume()) return; }
    catch (err) {
      if (err instanceof WorldLabsHttpError && [429, 500, 502, 503, 504].includes(err.status)) {
        log(`Transient status ${err.status}. Polling resumes after backoff; never resubmitting generation.`);
        await new Promise(r => setTimeout(r, Math.max(interval, err.retryAfterSeconds ?? 0) * 1000));
        continue;
      }
      throw err;
    }
    await new Promise(r => setTimeout(r, interval * 1000));
  }
  log('Watch stopped after 60 polls. You can safely run resume again.');
}
async function main() {
  if (command === 'submit') await submit();
  else if (command === 'resume') await resume();
  else if (command === 'watch') await watch();
  else log(`World Labs property-tour milestone CLI\n\n` +
    `submit --video room.mp4 --title "Living room" --out .runs/room1 --confirm-paid\n` +
    `resume --out .runs/room1\nwatch --out .runs/room1 --interval 30\n\n` +
    `Set WLT_API_KEY (server-side). Submit can incur real World Labs charges.`);
}
main().catch(error => { console.error(error?.message ?? error); process.exitCode = 1; });
