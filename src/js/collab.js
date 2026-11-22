/* cpp.wasm collaboration: shared rooms over WebRTC.

   Everyone in a room edits the same files in real time. Files live in a Yjs
   document that every peer keeps a full copy of; edits travel directly between
   browsers over WebRTC. Peers find each other through public Nostr relays
   (Trystero), so no server of your own is needed. Programs still compile and
   run on each person's own device.

   app.js calls window.CppWasmCollabInstall(app) with a small API object. */
window.CppWasmCollabInstall = function (app) {
  'use strict';

  const $ = app.$;
  const btn = $('#collab-btn');
  const panel = $('#collab-panel');
  const C = window.CppCollab;
  if (!C) {
    btn.disabled = true;
    btn.title = 'The collaboration library didn’t load';
    return;
  }
  const { Y, yCollab, awarenessProtocol: A, joinRoom, selfId } = C;

  const APP_ID = 'cpp-wasm-collab-v1';
  const ROOM_RE = /^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/;
  const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
  const COLORS = ['#e8590c', '#2f9e44', '#1c7ed6', '#ae3ec9', '#f08c00', '#0c8599', '#d6336c', '#5c940d'];
  const MAX_PEERS = 8;
  // Optional TURN servers for networks that block direct peer-to-peer connections, e.g.
  // [{ urls: 'turn:turn.example.com:3478', username: 'user', credential: 'secret' }]
  const TURN_SERVERS = [{urls: "stun.l.google.com:19302"},{urls: "stun1.l.google.com:19302"},{urls: "stun2.l.google.com:19302"},{urls: "stun3.l.google.com:19302"},{urls: "stun4.l.google.com:19302"}];;
  const toU8 = (d) => (d instanceof Uint8Array ? d : new Uint8Array(d));

  function hashString(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return h >>> 0;
  }
  const myColor = COLORS[hashString(selfId) % COLORS.length];
  let myName = (app.store.get('cppwasm.name', '') || '').slice(0, 32) ||
    'Guest ' + (100 + (hashString(selfId) % 900));

  function newRoomId() {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
    return chars.slice(0, 4) + '-' + chars.slice(4, 8) + '-' + chars.slice(8);
  }
  const roomLink = (id) => location.href.split('#')[0] + '#room-' + id;

  /* ---------------- room names ----------------
     A room can be given a name when it is created. The name is stored in the
     shared document, so everyone who joins sees it. */
  const NAME_MAX = 40;
  const cleanName = (t) => String(t || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);

  function readName() {
    const s = session;
    if (!s) return;
    const name = cleanName(s.meta.get('name'));
    if (name === s.name) return;
    s.name = name;
    app.updateTitle();
    renderPanel();
  }

  let session = null;   // the room we're in, or null
  let pendingHost = null;   // room id we are creating (so we seed it with our files)

  /* ---------------- shared document helpers ---------------- */
  function yFile(id) { return session && session.yfiles.get(id); }

  function addFileToDoc(yfiles, yorder, file) {
    const m = new Y.Map();
    m.set('name', file.name);
    m.set('code', new Y.Text(file.code));
    m.set('stdin', new Y.Text(file.stdin || ''));
    yfiles.set(file.id, m);
    yorder.push([file.id]);
  }

  // Apply only the changed middle of a string to a Y.Text, so concurrent edits merge well.
  function setYText(ytext, value) {
    const old = ytext.toString();
    if (old === value) return;
    let start = 0;
    while (start < old.length && start < value.length && old[start] === value[start]) start++;
    let endOld = old.length, endNew = value.length;
    while (endOld > start && endNew > start && old[endOld - 1] === value[endNew - 1]) { endOld--; endNew--; }
    session.ydoc.transact(() => {
      if (endOld > start) ytext.delete(start, endOld - start);
      if (endNew > start) ytext.insert(start, value.slice(start, endNew));
    });
  }

  // Rebuild the app's file list from the shared document.
  function filesFromDoc() {
    const out = [];
    const seen = new Set();
    for (const id of session.yorder.toArray()) {
      const m = session.yfiles.get(id);
      if (!m || seen.has(id)) continue;
      const name = m.get('name');
      const code = m.get('code'), stdin = m.get('stdin');
      if (typeof name !== 'string' || !app.NAME_RE.test(name) || !(code instanceof Y.Text)) continue;
      seen.add(id);
      out.push({
        id,
        name,
        get code() { return code.toString(); },
        set code(_) { /* edits go through the editor binding */ },
        get stdin() { return stdin instanceof Y.Text ? stdin.toString() : ''; },
        set stdin(_) {},
      });
    }
    return out;
  }

  let refreshQueued = false;
  function refresh() {
    if (refreshQueued) return;
    refreshQueued = true;
    queueMicrotask(() => {
      refreshQueued = false;
      if (!session) return;
      const list = filesFromDoc();
      app.setFiles(list);
      if (list.length && !session.synced) markSynced();
      if (!list.length) {
        app.renderFiles();
        if (session.synced) showPlaceholder('// This room has no files. Add one with + in the Files list.\n');
        return;
      }
      const active = list.find((f) => f.id === app.getActiveId());
      if (!active) open(list[0].id);
      else {
        app.setTitle(active.name);
        const ta = $('#stdin');
        if (document.activeElement !== ta && ta.value !== active.stdin) ta.value = active.stdin;
        app.renderFiles();
      }
      renderPanel();
    });
  }

  /* ---------------- editor binding (y-codemirror.next) ----------------
     Each file opens as a CodeMirror state with yCollab(), which keeps the editor
     and the shared Y.Text in sync and draws other people's cursors and
     selections. Undo uses one Y.UndoManager per file, so it only undoes your
     own edits and survives switching files. y-codemirror.next keeps your cursor
     visible to others after you click away from the editor. */
  // Cursor positions in awareness are Yjs relative positions (JSON objects; older
  // clients sent JSON strings).
  const relPos = (v) => Y.createRelativePositionFromJSON(typeof v === 'string' ? JSON.parse(v) : v);
  const colorLight = (c) => c + '55';

  function undoFor(id, ytext) {
    let um = session.undos.get(id);
    if (!um) { um = new Y.UndoManager(ytext); session.undos.set(id, um); }
    return um;
  }

  function showPlaceholder(text) {
    app.cm.setState(app.cm.newState(text, { readOnly: true }));
    app.setTitle(session ? 'Room ' + session.id : '');
  }

  function open(id, focus) {
    const m = yFile(id);
    if (!m) return;
    app.setActiveId(id);
    const ytext = m.get('code');
    // A fresh state each time: the shared text may have changed while the file was closed.
    app.cm.setState(app.cm.newState(ytext.toString(), {
      collab: yCollab(ytext, session.awareness, { undoManager: undoFor(id, ytext) }),
    }));
    session.awareness.setLocalStateField('file', id);
    publishCursor(ytext);
    const f = app.getFiles().find((x) => x.id === id);
    app.setTitle(f ? f.name : '');
    $('#stdin').value = f ? f.stdin : '';
    app.renderFiles();
    if (focus) app.cm.focus();
  }

  // Share where my cursor and selection are. y-codemirror.next does this on every
  // cursor move while the editor has focus; this covers opening a file.
  function publishCursor(ytext) {
    const sel = app.cm.getSelection();
    const rel = (i) => Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, i));
    session.awareness.setLocalStateField('cursor', { anchor: rel(sel.anchor), head: rel(sel.head) });
  }

  // Show a person's name over their caret for a moment (it otherwise appears on hover).
  function showName(name, flash) {
    for (const caret of app.cm.dom.querySelectorAll('.cm-ySelectionCaret')) {
      const info = caret.querySelector('.cm-ySelectionInfo');
      if (!info || info.textContent !== name) continue;
      caret.classList.add('show-name');
      if (flash) caret.classList.add('flash');
      clearTimeout(caret._nameTimer);
      caret._nameTimer = setTimeout(() => caret.classList.remove('show-name', 'flash'), flash ? 1800 : 2000);
    }
  }

  // Scroll to someone's cursor (and open their file first if needed).
  function jumpTo(clientId) {
    if (!session) return;
    const st = session.awareness.getStates().get(clientId);
    if (!st || !st.file || !yFile(st.file)) return;
    if (st.file !== app.getActiveId()) open(st.file);
    if (!st.cursor) return;
    let pos = null;
    try { pos = Y.createAbsolutePositionFromRelativePosition(relPos(st.cursor.head), session.ydoc); } catch (e) {}
    if (!pos) return;
    app.cm.scrollTo(pos.index);
    app.cm.flash(pos.index, pos.index);
    // Remote carets are drawn a moment after a file opens.
    setTimeout(() => showName(st.user.name, true), 60);
  }

  /* ---------------- joining and leaving ---------------- */
  function markSynced() {
    if (!session || session.synced) return;
    session.synced = true;
    clearTimeout(session.lonelyTimer);
    app.setFileActionsEnabled(true);
    renderPanel();
  }

  function join(id, asHost) {
    if (session) leave(true);
    const ydoc = new Y.Doc();
    const yfiles = ydoc.getMap('files');
    const yorder = ydoc.getArray('order');
    const awareness = new A.Awareness(ydoc);
    awareness.setLocalState({ user: { name: myName, color: myColor, colorLight: colorLight(myColor) }, peer: selfId, file: null });

    const local = app.enterRoom();
    session = {
      id, ydoc, yfiles, yorder, awareness, meta: ydoc.getMap('meta'),
      undos: new Map(),
      peers: new Set(), synced: false, host: !!asHost, local, lonelyTimer: 0, error: '',
      name: '',
    };
    session.meta.observe(readName);

    if (asHost) {
      ydoc.transact(() => {
        if (asHost.name) session.meta.set('name', asHost.name);
        // The homepage can start a room with a fresh main.cpp instead of your files.
        const seed = asHost.files || local.files;
        for (const f of seed) addFileToDoc(yfiles, yorder, { id: app.newId(), name: f.name, code: f.code, stdin: f.stdin || '' });
      });
      session.synced = true;
    } else {
      app.setFiles([]);
      app.renderFiles();
      app.setFileActionsEnabled(false);
      showPlaceholder('// Connecting to room ' + id + '…\n// The files appear as soon as someone in the room is online.\n');
      session.lonelyTimer = setTimeout(renderPanel, 15000);
    }

    let room;
    try {
      const config = { appId: APP_ID, maxReceiveBytes: 16 * 1024 * 1024 };
      if (TURN_SERVERS.length) config.turnConfig = TURN_SERVERS;
      room = joinRoom(config, id, {
        onJoinError: (details) => {
          if (!session) return;
          session.error = 'A direct connection to a peer failed. Networks that block peer-to-peer traffic need a TURN server (see README).';
          console.warn('cpp.wasm collab:', details);
          renderPanel();
        },
      });
    } catch (e) {
      session.error = 'Couldn’t open the room: ' + (e && e.message ? e.message : e);
      renderPanel();
      return;
    }
    session.room = room;
    const syncAction = room.makeAction('sync');
    const awAction = room.makeAction('aw');
    session.sendSync = (u, target) => syncAction.send(u, target ? { target } : undefined).catch(() => {});
    session.sendAw = (u, target) => awAction.send(u, target ? { target } : undefined).catch(() => {});

    syncAction.onMessage = (data, meta) => {
      if (!session || session.room !== room) return;
      // The origin tells the recorder who made the change.
      try { Y.applyUpdate(ydoc, toU8(data), { peer: meta && meta.peerId }); } catch (e) { console.warn('cpp.wasm collab: bad update', e); }
    };
    awAction.onMessage = (data, meta) => {
      if (!session || session.room !== room) return;
      try { A.applyAwarenessUpdate(awareness, toU8(data), meta && meta.peerId); } catch (e) {}
    };
    room.onPeerJoin = (peerId) => {
      if (!session || session.room !== room) return;
      session.peers.add(peerId);
      // Send everything we have; Yjs merges it with what they have.
      session.sendSync(Y.encodeStateAsUpdate(ydoc), peerId);
      session.sendAw(A.encodeAwarenessUpdate(awareness, Array.from(awareness.getStates().keys())), peerId);
      renderPanel();
    };
    room.onPeerLeave = (peerId) => {
      if (!session || session.room !== room) return;
      session.peers.delete(peerId);
      const gone = [];
      awareness.getStates().forEach((st, clientId) => { if (st && st.peer === peerId) gone.push(clientId); });
      A.removeAwarenessStates(awareness, gone, 'peer-left');
      renderPanel();
    };

    ydoc.on('update', (update, origin) => { if (!(origin && origin.peer !== undefined) && session && session.room === room) session.sendSync(update); });
    awareness.on('update', ({ added, updated, removed }, origin) => {
      if (origin !== 'local' || !session || session.room !== room) return;
      session.sendAw(A.encodeAwarenessUpdate(awareness, added.concat(updated, removed)));
    });
    let presenceKey = '';
    let peopleKey = '';
    awareness.on('change', ({ added, updated, removed }) => {
      announce(added, removed);
      if (app.rec.active) recordPresence(added.concat(updated), removed);
      // Briefly show the name over the caret of anyone who moved in the file I have open.
      for (const id of added.concat(updated)) {
        const st = awareness.getStates().get(id);
        if (id !== ydoc.clientID && st && st.user && st.file === app.getActiveId() && st.cursor) {
          requestAnimationFrame(() => showName(st.user.name));
        }
      }
      // Re-render the file list only when someone else's open file, name or colour
      // changed; cursor moves alone shouldn't rebuild it (that would eat clicks).
      const key = [];
      awareness.getStates().forEach((st, id) => {
        if (id !== ydoc.clientID && st && st.user) key.push(id + ':' + st.file + ':' + st.user.name + ':' + st.user.color);
      });
      const next = key.sort().join('|');
      if (next !== presenceKey) { presenceKey = next; app.renderFiles(); }
      // The panel only shows who is here, where and whether they record; skip cursor-only updates.
      if (!panel.hidden) {
        const pk = people().map((x) => x.id + ':' + x.name + ':' + x.file + ':' + x.rec).join('|');
        if (pk !== peopleKey) { peopleKey = pk; renderPanel(); }
      } else if (added.length || removed.length) renderPanel();
    });
    yorder.observe(refresh);
    yfiles.observeDeep(refresh);
    yfiles.observeDeep((events, tr) => { if (app.rec.active) recordDocEvents(events, tr); });

    if (asHost) refresh();
    renderPanel();
  }

  let known = new Map();   // awareness clientId -> name, for join/leave notices
  const recording = new Map();   // clientId -> whether they were recording, for notices
  function announceRecording() {
    session.awareness.getStates().forEach((st, id) => {
      if (id === session.ydoc.clientID || !st || !st.user) return;
      const was = recording.get(id) || false, now = !!st.rec;
      if (was !== now) app.filesMessage(st.user.name + (now ? ' started recording this room' : ' stopped recording'), true);
      recording.set(id, now);
    });
  }
  function announce(added, removed) {
    if (!session) return;
    announceRecording();
    for (const id of added) {
      const st = session.awareness.getStates().get(id);
      if (id !== session.ydoc.clientID && st && st.user) { known.set(id, st.user.name); app.filesMessage(st.user.name + ' joined', true); }
    }
    for (const id of removed) {
      if (known.has(id)) { app.filesMessage(known.get(id) + ' left', true); known.delete(id); }
    }
  }

  function leave(silent) {
    if (!session) return;
    const s = session;
    clearTimeout(s.lonelyTimer);
    app.cm.setState(app.cm.newState(''));   // detach the editor from the room's text first
    s.undos.forEach((um) => um.destroy());
    try { A.removeAwarenessStates(s.awareness, [s.ydoc.clientID], 'local'); } catch (e) {}
    try { s.room && s.room.leave(); } catch (e) {}
    s.awareness.destroy();
    s.ydoc.destroy();
    session = null;
    known = new Map();
    app.setFileActionsEnabled(true);
    app.exitRoom(s.local);
    if (!silent) app.filesMessage('Left the room. Your own files are back.', true);
    renderPanel();
  }

  /* ---------------- recording (record.js) ----------------
     Changes are recorded from the shared document, so everyone's edits are
     captured with their author, whoever is recording. */
  const removedAuthors = new Map();   // clientId -> author, for LEAVE events
  function authorOf(clientId) {
    const st = session.awareness.getStates().get(clientId);
    if (st && st.user) return { key: 'c' + clientId, name: st.user.name, color: st.user.color };
    return removedAuthors.get(clientId) || null;
  }
  function authorForTransaction(tr) {
    const o = tr.origin;
    if (o && o.peer !== undefined) {
      let found = null;
      session.awareness.getStates().forEach((st, id) => { if (!found && st && st.peer === o.peer) found = id; });
      return (found !== null && authorOf(found)) || { key: 'p' + o.peer, name: 'Someone', color: '#868e96' };
    }
    return identity();
  }
  function identity() {
    return session ? { key: 'c' + session.ydoc.clientID, name: myName, color: myColor } : null;
  }
  function fileRecord(id, m) {
    const code = m.get('code'), stdin = m.get('stdin');
    return { id, name: m.get('name'), code: code ? code.toString() : '', stdin: stdin instanceof Y.Text ? stdin.toString() : '' };
  }
  function recordDocEvents(events, tr) {
    const R = app.rec;
    const who = authorForTransaction(tr);
    // File-level changes first (a new file carries its full content).
    for (const ev of events) {
      if (ev.target === session.yfiles) {
        ev.changes.keys.forEach((change, id) => {
          if (change.action === 'add') { const m = session.yfiles.get(id); if (m) R.add(fileRecord(id, m), who); }
          else if (change.action === 'delete') R.remove(id, who);
        });
      } else if (ev.target instanceof Y.Map && ev.keysChanged && ev.keysChanged.has('name')) {
        const id = ev.path[0];
        if (typeof id === 'string') R.rename(id, ev.target.get('name'), who);
      }
    }
    for (const ev of events) {
      if (!(ev.target instanceof Y.Text) || ev.path.length !== 2) continue;
      const [id, field] = ev.path;
      if (!session.yfiles.has(id)) continue;
      const fn = field === 'code' ? R.code : field === 'stdin' ? R.input : null;
      if (!fn) continue;
      let pos = 0, pending = null;
      const flush = () => { if (pending) { fn(id, pending.pos, pending.del, pending.text, who); pending = null; } };
      for (const op of ev.delta) {
        if (op.retain) { flush(); pos += op.retain; }
        else if (op.delete) { if (!pending) pending = { pos, del: 0, text: '' }; pending.del += op.delete; }
        else if (typeof op.insert === 'string') {
          if (!pending) pending = { pos, del: 0, text: '' };
          pending.text += op.insert;
          pos += op.insert.length;
        }
      }
      flush();
    }
  }
  function cursorFor(st) {
    if (!st.cursor || !st.file) return null;
    const m = session.yfiles.get(st.file);
    if (!m) return null;
    const text = m.get('code');
    try {
      const a = Y.createAbsolutePositionFromRelativePosition(relPos(st.cursor.anchor), session.ydoc);
      const h = Y.createAbsolutePositionFromRelativePosition(relPos(st.cursor.head), session.ydoc);
      if (!a || !h || a.type !== text || h.type !== text) return null;
      return { file: st.file, anchor: a.index, head: h.index };
    } catch (e) { return null; }
  }
  function recordPresence(changed, removed) {
    const R = app.rec;
    for (const id of changed) {
      const st = session.awareness.getStates().get(id);
      const who = authorOf(id);
      if (!st || !who) continue;
      removedAuthors.set(id, who);
      R.user(who);
      const c = cursorFor(st);
      if (c) R.cursor(c.file, c.anchor, c.head, who);
      else R.cursor(st.file && session.yfiles.has(st.file) ? st.file : null, 0, 0, who);
    }
    for (const id of removed) { const who = removedAuthors.get(id); if (who) R.leave(who); }
  }
  app.room.identity = identity;
  app.room.id = () => (session ? session.id : '');
  app.room.title = () => (session ? session.name || 'Room ' + session.id : '');
  app.room.label = () => (session ? session.name || session.id : '');   // for the tab title

  // Entry points shared by the editor's Collaborate panel and the homepage.
  function createRoom(roomName, files) {
    const id = newRoomId();
    pendingHost = { id, name: cleanName(roomName), files: files || null };
    app.go('room-' + id);
    return id;
  }
  function parseRoomCode(v) {
    const m = String(v || '').trim().match(/(?:#room-)?([a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})\s*$/i);
    return m ? m[1].toLowerCase() : null;
  }
  function setMyName(v) {
    v = String(v || '').trim().slice(0, 32);
    if (!v) return myName;
    myName = v;
    app.store.set('cppwasm.name', v);
    if (session) session.awareness.setLocalStateField('user', { name: myName, color: myColor, colorLight: colorLight(myColor) });
    return myName;
  }
  Object.assign(app.room, {
    available: true,
    create: createRoom,
    parseCode: parseRoomCode,
    getMyName: () => myName,
    setMyName,
    nameMax: NAME_MAX,
  });
  app.room.onRecordStart = () => {
    if (!session) return;
    recordPresence(Array.from(session.awareness.getStates().keys()), []);
  };
  app.room.setRecording = (on) => { if (session) session.awareness.setLocalStateField('rec', !!on); };

  /* ---------------- hooks used by app.js while in a room ---------------- */
  app.room.ops = {
    open,
    addFiles(list) {
      const taken = new Set(app.getFiles().map((f) => f.name.toLowerCase()));
      const ids = [];
      session.ydoc.transact(() => {
        for (const f of list) {
          const id = app.newId();
          ids.push(id);
          addFileToDoc(session.yfiles, session.yorder, { id, name: app.makeUnique(f.name, taken), code: f.code, stdin: f.stdin });
        }
      });
      return ids;
    },
    rename(id, name) { const m = yFile(id); if (m) m.set('name', name); },
    remove(id) {
      const i = session.yorder.toArray().indexOf(id);
      session.ydoc.transact(() => {
        if (i >= 0) session.yorder.delete(i, 1);
        session.yfiles.delete(id);
      });
      const um = session.undos.get(id);
      if (um) { um.destroy(); session.undos.delete(id); }
    },
    setStdin(id, value) { const m = yFile(id); if (m && m.get('stdin') instanceof Y.Text) setYText(m.get('stdin'), value); },
    viewers(id) {
      const out = [];
      session.awareness.getStates().forEach((st, clientId) => {
        if (clientId !== session.ydoc.clientID && st && st.file === id && st.user) out.push(st.user);
      });
      return out;
    },
  };
  app.room.route = (id) => {
    if (id && !ROOM_RE.test(id)) {
      app.filesMessage('That room link isn’t valid.');
      app.go('workspace');
      return;
    }
    if (id) {
      if (session && session.id === id) return;
      const host = pendingHost && pendingHost.id === id ? pendingHost : null;
      pendingHost = null;
      join(id, host);
    } else if (session) {
      leave();
    }
  };

  /* ---------------- panel ---------------- */
  function people() {
    if (!session) return [];
    const list = [];
    session.awareness.getStates().forEach((st, clientId) => {
      if (!st || !st.user) return;
      const f = app.getFiles().find((x) => x.id === st.file);
      list.push({ id: clientId, me: clientId === session.ydoc.clientID, name: st.user.name, color: st.user.color, file: f ? f.name : '', rec: !!st.rec });
    });
    list.sort((a, b) => (b.me - a.me) || a.name.localeCompare(b.name));
    return list;
  }

  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids) if (kid != null) e.append(kid);
    return e;
  }

  function nameField() {
    const input = el('input', { type: 'text', id: 'collab-name', maxlength: '32', value: myName, spellcheck: 'false', autocomplete: 'off' });
    input.addEventListener('change', () => { input.value = setMyName(input.value); });
    return el('label', { class: 'collab-field' }, el('span', {}, 'Your name'), input);
  }

  function renderPanel() {
    const count = session ? people().length : 0;
    btn.classList.toggle('in-room', !!session);
    btn.querySelector('.label').textContent = session ? (session.name || 'Room') + ' · ' + count : 'Collaborate';
    btn.title = session ? (session.name ? session.name + ' (' + session.id + ')' : 'Room ' + session.id) + ', ' + count + (count === 1 ? ' person' : ' people') : 'Edit files together in real time';
    if (panel.hidden) return;
    panel.textContent = '';

    if (!session) {
      const code = el('input', { type: 'text', id: 'collab-code', placeholder: 'abcd-efgh-jkmn', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Room code or link' });
      const joinBtn = el('button', { type: 'button', class: 'btn', onclick: () => {
        const id = parseRoomCode(code.value);
        if (!id) { err.textContent = 'Paste a room link, or a code like abcd-efgh-jkmn.'; return; }
        closePanel();
        app.go('room-' + id);
      } }, 'Join');
      code.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinBtn.click(); });
      const err = el('p', { class: 'collab-error', 'aria-live': 'polite' });
      const roomName = el('input', { type: 'text', id: 'collab-room-name', maxlength: String(NAME_MAX), placeholder: 'e.g. Algorithms study group', spellcheck: 'false', autocomplete: 'off' });
      const startBtn = el('button', { type: 'button', class: 'btn primary wide', onclick: async () => {
        startBtn.disabled = true;
        startBtn.textContent = 'Creating…';
        closePanel();
        createRoom(roomName.value);
        openPanel();
      } }, 'Start a room with my files');
      roomName.addEventListener('keydown', (e) => { if (e.key === 'Enter') startBtn.click(); });
      panel.append(...[
        el('h3', {}, 'Collaborate'),
        el('p', { class: 'collab-lede' }, 'Edit files together in real time. Each person compiles and runs programs on their own device.'),
        nameField(),
        el('label', { class: 'collab-field' }, el('span', {}, 'Room name (optional)'), roomName),
        startBtn,
        el('div', { class: 'collab-or' }, el('span', {}, 'or join one')),
        el('div', { class: 'collab-row' }, code, joinBtn),
        err,
      ].filter(Boolean));
      return;
    }

    const link = roomLink(session.id);
    const copy = el('button', { type: 'button', class: 'btn', onclick: async () => {
      try { await navigator.clipboard.writeText(link); copy.textContent = 'Copied'; }
      catch (e) { linkInput.select(); copy.textContent = 'Press Ctrl+C'; }
      setTimeout(() => { copy.textContent = 'Copy link'; }, 2000);
    } }, 'Copy link');
    const linkInput = el('input', { type: 'text', readonly: true, value: link, 'aria-label': 'Room link', onfocus: (e) => e.target.select() });

    const list = el('ul', { class: 'collab-people' });
    for (const p of people()) {
      const kids = [
        el('span', { class: 'dot', style: 'background:' + p.color }),
        el('span', { class: 'who' }, p.me ? p.name + ' (you)' : p.name),
        p.rec ? el('span', { class: 'rec-badge', title: p.me ? 'You are recording this room' : p.name + ' is recording this room' }, 'REC') : null,
        el('span', { class: 'where' }, p.file),
      ];
      list.append(el('li', {}, p.me || !p.file ? el('div', { class: 'person' }, ...kids)
        : el('button', { type: 'button', class: 'person', title: 'Go to ' + p.name + '’s cursor', onclick: () => { closePanel(); jumpTo(p.id); } }, ...kids)));
    }

    const others = session.peers.size;
    let state;
    if (session.error) state = el('p', { class: 'collab-error' }, session.error);
    else if (!session.synced) {
      const waited = Date.now() - (session.joinedAt || (session.joinedAt = Date.now()));
      state = el('p', { class: 'collab-state' }, waited > 14000
        ? 'No one with this room open is online yet. The files arrive when someone who has them joins.'
        : 'Looking for people in this room…');
      if (waited > 14000) {
        state = el('div', {}, state, el('button', { type: 'button', class: 'btn wide', onclick: () => {
          const files = session.local.files;
          session.ydoc.transact(() => { for (const f of files) addFileToDoc(session.yfiles, session.yorder, { id: app.newId(), name: f.name, code: f.code, stdin: f.stdin }); });
          markSynced();
        } }, 'Start this room with my files'));
      }
    } else state = el('p', { class: 'collab-state ok' }, others
      ? 'Connected to ' + others + (others === 1 ? ' person.' : ' people.')
      : 'Waiting for others. Share the link to invite them.');

    panel.append(...[
      roomHeading(),
      el('div', { class: 'collab-row' }, linkInput, copy),
      state,
      others >= MAX_PEERS ? el('p', { class: 'collab-error' }, 'Rooms work best with up to ' + MAX_PEERS + ' people.') : null,
      el('h4', {}, 'People'),
      list,
      nameField(),
      el('p', { class: 'collab-note' }, 'Anyone with the link can join and edit. Files are shared only between the browsers in the room.'),
      el('button', { type: 'button', class: 'btn wide', onclick: () => { closePanel(); app.go('workspace'); } }, 'Leave room'),
    ].filter(Boolean));
  }

  function roomHeading() {
    const s = session;
    return s.name
      ? el('h3', { class: 'room-title' }, el('span', { class: 'room-name' }, s.name), el('code', {}, s.id))
      : el('h3', { class: 'room-title' }, 'Room ', el('code', {}, s.id));
  }

  function openPanel() {
    panel.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    renderPanel();
    const first = panel.querySelector('input, button');
    if (first) first.focus();
  }
  function closePanel() {
    panel.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  }
  btn.addEventListener('click', () => (panel.hidden ? openPanel() : closePanel()));
  document.addEventListener('pointerdown', (e) => {
    if (!panel.hidden && !panel.contains(e.target) && !btn.contains(e.target)) closePanel();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) { closePanel(); btn.focus(); }
  });
  setInterval(() => { if (session && !session.synced && !panel.hidden) renderPanel(); }, 3000);
  window.addEventListener('pagehide', () => { if (session) try { session.room.leave(); } catch (e) {} });

  renderPanel();
};
