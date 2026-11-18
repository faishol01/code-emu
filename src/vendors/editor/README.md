# Editor bundle

`editor.bundle.js` packs these MIT-licensed libraries into one script, so that
CodeMirror and Yjs each exist exactly once (both require that):

- CodeMirror 6: `@codemirror/state` 6.7.6, `view` 6.43.15, `commands` 6.11.1,
  `language` 6.13.1, `lang-cpp` 6.0.3, `autocomplete` 6.20.4, `search` 6.7.2
- yjs 13.6.33: shared documents for collaboration rooms
- y-codemirror.next 0.3.6: binds a Y.Text to CodeMirror 6, with remote cursors and undo
- y-protocols 1.0.7: awareness (who is here, their cursor and open file)
- trystero 0.26.0: WebRTC peers, found through public Nostr relays

It sets `window.CM6` (used only by `src/js/editor.js`) and `window.CppCollab`
(used by `src/js/collab.js`). Exact versions of every dependency are pinned in
`package.json`. Rebuild with Node.js:

```
npm install
node build.mjs
```

License texts are in `licenses/`.

## Patch

`build.mjs` applies one small fix to y-codemirror.next 0.3.6 while bundling:
its remote-caret widget only compared colours, so when a collaborator changed
their display name, others kept seeing the old name on their caret. The patched
widget also compares the name. The build fails if the patch stops applying.
