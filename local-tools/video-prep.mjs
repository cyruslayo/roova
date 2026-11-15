#!/usr/bin/env node
/**
 * Local World Labs room-video preparation helper.
 * Requires Node.js 20+, FFmpeg and FFprobe installed on PATH.
 * No network requests. Never modifies its input file.
 * Supports --inspect and --prepare workflows.
 */
import { spawn } from 'node:child_process';
import { stat, writeFile, mkdir, rm, rename } from 'node:fs/promises';
import { resolve, dirname, basename, extname } from 'node:path';

function parse(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!key.startsWith('--')) throw Error(`Unexpected argument: ${key}`);
    const name = key.slice(2);
    if (name === 'inspect') result.inspect = true;
    else if (name === 'prepare') result.prepare = true;
    else {
      const val = args[++i];
      if (!val || val.startsWith('--')) throw Error(`Missing value for ${key}`);
      result[name] = val;
    }
  }
  return result;
}
function run(bin, args, quiet = false) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    const out = [], err = [];
    child.stdout.on('data', c => out.push(c));
    child.stderr.on('data', c => { err.push(c); if (!quiet) process.stderr.write(c); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolvePromise(Buffer.concat(out).toString('utf8')) : reject(Error(`${bin} returned ${code}: ${Buffer.concat(err).toString('utf8').slice(-800)}`)));
  });
}
function fpsRatio(s) {
  const [num, den] = String(s || '30/1').split('/').map(Number);
  return num > 0 && den > 0 ? num / den : 30;
}
async function probe(file) {
  const data = JSON.parse(await run('ffprobe', ['-v','error','-show_streams','-show_format','-of','json',file], true));
  const video = data.streams.find(s => s.codec_type === 'video');
  if (!video) throw Error('No video stream found');
  const seconds = Number(data.format?.duration || 0);
  const bytes = Number(data.format?.size || (await stat(file)).size);
  return { path: file, file: basename(file), durationSeconds: seconds, bytes, megabytes: +(bytes/1e6).toFixed(2),
    video: {codec:video.codec_name,width:video.width,height:video.height,fps:+fpsRatio(video.avg_frame_rate||video.r_frame_rate).toFixed(3),pixFmt:video.pix_fmt},
    audioPresent:data.streams.some(s=>s.codec_type==='audio') };
}
async function main() {
  const opt = parse(process.argv.slice(2));
  if (!opt.input) throw Error('Usage: node video-prep.mjs --input "source.mp4" --inspect [--output "report.json"] OR --prepare --start 0 --duration 25 --output "prepared.mp4"');
  const input = resolve(opt.input);
  if (!(await stat(input)).isFile()) throw Error('Input must be a file');
  const info = await probe(input);
  if (opt.inspect) {
    console.log(JSON.stringify(info,null,2));
    const name = opt.output ? resolve(opt.output) : resolve(dirname(input), `${basename(input,extname(input))}-inspection.json`);
    await mkdir(dirname(name), {recursive:true});
    await writeFile(name, JSON.stringify(info,null,2)+'\n');
    console.log(`Saved inspection: ${name}`);
    return;
  }
  if (!opt.prepare) throw Error('Specify --inspect or --prepare');
  if (!opt.output) throw Error('--prepare requires --output FILE.mp4');
  const output = resolve(opt.output);
  if (output === input) throw Error('Output cannot overwrite source video');
  if (extname(output).toLowerCase() !== '.mp4') throw Error('Output must have .mp4 extension');
  const start = Number(opt.start ?? 0);
  const duration = Number(opt.duration ?? Math.min(25,info.durationSeconds));
  const maxMB = Number(opt['max-mb'] ?? 95);
  if (!Number.isFinite(start) || start < 0 || !Number.isFinite(duration) || duration <= 0 || duration > 30) throw Error('Choose a start >=0 and a duration >0 and <=30 seconds');
  if (start + duration > info.durationSeconds + 0.2) throw Error('Selected segment extends beyond video end');
  if (!(maxMB > 1 && maxMB <= 100)) throw Error('Choose --max-mb between 1 and 100');
  if (info.durationSeconds > 30 && !Object.hasOwn(opt,'start')) console.log('NOTICE: Automatically using the first segment. Choose --start after reviewing the video for better coverage.');
  const fps = Math.min(30, Math.max(12, Math.round(info.video.fps || 30)));
  const attempts=[{crf:23,w:1920,h:1080},{crf:26,w:1920,h:1080},{crf:29,w:1280,h:720}];
  await mkdir(dirname(output), {recursive:true});
  let result;
  for (let idx=0;idx<attempts.length;idx++){
    const cfg=attempts[idx];
    const tmp=output.replace(/\.mp4$/i,`.attempt${idx+1}.mp4`);
    const vf=`fps=${fps},scale=${cfg.w}:${cfg.h}:force_original_aspect_ratio=decrease:force_divisible_by=2`;
    const args=['-hide_banner','-loglevel','error','-y','-ss',String(start),'-i',input,'-t',String(duration),'-map','0:v:0','-an','-vf',vf,'-c:v','libx264','-preset','medium','-crf',String(cfg.crf),'-pix_fmt','yuv420p','-movflags','+faststart',tmp];
    console.log(`Encoding attempt ${idx+1}: CRF ${cfg.crf}, cap ${cfg.w}x${cfg.h}, ${fps} fps`);
    await run('ffmpeg',args,true);
    const size=(await stat(tmp)).size;
    if(size <= maxMB*1e6){await rm(output,{force:true});await rename(tmp,output);result={file:output,bytes:size,megabytes:+(size/1e6).toFixed(2),settings:cfg};break;}
    await rm(tmp,{force:true});
  }
  if (!result) throw Error(`Unable to prepare below ${maxMB} MB without more severe compression. Inspect the source and choose a smaller segment.`);
  const report={preparedAt:new Date().toISOString(),source:info,segment:{startSeconds:start,durationSeconds:duration},output:await probe(output),encoding:result.settings,policy:{maxPreparedMB:maxMB, maxDurationSeconds:30},notes:['Original file was not changed.','Selection is manual; this script does not find the best scene interval.','Review output visually before running a paid generation.']};
  const reportFile=output.replace(/\.mp4$/i,'.report.json');
  await writeFile(reportFile,JSON.stringify(report,null,2)+'\n');
  console.log(`Prepared: ${output} (${result.megabytes} MB)\nReport: ${reportFile}`);
}
main().catch(error=>{console.error('ERROR:',error.message);process.exitCode=1;});
