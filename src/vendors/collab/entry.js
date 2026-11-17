// cpp.wasm collaboration bundle: Yjs (shared documents), y-codemirror (editor
// binding), y-protocols awareness (cursors and presence) and Trystero (WebRTC
// peers found through public Nostr relays). Exposed as window.CppCollab.
import * as Y from 'yjs';
import { CodemirrorBinding } from 'y-codemirror';
import * as awarenessProtocol from 'y-protocols/awareness';
import { joinRoom, selfId } from 'trystero';

window.CppCollab = { Y, CodemirrorBinding, awarenessProtocol, joinRoom, selfId };
