/* CPPREC: cpp.wasm's recording format (version 1).

   A recording is a list of timed events that replays every file and content
   change, by everyone who took part. It is stored compactly:

     bytes 0-5   "CPPREC" (ASCII magic)
     byte  6     format version (1)
     byte  7     flags: bit 0 set = the rest is raw-DEFLATE compressed
     rest        payload (compressed or not)

   Payload, all integers unsigned LEB128 varints, strings = varint byte length
   followed by UTF-8 bytes:

     header      string: JSON {app, v, title, started, duration, tick, room?, users, files, events}
     events...   until the end of the payload

   Each event starts with two varints:

     dt          time since the previous event, in ticks of 10 ms
     kind        type | (user << 3)   (type is 0-7; user is the author's number)

   followed by fields that depend on the type:

     0 USER      name, color              declares (or renames) user number `user`
     1 ADD       file, name, code, input  file numbers are chosen by the recorder
     2 RENAME    file, name
     3 DELETE    file
     4 EDIT      file, posDelta, del, text   in the file's code: delete `del` UTF-16 units at pos, insert `text`
     5 INPUT     file, posDelta, del, text   the same, in the file's batch input
     6 CURSOR    file, anchorDelta, headDelta   file 0 means "no file"

   posDelta is zigzag(pos - expected), where expected is where the same user's
   previous EDIT (or INPUT) in the same file ended, or 0. Typing gives 0 and
   Backspace gives -1, so these are almost always one byte. anchorDelta is
   zigzag(anchor - the user's last edit or cursor position) and headDelta is
   zigzag(head - anchor).
     7 LEAVE                              user left (rooms only)

   Size savings come from: varints instead of fixed-width numbers, time deltas
   rounded to 10 ms, users and files referred to by small numbers, cursor
   heads stored relative to the anchor, cursor moves skipped when they only
   follow the user's own typing, cursor moves throttled, positions stored
   relative to where they were expected, and DEFLATE level 9
   over the whole payload (typing produces very repetitive bytes). */
(function () {
  'use strict';

  const MAGIC = [0x43, 0x50, 0x50, 0x52, 0x45, 0x43]; // "CPPREC"
  const VERSION = 1;
  const TICK_MS = 10;
  const T = { USER: 0, ADD: 1, RENAME: 2, DELETE: 3, EDIT: 4, INPUT: 5, CURSOR: 6, LEAVE: 7 };
  const te = new TextEncoder();
  const td = new TextDecoder();

  class Writer {
    constructor() { this.buf = new Uint8Array(4096); this.n = 0; }
    ensure(k) {
      if (this.n + k <= this.buf.length) return;
      let size = this.buf.length * 2;
      while (size < this.n + k) size *= 2;
      const b = new Uint8Array(size);
      b.set(this.buf.subarray(0, this.n));
      this.buf = b;
    }
    uint(v) {
      if (!(v >= 0) || !Number.isFinite(v)) v = 0;
      this.ensure(10);
      while (v >= 0x80) { this.buf[this.n++] = (v % 128) | 0x80; v = Math.floor(v / 128); }
      this.buf[this.n++] = v;
    }
    sint(v) { this.uint(v >= 0 ? v * 2 : -v * 2 - 1); }
    str(s) {
      const b = te.encode(s || '');
      this.uint(b.length);
      this.ensure(b.length);
      this.buf.set(b, this.n);
      this.n += b.length;
    }
    bytes() { return this.buf.subarray(0, this.n); }
  }

  class Reader {
    constructor(b) { this.b = b; this.i = 0; }
    get done() { return this.i >= this.b.length; }
    uint() {
      let r = 0, m = 1, x;
      do {
        if (this.i >= this.b.length) throw new Error('The recording is cut short.');
        x = this.b[this.i++];
        r += (x & 0x7f) * m;
        m *= 128;
      } while (x & 0x80);
      return r;
    }
    sint() { const u = this.uint(); return u % 2 ? -(u + 1) / 2 : u / 2; }
    str() {
      const n = this.uint();
      if (this.i + n > this.b.length) throw new Error('The recording is cut short.');
      const s = td.decode(this.b.subarray(this.i, this.i + n));
      this.i += n;
      return s;
    }
  }

  // What the encoder and decoder both track to predict positions.
  class Context {
    constructor() { this.ends = new Map(); this.at = new Map(); }
    key(e) { return e.user + ':' + e.file + ':' + e.type; }
    expected(e) { return this.ends.get(this.key(e)) || 0; }
    edited(e) { const end = e.pos + e.text.length; this.ends.set(this.key(e), end); if (e.type === T.EDIT) this.at.set(e.user, end); }
    lastAt(u) { return this.at.get(u) || 0; }
    moved(e) { this.at.set(e.user, e.head); }
  }

  /* Events in memory are plain objects with `t` (ms since start), `type`, `user`
     and the type's fields: file, name, color, code, input, pos, del, text, anchor, head. */
  function encode(meta, events, opts) {
    const w = new Writer();
    const last = events.length ? events[events.length - 1].t : 0;
    const users = new Set(), files = new Set();
    for (const e of events) { users.add(e.user); if (e.type === T.ADD) files.add(e.file); }
    w.str(JSON.stringify(Object.assign({ app: 'cpp.wasm', v: VERSION, tick: TICK_MS }, meta, {
      duration: last, users: users.size, files: files.size, events: events.length,
    })));
    let prev = 0;
    const ctx = new Context();
    for (const e of events) {
      const ticks = Math.max(prev, Math.round(e.t / TICK_MS));
      w.uint(ticks - prev);
      prev = ticks;
      w.uint(e.type | (e.user << 3));
      switch (e.type) {
        case T.USER: w.str(e.name); w.str(e.color); break;
        case T.ADD: w.uint(e.file); w.str(e.name); w.str(e.code); w.str(e.input); break;
        case T.RENAME: w.uint(e.file); w.str(e.name); break;
        case T.DELETE: w.uint(e.file); break;
        case T.EDIT: case T.INPUT:
          w.uint(e.file); w.sint(e.pos - ctx.expected(e)); w.uint(e.del); w.str(e.text);
          ctx.edited(e);
          break;
        case T.CURSOR: w.uint(e.file); w.sint(e.anchor - ctx.lastAt(e.user)); w.sint(e.head - e.anchor); ctx.moved(e); break;
        case T.LEAVE: break;
        default: throw new Error('Unknown event type ' + e.type);
      }
    }
    const payload = w.bytes();
    const compress = !(opts && opts.raw) && window.fflate;
    const body = compress ? window.fflate.deflateSync(payload, { level: 9, mem: 12 }) : payload;
    const out = new Uint8Array(8 + body.length);
    out.set(MAGIC, 0);
    out[6] = VERSION;
    out[7] = compress ? 1 : 0;
    out.set(body, 8);
    return out;
  }

  function decode(bytes) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    if (bytes.length < 8 || MAGIC.some((b, i) => bytes[i] !== b)) throw new Error('This isn’t a cpp.wasm recording (.cpprec) file.');
    if (bytes[6] !== VERSION) throw new Error('This recording uses format version ' + bytes[6] + ', which this version of cpp.wasm can’t play.');
    let payload = bytes.subarray(8);
    if (bytes[7] & 1) {
      if (!window.fflate) throw new Error('Zip support didn’t load, so the recording can’t be opened.');
      try { payload = window.fflate.inflateSync(payload); } catch (e) { throw new Error('The recording is damaged.'); }
    }
    const r = new Reader(payload);
    let meta;
    try { meta = JSON.parse(r.str()); } catch (e) { throw new Error('The recording is damaged.'); }
    const events = [];
    let ticks = 0;
    const ctx = new Context();
    while (!r.done) {
      ticks += r.uint();
      const kind = r.uint();
      const e = { t: ticks * TICK_MS, type: kind & 7, user: Math.floor(kind / 8) };
      switch (e.type) {
        case T.USER: e.name = r.str(); e.color = r.str(); break;
        case T.ADD: e.file = r.uint(); e.name = r.str(); e.code = r.str(); e.input = r.str(); break;
        case T.RENAME: e.file = r.uint(); e.name = r.str(); break;
        case T.DELETE: e.file = r.uint(); break;
        case T.EDIT: case T.INPUT:
          e.file = r.uint(); e.pos = ctx.expected(e) + r.sint(); e.del = r.uint(); e.text = r.str();
          ctx.edited(e);
          break;
        case T.CURSOR: e.file = r.uint(); e.anchor = ctx.lastAt(e.user) + r.sint(); e.head = e.anchor + r.sint(); ctx.moved(e); break;
        case T.LEAVE: break;
      }
      events.push(e);
    }
    return { meta, events };
  }

  // Apply one EDIT/INPUT to a string, clamping bad positions instead of failing.
  function splice(s, pos, del, text) {
    pos = Math.min(Math.max(0, pos), s.length);
    return s.slice(0, pos) + text + s.slice(Math.min(s.length, pos + del));
  }

  window.CppRec = { T, TICK_MS, VERSION, encode, decode, splice };
})();
