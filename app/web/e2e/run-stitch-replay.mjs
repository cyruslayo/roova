// Runs the synthetic stitch replay in headless Chromium against the Vite dev server.
// Usage: npx vite --port 5179 &  then  node e2e/run-stitch-replay.mjs [outDir]
import { createRequire } from 'node:module';
// Uses the preinstalled Playwright (NODE_PATH=$(npm root -g)) rather than adding a dependency.
const { chromium } = createRequire(import.meta.url)('playwright');
import { writeFileSync, mkdirSync } from 'node:fs';
const out = process.argv[2] ?? 'e2e/out';
mkdirSync(out, { recursive: true });
const cases = [
  { name: 'exact-9x16', options: {} },
  // Safari regression: createImageBitmap(Blob) rejects and no worker; must decode via <img>.
  { name: 'safari-blob-fallback-9x16', options: { simulateSafariBlobFailure: true } },
  { name: 'pose-error-9x16', options: { poseError: 1.5, rollError: 1, exposureJitter: 0.25, seed: 11 } },
  // 3:4 frames with the long side at VFTCam's 70.28° (the product's prior: phones crop the short side).
  { name: 'exact-3x4', options: { width: 960, height: 1280, shortFov: 55.46, seed: 5 } },
  // Control: a 3:4 camera that does NOT match the prior (43.2° short side), outside calibration range.
  { name: 'prior-mismatch-3x4', options: { width: 960, height: 1280, shortFov: 43.2, seed: 5 } },
];
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
page.on('console', m => { if (m.type() === 'error' || /alignment|gains|Seam|Pole|FOV/i.test(m.text())) console.log('  [page]', m.text().slice(0, 220)); });
await page.goto('http://localhost:5179/e2e/stitch-replay.html');
await page.waitForSelector('body[data-ready="1"]', { state: 'attached', timeout: 60000 });
const ua = await page.evaluate(() => navigator.userAgent);
const results = [];
for (const c of cases) {
  console.log(`Case ${c.name}`);
  const r = await page.evaluate(o => window.runReplay(o), c.options);
  writeFileSync(`${out}/${c.name}.jpg`, Buffer.from(r.previewUrl.split(',')[1], 'base64'));
  delete r.previewUrl;
  results.push({ name: c.name, ...r });
  console.log(JSON.stringify({ name: c.name, output: r.output, seconds: r.seconds, frameSize: r.frameSize, fov: r.fov, summary: r.summary }, null, 1));
}
writeFileSync(`${out}/results.json`, JSON.stringify({ userAgent: ua, results }, null, 2));
await browser.close();
