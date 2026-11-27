#!/usr/bin/env node
/**
 * Frozen Aperture — Standalone Offline HTML Bundler
 * Bundles src/main.js, src/styles.css, and pinned Three.js into a single
 * self-contained index.html with ZERO external network/CDN dependencies.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

async function build() {
  const result = await esbuild.build({
    entryPoints: [path.join(root, 'src/main.js')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2022'],
    minify: true,
    sourcemap: false,
    write: false,
    outdir: path.join(root, 'dist'),
  });

  let jsCode = '';
  let cssCode = '';
  for (const file of result.outputFiles) {
    if (file.path.endsWith('.js')) jsCode = file.text;
    if (file.path.endsWith('.css')) cssCode = file.text;
  }

  if (!jsCode) throw new Error('Build produced no JavaScript bundle.');

  const safeJs = jsCode.replace(/<\/script/gi, '<\\/script');
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>Frozen Aperture — Illustration-to-Playable-World</title>
  <style>${cssCode}</style>
</head>
<body>
  <div id="app"></div>
  <script>${safeJs}</script>
</body>
</html>
`;

  const outIndex = path.join(root, 'index.html');
  fs.writeFileSync(outIndex, html, 'utf8');

  const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
  console.log(`Built standalone offline index.html (${kb} KB, zero external dependencies).`);
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
