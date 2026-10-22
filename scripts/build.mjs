import { mkdir, copyFile, cp } from 'node:fs/promises';
import { build } from 'esbuild';
await mkdir('dist/chunks', { recursive: true });
for (const file of ['index.html', 'styles.css', 'course.js', 'public/favicon.svg', 'public/404.html', 'public/_headers', 'public/manifest.webmanifest']) {
  const name = file.startsWith('public/') ? file.slice('public/'.length) : file;
  await copyFile(file, `dist/${name}`);
}
await build({
  entryPoints: ['app.js'], bundle: true, splitting: true, format: 'esm',
  platform: 'browser', target: 'es2022', outdir: 'dist', entryNames: 'app',
  chunkNames: 'chunks/[name]-[hash]', assetNames: 'chunks/[name]-[hash]',
  loader: { '.wasm': 'file' }, logLevel: 'info'
});
await cp('assets', 'dist/assets', { recursive: true });
console.log('Built public assets and browser analysis bundle in dist/');
