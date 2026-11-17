# Collaboration bundle

`collab.bundle.js` packs these MIT-licensed libraries into one script that sets
`window.CppCollab = { Y, CodemirrorBinding, awarenessProtocol, joinRoom, selfId }`:

- yjs 13.6.33: shared documents (CRDT)
- y-codemirror 3.0.1: binds a Y.Text to the CodeMirror 5 editor, with remote cursors
- y-protocols 1.0.7: awareness (who is here, their cursor and open file)
- trystero 0.26.0: WebRTC peers, found through public Nostr relays (no server of your own)

Rebuild with Node.js:

```
npm install
node build.mjs
```

`cm-shim.js` points y-codemirror's `import 'codemirror'` at the CodeMirror
global the page already loads. License texts are in `licenses/`.
