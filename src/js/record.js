/* cpp.wasm recordings: record every file and content change in the workspace or
   room (by everyone in it), keep recordings in this browser, and play them back.
   The file format is in cpprec.js. app.js calls window.CppWasmRecordInstall(app). */
window.CppWasmRecordInstall = function (app) {
  'use strict';

  const $ = app.$;
  const R = window.CppRec;
  const T = R.T;
  const rec = app.rec;   // hooks object shared with app.js and collab.js
  const btn = $('#rec-btn');
  if (!R) { btn.disabled = true; return; }

  const CURSOR_THROTTLE_MS = 150;
  const AUTOSAVE_MS = 20000;      // at least this often while changes keep coming
  const AUTOSAVE_IDLE_MS = 1500;  // and soon after they pause
  const MAX_EVENTS = 2000000;

  /* ================= storage (IndexedDB, with an in-memory fallback) ================= */
  const store = (() => {
    const mem = new Map();
    let dbp = null;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise((resolve) => {
        try {
          const req = indexedDB.open('cppwasm', 1);
          req.onupgradeneeded = () => req.result.createObjectStore('recordings', { keyPath: 'id' });
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
        } catch (e) { resolve(null); }
      });
      return dbp;
    }
    async function tx(mode, fn) {
      const db = await open();
      if (!db) return fn(null);
      return new Promise((resolve, reject) => {
        const t = db.transaction('recordings', mode);
        const out = fn(t.objectStore('recordings'));
        t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
        t.onerror = () => reject(t.error);
      });
    }
    return {
      put: (item) => tx('readwrite', (s) => (s ? s.put(item) : mem.set(item.id, item))),
      get: (id) => tx('readonly', (s) => (s ? s.get(id) : mem.get(id))),
      all: () => tx('readonly', (s) => (s ? s.getAll() : Array.from(mem.values()))),
      remove: (id) => tx('readwrite', (s) => (s ? s.delete(id) : mem.delete(id))),
    };
  })();

  /* ================= recorder ================= */
  let cur = null;   // the recording in progress

  const localMe = () => ({ key: 'me', name: (app.store.get('cppwasm.name', '') || 'You').slice(0, 32), color: '#1c7ed6' });
  const me = () => (app.room.identity && app.room.identity()) || localMe();
  const now = () => Math.round(performance.now() - cur.perf);

  function push(e) {
    if (cur.events.length >= MAX_EVENTS) { stop('limit'); return; }
    e.t = now();
    cur.events.push(e);
    cur.dirty = true;
    // Save soon after changes pause, so closing the tab loses almost nothing.
    clearTimeout(cur.idleSave);
    const c = cur;
    cur.idleSave = setTimeout(() => { if (cur === c && c.dirty) save(c, true); }, AUTOSAVE_IDLE_MS + Math.min(8000, c.events.length / 10));
  }

  function userIdx(author) {
    const a = author || me();
    let u = cur.users.get(a.key);
    if (!u) {
      u = { idx: cur.users.size, name: '', color: '' };
      cur.users.set(a.key, u);
    }
    if (u.name !== a.name || u.color !== a.color) {
      u.name = a.name; u.color = a.color;
      push({ type: T.USER, user: u.idx, name: a.name, color: a.color });
    }
    return u.idx;
  }

  function fileIdx(id) { return cur.files.get(id); }

  function flushCursor(u) {
    const p = cur.pendingCursor.get(u);
    if (!p) return;
    cur.pendingCursor.delete(u);
    const last = cur.lastCursor.get(u);
    if (last && last.file === p.file && last.anchor === p.anchor && last.head === p.head) return;
    const prevT = cur.events.length ? cur.events[cur.events.length - 1].t : 0;
    const e = { type: T.CURSOR, user: u, file: p.file, anchor: p.anchor, head: p.head };
    push(e);
    e.t = Math.max(p.t, prevT);   // when the move happened, not when it was flushed
    cur.lastCursor.set(u, { file: p.file, anchor: p.anchor, head: p.head });
    cur.lastCursorAt.set(u, p.t);
  }

  function start() {
    if (cur) return;
    const inRoom = app.room.active;
    cur = {
      id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: inRoom ? (app.room.title ? app.room.title() : 'Room ' + app.room.id()) : 'Workspace',
      room: inRoom ? app.room.id() : undefined,
      started: Date.now(),
      perf: performance.now(),
      events: [],
      users: new Map(),
      files: new Map(),
      nextFile: 1,
      pendingCursor: new Map(),
      lastCursor: new Map(),
      lastCursorAt: new Map(),
      cursorTimer: 0,
      dirty: false,
      autosave: 0,
    };
    const u = userIdx();
    for (const f of app.getFiles()) addFile(f, u);
    if (app.room.onRecordStart) app.room.onRecordStart();
    rec.active = true;
    cur.autosave = setInterval(() => { if (cur && cur.dirty) save(cur, true); }, AUTOSAVE_MS);
    tick();
    if (app.room.setRecording) app.room.setRecording(true);
    save(cur, true);   // list it right away (marked unfinished until it stops)
    app.filesMessage('Recording started. Every change is saved; press Stop when you’re done.', true);
  }

  function addFile(f, u) {
    const idx = cur.nextFile++;
    cur.files.set(f.id, idx);
    push({ type: T.ADD, user: u, file: idx, name: f.name, code: f.code, input: f.stdin || '' });
  }

  // Encodes synchronously (so later events can't slip in), then stores.
  async function save(c, partial) {
    if (!c) return null;
    if (c === cur) c.pendingCursor.forEach((_, u) => flushCursor(u));
    c.dirty = false;
    const people = Array.from(c.users.values()).map((u) => u.name);
    const bytes = R.encode({ title: c.title, started: c.started, room: c.room }, c.events);
    const item = {
      id: c.id, title: c.title, created: c.started,
      duration: c.events.length ? c.events[c.events.length - 1].t : 0,
      people: Array.from(new Set(people)), files: c.nextFile - 1, events: c.events.length,
      size: bytes.length, partial: !!partial, bytes,
    };
    try { await store.put(item); } catch (e) { console.warn('cpp.wasm: could not save the recording', e); }
    return item;
  }

  async function stop(reason) {
    if (!cur) return;
    const c = cur;
    clearInterval(c.autosave);
    clearTimeout(c.cursorTimer);
    clearTimeout(c.idleSave);
    c.pendingCursor.forEach((_, u) => flushCursor(u));
    rec.active = false;
    cur = null;
    const saving = save(c, false);
    tick();
    if (app.room.setRecording) app.room.setRecording(false);
    const item = await saving;
    if (document.body.classList.contains('show-recordings')) renderList();
    if (item) {
      const why = reason === 'workspace' ? ' (the workspace changed)' : reason === 'limit' ? ' (it reached the size limit)' : '';
      app.filesMessage('Recording saved' + why + ': ' + fmtTime(item.duration) + ', ' + fmtSize(item.size) + '. Find it under Recordings.', true);
    }
  }

  /* ---------- hooks called by app.js (local workspace) and collab.js (rooms) ---------- */
  Object.assign(rec, {
    active: false,
    start, stop,
    isRecording: () => !!cur,
    user(author) { if (cur) userIdx(author); },
    leave(author) {
      if (!cur || !cur.users.has(author.key)) return;
      const u = cur.users.get(author.key).idx;
      cur.pendingCursor.delete(u);
      push({ type: T.LEAVE, user: u });
    },
    add(file, author) { if (cur && !cur.files.has(file.id)) addFile(file, userIdx(author)); },
    rename(id, name, author) {
      const f = cur && fileIdx(id);
      if (f) push({ type: T.RENAME, user: userIdx(author), file: f, name });
    },
    remove(id, author) {
      const f = cur && fileIdx(id);
      if (!f) return;
      push({ type: T.DELETE, user: userIdx(author), file: f });
      cur.files.delete(id);
    },
    code(id, pos, del, text, author) { edit(T.EDIT, id, pos, del, text, author); },
    input(id, pos, del, text, author) { edit(T.INPUT, id, pos, del, text, author); },
    cursor(id, anchor, head, author) {
      if (!cur) return;
      const u = userIdx(author);
      const f = id ? fileIdx(id) || 0 : 0;
      const t = now();
      cur.pendingCursor.set(u, { file: f, anchor, head, t });
      const since = t - (cur.lastCursorAt.get(u) || -1e9);
      if (since >= CURSOR_THROTTLE_MS) flushCursor(u);
      else if (!cur.cursorTimer) {
        cur.cursorTimer = setTimeout(() => {
          if (!cur) return;
          cur.cursorTimer = 0;
          cur.pendingCursor.forEach((_, uu) => flushCursor(uu));
        }, CURSOR_THROTTLE_MS - since);
      }
    },
  });

  function edit(type, id, pos, del, text, author) {
    if (!cur || (!del && !text)) return;
    const f = fileIdx(id);
    if (!f) return;
    const u = userIdx(author);
    if (type === T.EDIT) flushCursor(u);   // keep a selection that the edit replaces
    push({ type, user: u, file: f, pos, del, text });
    if (type === T.EDIT) {
      // Typing moves the cursor; the player infers that, so don't record it again.
      const at = pos + text.length;
      cur.lastCursor.set(u, { file: f, anchor: at, head: at });
      cur.pendingCursor.delete(u);
    }
  }

  window.addEventListener('pagehide', () => { if (cur) save(cur, true); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && cur && cur.dirty) save(cur, true); });

  /* ---------- record button ---------- */
  function fmtTime(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = String(s % 60).padStart(2, '0');
    return h ? h + ':' + String(m).padStart(2, '0') + ':' + ss : m + ':' + ss;
  }
  function fmtSize(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }

  let clock = 0;
  function tick() {
    clearInterval(clock);
    btn.classList.toggle('recording', !!cur);
    const label = btn.querySelector('.label');
    if (!cur) {
      label.textContent = 'Record';
      btn.title = 'Record every change to the files (everyone’s, in a room)';
      btn.setAttribute('aria-pressed', 'false');
      return;
    }
    btn.setAttribute('aria-pressed', 'true');
    btn.title = 'Stop recording';
    const upd = () => { if (cur) label.textContent = fmtTime(performance.now() - cur.perf); };
    upd();
    clock = setInterval(upd, 500);
  }
  btn.addEventListener('click', () => (cur ? stop() : start()));
  tick();

  /* ================= recordings page ================= */
  const listEl = $('#rec-list');
  const recInput = $('#rec-input');

  async function renderList() {
    $('#recs-msg').textContent = '';
    let items = [];
    try { items = await store.all(); } catch (e) {}
    items.sort((a, b) => b.created - a.created);
    listEl.textContent = '';
    $('#recs-empty').hidden = items.length > 0;
    const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    for (const it of items) {
      const li = document.createElement('li');
      li.className = 'rec-item';
      const live = cur && cur.id === it.id;
      const info = document.createElement('div');
      info.className = 'rec-info';
      const title = document.createElement('strong');
      title.textContent = it.title + ', ' + dateFmt.format(new Date(it.created));
      const meta = document.createElement('span');
      meta.textContent = [fmtTime(it.duration), (it.people || []).join(', '), it.files + (it.files === 1 ? ' file' : ' files'),
        it.events.toLocaleString() + ' changes', fmtSize(it.size)].filter(Boolean).join('  ·  ');
      info.append(title, meta);
      if (live) { const b = document.createElement('em'); b.className = 'rec-live'; b.textContent = 'Recording now'; info.append(b); }
      else if (it.partial) { const b = document.createElement('em'); b.className = 'rec-live'; b.textContent = 'Unfinished (the page closed while recording)'; info.append(b); }
      const acts = document.createElement('div');
      acts.className = 'rec-acts';
      const mk = (label, cls, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn' + (cls ? ' ' + cls : ''); b.textContent = label; b.addEventListener('click', fn); return b; };
      if (live) {
        acts.append(mk('Stop recording', 'danger', () => stop()));
        li.append(info, acts);
        listEl.appendChild(li);
        continue;
      }
      acts.append(
        mk('Play', 'primary', () => app.go('play-' + it.id)),
        mk('Download', '', () => download(it)),
        mk('Delete', 'danger', async () => {
          if (!confirm('Delete this recording? This can’t be undone.')) return;
          await store.remove(it.id);
          renderList();
        }),
      );
      li.append(info, acts);
      listEl.appendChild(li);
    }
  }

  function download(it) {
    const url = URL.createObjectURL(new Blob([it.bytes], { type: 'application/octet-stream' }));
    const a = document.createElement('a');
    const stamp = new Date(it.created).toISOString().slice(0, 16).replace(/[T:]/g, '-');
    a.href = url;
    a.download = 'cpp-wasm-' + it.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + stamp + '.cpprec';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  async function openFile(file) {
    const msg = $('#recs-msg');
    msg.textContent = '';
    try {
      if (file.size > 200 * 1024 * 1024) throw new Error('That file is larger than 200 MB.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { meta, events } = R.decode(bytes);
      const users = new Map();
      let files = 0;
      for (const e of events) { if (e.type === T.USER) users.set(e.user, e.name); if (e.type === T.ADD) files++; }
      const item = {
        id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        title: String(meta.title || file.name.replace(/\.cpprec$/i, '')).slice(0, 80),
        created: Number(meta.started) || Date.now(),
        duration: events.length ? events[events.length - 1].t : 0,
        people: Array.from(new Set(users.values())), files, events: events.length,
        size: bytes.length, partial: false, bytes,
      };
      await store.put(item);
      app.go('play-' + item.id);
    } catch (e) {
      msg.textContent = e.message || String(e);
    }
  }
  $('#rec-open').addEventListener('click', () => { recInput.value = ''; recInput.click(); });
  recInput.addEventListener('change', () => { if (recInput.files[0]) openFile(recInput.files[0]); });
  const recsSection = $('#recordings');
  recsSection.addEventListener('dragover', (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault(); });
  recsSection.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) openFile(f); });

  /* ================= player ================= */
  const P = {
    item: null, events: [], users: null, cm: null,
    timesReal: null, timesSkip: null, skip: true, speed: 1,
    i: 0, pos: 0, playing: false, raf: 0, lastFrame: 0,
    state: null, checkpoints: [], docs: new Map(), dirty: new Set(), shown: null, pinned: null, marks: [], flash: [],
  };
  const PAUSE_CAP_MS = 1500;
  const CHECKPOINT_EVERY = 300;

  function newState() { return { files: new Map(), users: new Map(), lastFile: null }; }
  function cloneState(s) {
    const c = newState();
    s.files.forEach((f, k) => c.files.set(k, Object.assign({}, f)));
    s.users.forEach((u, k) => c.users.set(k, Object.assign({}, u)));
    c.lastFile = s.lastFile;
    return c;
  }
  function user(s, idx) {
    let u = s.users.get(idx);
    if (!u) { u = { name: 'Person ' + (idx + 1), color: '#888888', file: 0, anchor: 0, head: 0, left: false }; s.users.set(idx, u); }
    return u;
  }
  // Applies one event to the state. Returns a description of what to redraw.
  function apply(s, e) {
    const u = user(s, e.user);
    const f = s.files.get(e.file);
    switch (e.type) {
      case T.USER: u.name = e.name; u.color = e.color; u.left = false; break;
      case T.ADD: s.files.set(e.file, { name: e.name, code: e.code, input: e.input, alive: true }); s.lastFile = e.file; u.file = e.file; break;
      case T.RENAME: if (f) { f.name = e.name; s.lastFile = e.file; } break;
      case T.DELETE: if (f) f.alive = false; if (s.lastFile === e.file) s.lastFile = null; if (u.file === e.file) u.file = 0; break;
      case T.EDIT:
        if (!f) break;
        f.code = R.splice(f.code, e.pos, e.del, e.text);
        u.file = e.file; u.anchor = u.head = e.pos + e.text.length;
        s.lastFile = e.file;
        break;
      case T.INPUT: if (f) { f.input = R.splice(f.input, e.pos, e.del, e.text); s.lastFile = e.file; } break;
      case T.CURSOR: u.file = e.file; u.anchor = e.anchor; u.head = e.head; break;
      case T.LEAVE: u.left = true; u.file = 0; break;
    }
  }

  function prepare(events) {
    P.events = events;
    const n = events.length;
    P.timesReal = new Float64Array(n);
    P.timesSkip = new Float64Array(n);
    let prev = 0, v = 0;
    for (let i = 0; i < n; i++) {
      const t = events[i].t;
      v += Math.min(t - prev, PAUSE_CAP_MS);
      prev = t;
      P.timesReal[i] = t;
      P.timesSkip[i] = v;
    }
    // Checkpoints make seeking fast: a full copy of the state every N events.
    P.checkpoints = [];
    const s = newState();
    for (let i = 0; i < n; i++) {
      if (i % CHECKPOINT_EVERY === 0) P.checkpoints.push({ i, state: cloneState(s) });
      apply(s, events[i]);
    }
  }

  const times = () => (P.skip ? P.timesSkip : P.timesReal) || new Float64Array(0);
  const duration = () => { const t = times(); return t.length ? t[t.length - 1] : 0; };

  // Index of the first event after timeline position `pos`.
  function indexAt(pos) {
    const t = times();
    let lo = 0, hi = t.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (t[mid] <= pos) lo = mid + 1; else hi = mid; }
    return lo;
  }

  function seek(pos) {
    pos = Math.max(0, Math.min(pos, duration()));
    const target = indexAt(pos);
    let cp = P.checkpoints[0];
    for (const c of P.checkpoints) { if (c.i <= target) cp = c; else break; }
    // Moving forward a little: continue from the current state instead of a checkpoint.
    if (!(target >= P.i && target - P.i < CHECKPOINT_EVERY && P.state)) {
      P.state = cloneState(cp ? cp.state : newState());
      P.i = cp ? cp.i : 0;
    }
    while (P.i < target) apply(P.state, P.events[P.i++]);
    P.pos = pos;
    P.state.files.forEach((_, k) => P.dirty.add(k));
    render(true);
  }

  function shownFile() {
    const s = P.state;
    const alive = (k) => k != null && s.files.get(k) && s.files.get(k).alive;
    if (P.pinned != null && alive(P.pinned) && !$('#player-follow').checked) return P.pinned;
    if (alive(s.lastFile)) return s.lastFile;
    if (alive(P.shown)) return P.shown;
    for (const [k, f] of s.files) if (f.alive) return k;
    return null;
  }

  function docFor(k) {
    let d = P.docs.get(k);
    if (!d) { d = CodeMirror.Doc(P.state.files.get(k).code, 'text/x-c++src'); P.docs.set(k, d); P.dirty.delete(k); }
    if (P.dirty.has(k)) { d.setValue(P.state.files.get(k).code); P.dirty.delete(k); }
    return d;
  }

  function clearMarks() { for (const m of P.marks) m.clear(); P.marks = []; }

  function drawCursors(k) {
    clearMarks();
    if (k == null) return;
    const doc = P.cm.getDoc();
    const len = doc.getValue().length;
    P.state.users.forEach((u) => {
      if (u.left || u.file !== k) return;
      const a = doc.posFromIndex(Math.min(u.anchor, len)), h = doc.posFromIndex(Math.min(u.head, len));
      if (u.anchor !== u.head) {
        const from = u.anchor < u.head ? a : h, to = u.anchor < u.head ? h : a;
        P.marks.push(doc.markText(from, to, { css: 'background-color:' + u.color + '55' }));
      }
      const caret = document.createElement('span');
      caret.className = 'remote-caret';
      caret.style.borderColor = u.color;
      const tag = document.createElement('div');
      tag.style.backgroundColor = u.color;
      tag.textContent = u.name;
      caret.appendChild(tag);
      P.marks.push(doc.setBookmark(h, { widget: caret, insertLeft: true }));
    });
  }

  function render(full) {
    const s = P.state;
    const k = shownFile();
    if (k !== P.shown || full) {
      P.shown = k;
      if (k != null) { const d = docFor(k); if (P.cm.getDoc() !== d) P.cm.swapDoc(d); }
      else P.cm.swapDoc(CodeMirror.Doc('', 'text/x-c++src'));
    }
    const f = k != null ? s.files.get(k) : null;
    $('#player-file').textContent = f ? f.name : 'No files';
    $('#player-input').textContent = f && f.input ? f.input : '(no input)';
    drawCursors(k);
    renderSide();
    renderTime();
  }

  function renderSide() {
    const s = P.state;
    const fl = $('#player-files');
    fl.textContent = '';
    s.files.forEach((f, k) => {
      if (!f.alive) return;
      const li = document.createElement('li');
      li.className = 'file-item' + (k === P.shown ? ' active' : '');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'open';
      b.textContent = f.name;
      b.addEventListener('click', () => { P.pinned = k; $('#player-follow').checked = false; render(true); });
      li.appendChild(b);
      const here = [];
      s.users.forEach((u) => { if (!u.left && u.file === k) here.push(u); });
      if (here.length) {
        const dots = document.createElement('span');
        dots.className = 'viewers';
        for (const u of here.slice(0, 4)) { const d = document.createElement('span'); d.className = 'dot'; d.style.background = u.color; dots.appendChild(d); }
        li.appendChild(dots);
      }
      fl.appendChild(li);
    });
    const pl = $('#player-people');
    pl.textContent = '';
    s.users.forEach((u) => {
      const li = document.createElement('li');
      const d = document.createElement('span'); d.className = 'dot'; d.style.background = u.color;
      const n = document.createElement('span'); n.className = 'who'; n.textContent = u.name;
      const w = document.createElement('span'); w.className = 'where';
      const uf = s.files.get(u.file);
      w.textContent = u.left ? 'left' : uf && uf.alive ? uf.name : '';
      li.append(d, n, w);
      pl.appendChild(li);
    });
  }

  function renderTime() {
    const d = duration();
    $('#player-time').textContent = fmtTime(P.pos) + ' / ' + fmtTime(d);
    const scrub = $('#player-scrub');
    if (!scrub.matches(':active')) scrub.value = d ? Math.round((P.pos / d) * 1000) : 0;
    $('#player-play').textContent = P.playing ? 'Pause' : (P.pos >= d && d > 0 ? 'Replay' : 'Play');
  }

  // Forward playback: apply events as their time comes, updating the editor in place.
  function frame(ts) {
    if (!P.playing) return;
    const dt = Math.min(250, ts - (P.lastFrame || ts));
    P.lastFrame = ts;
    P.pos = Math.min(duration(), P.pos + dt * P.speed);
    const target = indexAt(P.pos);
    const bulk = target - P.i > 400;
    let needFull = false;
    for (const m of P.flash) m.clear();
    P.flash = [];
    while (P.i < target) {
      const e = P.events[P.i++];
      apply(P.state, e);
      if (bulk) { P.dirty.add(e.file); continue; }
      if (e.type === T.EDIT) {
        const d = P.docs.get(e.file);
        if (d && !P.dirty.has(e.file)) {
          const from = d.posFromIndex(e.pos), to = d.posFromIndex(e.pos + e.del);
          d.replaceRange(e.text, from, to);
          if (e.text && d === P.cm.getDoc()) {
            const end = d.posFromIndex(e.pos + e.text.length);
            P.flash.push(d.markText(from, end, { className: 'rec-new' }));
            if (e.file === P.shown) P.cm.scrollIntoView(end, 60);
          }
        } else P.dirty.add(e.file);
      } else if (e.type === T.ADD || e.type === T.DELETE || e.type === T.RENAME) {
        P.dirty.add(e.file);
        needFull = true;
      }
    }
    render(bulk || needFull || shownFile() !== P.shown);
    if (P.pos >= duration()) { P.playing = false; renderTime(); return; }
    P.raf = requestAnimationFrame(frame);
  }

  function play() {
    if (P.pos >= duration()) seek(0);
    P.playing = true;
    P.lastFrame = 0;
    cancelAnimationFrame(P.raf);
    P.raf = requestAnimationFrame(frame);
    renderTime();
  }
  function pause() { P.playing = false; cancelAnimationFrame(P.raf); if (P.state) renderTime(); }

  function drawHeat() {
    const c = $('#player-heat');
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    const d = duration();
    if (!d) return;
    const bins = new Float32Array(Math.max(1, Math.floor(w / 2)));
    const t = times();
    for (let i = 0; i < t.length; i++) bins[Math.min(bins.length - 1, Math.floor((t[i] / d) * bins.length))]++;
    let max = 1;
    for (const b of bins) if (b > max) max = b;
    g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent') || '#00599C';
    g.globalAlpha = 0.45;
    const bw = w / bins.length;
    bins.forEach((b, i) => { if (!b) return; const bh = Math.max(2, (Math.sqrt(b / max)) * h); g.fillRect(i * bw, h - bh, Math.max(1, bw - 0.5), bh); });
  }

  async function enterPlayer(id) {
    pause();
    $('#player-title').textContent = 'Loading…';
    let item = null;
    try { item = await store.get(id); } catch (e) {}
    if (!item) { $('#player-title').textContent = 'Recording not found'; $('#player-meta').textContent = 'It may have been deleted, or it was saved in another browser.'; return; }
    let decoded;
    try { decoded = R.decode(item.bytes); } catch (e) { $('#player-title').textContent = 'Can’t play this recording'; $('#player-meta').textContent = e.message; return; }
    P.item = item;
    if (!P.cm) {
      P.cm = CodeMirror($('#player-cm'), {
        value: '', mode: 'text/x-c++src', lineNumbers: true, readOnly: true, indentUnit: 4, tabSize: 4,
      });
    }
    P.docs.clear(); P.dirty.clear(); P.state = null; P.i = 0; P.pinned = null; P.shown = null;
    $('#player-follow').checked = true;
    prepare(decoded.events);
    const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    $('#player-title').textContent = item.title;
    $('#player-meta').textContent = dateFmt.format(new Date(item.created)) + '  ·  ' + fmtTime(item.duration) + '  ·  ' + item.events.toLocaleString() + ' changes  ·  ' + fmtSize(item.size);
    seek(0);
    requestAnimationFrame(() => { P.cm.refresh(); drawHeat(); });
  }

  $('#player-play').addEventListener('click', () => (P.playing ? pause() : play()));
  $('#player-scrub').addEventListener('input', (e) => { seek((e.target.value / 1000) * duration()); });
  $('#player-speed').addEventListener('change', (e) => { P.speed = Number(e.target.value) || 1; });
  $('#player-skip').addEventListener('change', (e) => {
    const frac = duration() ? P.pos / duration() : 0;
    const idx = indexAt(P.pos);
    P.skip = e.target.checked;
    const t = times();
    P.pos = idx > 0 ? t[idx - 1] : frac * duration();
    drawHeat();
    renderTime();
  });
  $('#player-follow').addEventListener('change', () => { if (!$('#player-follow').checked) P.pinned = P.shown; render(true); });
  $('#player-download').addEventListener('click', () => { if (P.item) download(P.item); });
  $('#player-zip').addEventListener('click', () => {
    if (!P.state || !window.fflate) return;
    const entries = {};
    P.state.files.forEach((f) => {
      if (!f.alive) return;
      entries[f.name] = window.fflate.strToU8(f.code);
      if (f.input) entries['input/' + f.name + '.txt'] = window.fflate.strToU8(f.input);
    });
    const data = window.fflate.zipSync(entries, { level: 6 });
    const url = URL.createObjectURL(new Blob([data], { type: 'application/zip' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'cpp-wasm-files-at-' + fmtTime(P.pos).replace(/:/g, '-') + '.zip';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  });
  document.addEventListener('keydown', (e) => {
    if (!document.body.classList.contains('show-player') || e.target.closest('input, select, textarea')) return;
    if (e.key === ' ') { e.preventDefault(); P.playing ? pause() : play(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); seek(P.pos + 5000); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); seek(P.pos - 5000); }
  });
  window.addEventListener('resize', () => { if (document.body.classList.contains('show-player')) drawHeat(); });

  app.views.recordings = { enter: renderList, leave() {} };
  app.views.player = { enter: enterPlayer, leave: pause };
};
