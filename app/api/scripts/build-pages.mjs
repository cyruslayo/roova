import { build } from 'esbuild';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../src/pages.ts', import.meta.url));
const output = fileURLToPath(new URL('../../web/dist/_worker.js', import.meta.url));
await access(fileURLToPath(new URL('../../web/dist/index.html', import.meta.url)));
await build({ entryPoints: [entry], outfile: output, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', legalComments: 'inline' });
console.log('Built Pages API and asset router into app/web/dist/_worker.js');
