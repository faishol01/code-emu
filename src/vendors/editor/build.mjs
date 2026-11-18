import * as esbuild from 'esbuild';
import { readFile } from 'node:fs/promises';

// Patch for y-codemirror.next 0.3.6: its remote-caret widget compares only the
// colour, so a collaborator's caret keeps showing their old name after they rename
// themselves. Compare the name too, so the caret is redrawn.
const caretNamePatch = {
  name: 'y-codemirror-caret-name',
  setup(b) {
    b.onLoad({ filter: /y-codemirror\.next[\\/]src[\\/]y-remote-selections\.js$/ }, async (args) => {
      const src = await readFile(args.path, 'utf8');
      const fixed = src.replaceAll('return widget.color === this.color', 'return widget.color === this.color && widget.name === this.name');
      if (fixed === src) throw new Error('caret patch no longer applies; check y-codemirror.next');
      return { contents: fixed, loader: 'js' };
    });
  },
};

await esbuild.build({
  entryPoints: ['entry.js'], bundle: true, format: 'iife', minify: true, target: ['es2020'],
  legalComments: 'eof', outfile: 'editor.bundle.js', plugins: [caretNamePatch],
  banner: { js: '/* cpp.wasm editor bundle: CodeMirror 6, yjs 13.6.33, y-codemirror.next 0.3.6 (patched, see build.mjs), y-protocols 1.0.7, trystero 0.26.0 (all MIT). Built with esbuild 0.25.10 from src/vendors/editor/entry.js; versions in package.json. */' },
});
