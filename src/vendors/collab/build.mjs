import * as esbuild from 'esbuild';
import path from 'node:path';
const cmShim = {
  name: 'cm-shim',
  setup(b) { b.onResolve({ filter: /^codemirror$/ }, () => ({ path: path.resolve('cm-shim.js') })); },
};
await esbuild.build({
  entryPoints: ['entry.js'], bundle: true, format: 'iife', minify: true, target: ['es2020'],
  plugins: [cmShim], legalComments: 'eof', outfile: 'collab.bundle.js',
  banner: { js: '/* cpp.wasm collab bundle: yjs 13.6.33, y-codemirror 3.0.1, y-protocols 1.0.7, trystero 0.26.0 (all MIT). Built with esbuild 0.25.10 from src/vendors/collab/entry.js. */' },
});
