/* cpp.wasm worker: downloads the toolchain, compiles, links and runs.
   The WASI host and memfs glue are adapted from binji/wasm-clang
   (Apache License 2.0, Copyright 2020 WebAssembly Community Group participants). */
'use strict';

let BASE = '';
const cache = {};          // name -> WebAssembly.Module | ArrayBuffer
let memfs = null;
let ready = null;
let channel = 'compiler';  // whose output host_write is carrying
let outBudget = 0;
const OUT_LIMIT = 1 << 20; // stop forwarding after 1 MB of program output
const enc = new TextEncoder();
let decoders = {};
let currentExports = null;

const post = (m) => self.postMessage(m);

/* <bits/stdc++.h> is a GCC header that libc++ doesn't ship. Its #include line is
   swapped for the equivalent list of standard headers, followed by a #line
   directive so diagnostics still point at the user's own line numbers.
   Left out: <thread>, <mutex>, <future>, <atomic>, <condition_variable>,
   <shared_mutex> (this libc++ is single-threaded) and <csignal>, <csetjmp>
   (WASI has no signals or setjmp). */
const STDCPP_HEADERS = [
  // C library
  'cassert', 'cctype', 'cerrno', 'cfenv', 'cfloat', 'cinttypes', 'climits', 'clocale',
  'cmath', 'cstdarg', 'cstddef', 'cstdint', 'cstdio', 'cstdlib', 'cstring', 'ctime',
  'cwchar', 'cwctype',
  // C++ library
  'algorithm', 'array', 'bitset', 'chrono', 'codecvt', 'complex', 'deque', 'exception',
  'fstream', 'functional', 'initializer_list', 'iomanip', 'ios', 'iosfwd', 'iostream',
  'istream', 'iterator', 'limits', 'list', 'locale', 'map', 'memory', 'new', 'numeric',
  'ostream', 'queue', 'random', 'ratio', 'regex', 'scoped_allocator', 'set', 'sstream',
  'stack', 'stdexcept', 'streambuf', 'string', 'system_error', 'tuple', 'type_traits',
  'typeindex', 'typeinfo', 'unordered_map', 'unordered_set', 'utility', 'valarray', 'vector',
];
const STDCPP_LATER = ['any', 'charconv', 'optional', 'string_view', 'variant'];  // C++17
const STDCPP_BLOCK = [
  ...STDCPP_HEADERS.map((h) => '#include <' + h + '>'),
  '#if __cplusplus >= 201703L',
  ...STDCPP_LATER.map((h) => '#if __has_include(<' + h + '>)\n#include <' + h + '>\n#endif'),
  '#endif',
].join('\n');
const STDCPP_RE = /^\s*#\s*include\s*[<"]bits\/stdc\+\+\.h[>"]/;

function expandStdcpp(code) {
  const lines = code.split('\n');
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    if (STDCPP_RE.test(lines[i])) {
      lines[i] = STDCPP_BLOCK + '\n#line ' + (i + 2);   // next source line keeps its number
      changed = true;
    }
  }
  return changed ? lines.join('\n') : code;
}

/* Prepended to every program: a helper the runtime calls to flush stdout before
   it waits for typed input, so prompts without a newline still show up. */
const PRELUDE =
  '#include <stdio.h>\n' +
  'extern "C" __attribute__((used, visibility("default"))) void __cppwasm_flush(void) { fflush(stdout); fflush(stderr); }\n' +
  '#line 1 "__FILE__"\n';

const CLANG_COMMON = [
  '-disable-free',
  '-isysroot', '/',
  '-internal-isystem', '/include/c++/v1',
  '-internal-isystem', '/include',
  '-internal-isystem', '/lib/clang/8.0.1/include',
  '-ferror-limit', '19',
  '-fmessage-length', '80',
  '-fcolor-diagnostics',
];

class ProcExit extends Error {
  constructor(code) { super('process exited with code ' + code); this.code = code; }
}

function readStr(u8, o, len) {
  let s = '';
  const end = len === undefined ? u8.length : o + len;
  for (let i = o; i < end && u8[i] !== 0; ++i) s += String.fromCharCode(u8[i]);
  return s;
}

class Memory {
  constructor(memory) { this.memory = memory; this.refresh(); }
  refresh() {
    this.buffer = this.memory.buffer;
    this.u8 = new Uint8Array(this.buffer);
    this.u32 = new Uint32Array(this.buffer);
  }
  check() { if (this.buffer.byteLength === 0 || this.buffer !== this.memory.buffer) this.refresh(); }
  read32(o) { return this.u32[o >> 2]; }
  write8(o, v) { this.u8[o] = v; }
  write32(o, v) { this.u32[o >> 2] = v; }
  write64(o, lo, hi = 0) { this.write32(o, lo); this.write32(o + 4, hi); }
  writeStr(o, str) { const n = this.write(o, enc.encode(str)); this.write8(o + n, 0); return n + 1; }
  write(o, buf) {
    if (buf instanceof ArrayBuffer) buf = new Uint8Array(buf);
    else if (typeof buf === 'string') buf = enc.encode(buf);
    new Uint8Array(this.buffer, o, buf.length).set(buf);
    return buf.length;
  }
}

function emit(fd, bytes) {
  if (channel === 'program') {
    if (outBudget >= OUT_LIMIT) return;
    outBudget += bytes.length;
  }
  const key = channel + fd;
  const dec = decoders[key] || (decoders[key] = new TextDecoder('utf-8'));
  const text = dec.decode(bytes, { stream: true });
  if (text) post({ type: 'out', channel, fd, text });
  if (channel === 'program' && outBudget >= OUT_LIMIT) post({ type: 'out', channel: 'sys', fd: 1, text: 'Output passed 1 MB; the rest is hidden.' });
}

class MemFS {
  constructor() {
    this.hostMem = null;
    this.stdin = new Uint8Array(0);
    this.stdinPos = 0;
  }
  async init(module) {
    const env = {};
    for (const n of ['abort', 'host_write', 'host_read', 'memfs_log', 'copy_in', 'copy_out']) env[n] = this[n].bind(this);
    const instance = await WebAssembly.instantiate(module, { env });
    this.exports = instance.exports;
    this.mem = new Memory(this.exports.memory);
    this.exports.init();
  }
  setStdin(bytes, refill) { this.stdin = bytes; this.stdinPos = 0; this.refill = refill || null; }
  addDirectory(path) {
    this.mem.check();
    this.mem.write(this.exports.GetPathBuf(), path);
    this.exports.AddDirectoryNode(path.length);
  }
  addFile(path, contents) {
    const length = contents instanceof ArrayBuffer ? contents.byteLength : contents.length;
    this.mem.check();
    this.mem.write(this.exports.GetPathBuf(), path);
    const inode = this.exports.AddFileNode(path.length, length);
    const addr = this.exports.GetFileNodeAddress(inode);
    this.mem.check();
    this.mem.write(addr, contents);
  }
  getFileContents(path) {
    this.mem.check();
    this.mem.write(this.exports.GetPathBuf(), path);
    const inode = this.exports.FindNode(path.length);
    const addr = this.exports.GetFileNodeAddress(inode);
    const size = this.exports.GetFileNodeSize(inode);
    return new Uint8Array(this.mem.buffer, addr, size).slice();
  }
  abort() { throw new Error('memfs abort'); }
  host_write(fd, iovs, iovs_len, nwritten_out) {
    const m = this.hostMem; m.check();
    let size = 0;
    for (let i = 0; i < iovs_len; ++i) {
      const buf = m.read32(iovs), len = m.read32(iovs + 4);
      iovs += 8;
      if (len) emit(fd, m.u8.slice(buf, buf + len));
      size += len;
    }
    m.write32(nwritten_out, size);
    return 0;
  }
  host_read(fd, iovs, iovs_len, nread) {
    // Interactive mode: when the buffer is used up, block until the page sends more.
    if (this.stdinPos >= this.stdin.length && this.refill) this.refill();
    const m = this.hostMem; m.check();
    let size = 0;
    for (let i = 0; i < iovs_len; ++i) {
      const buf = m.read32(iovs), len = m.read32(iovs + 4);
      iovs += 8;
      if (len === 0) continue;   // libc often passes an empty first buffer
      const n = Math.min(len, this.stdin.length - this.stdinPos);
      if (n <= 0) break;         // input used up: report what we have (0 means EOF)
      m.write(buf, this.stdin.subarray(this.stdinPos, this.stdinPos + n));
      this.stdinPos += n; size += n;
      if (n !== len) break;
    }
    m.write32(nread, size);
    return 0;
  }
  memfs_log(buf, len) { this.mem.check(); console.log(readStr(this.mem.u8, buf, len)); }
  copy_out(dst, src, size) {
    this.hostMem.check(); this.mem.check();
    new Uint8Array(this.hostMem.buffer, dst, size).set(new Uint8Array(this.mem.buffer, src, size));
  }
  copy_in(dst, src, size) {
    this.mem.check(); this.hostMem.check();
    new Uint8Array(this.mem.buffer, dst, size).set(new Uint8Array(this.hostMem.buffer, src, size));
  }
}

class App {
  constructor(module, args) {
    this.module = module;
    this.argv = args;
    this.environ = { USER: 'web', HOME: '/', PWD: '/' };
  }
  async start() {
    const names = ['proc_exit', 'environ_sizes_get', 'environ_get', 'args_sizes_get', 'args_get',
                   'random_get', 'clock_time_get', 'clock_res_get', 'poll_oneoff', 'sched_yield'];
    const base = {};
    for (const n of names) base[n] = this[n].bind(this);
    Object.assign(base, memfs.exports);
    // Serve stdin (fd 0) straight from the Input pane's bytes. The hosted memfs
    // build has no stdin support of its own, so reads must not reach it.
    const memfsRead = memfs.exports.fd_read;
    base.fd_read = (fd, iovs, iovs_len, nread) =>
      fd === 0 ? memfs.host_read(fd, iovs, iovs_len, nread) : memfsRead(fd, iovs, iovs_len, nread);
    // Anything else the program imports gets a stub returning ENOSYS instead of failing to load.
    const wasi = new Proxy(base, { get: (t, p) => (p in t ? t[p] : () => 52) });
    const instance = await WebAssembly.instantiate(this.module, { wasi_unstable: wasi, env: {} });
    this.exports = instance.exports;
    this.mem = new Memory(this.exports.memory);
    memfs.hostMem = this.mem;
    currentExports = this.exports;
    try {
      this.exports._start();
      return 0;
    } catch (e) {
      if (e instanceof ProcExit) return e.code;
      throw e;
    }
  }
  proc_exit(code) { throw new ProcExit(code); }
  environ_sizes_get(count_out, size_out) {
    this.mem.check();
    const entries = Object.entries(this.environ);
    let size = 0;
    for (const [k, v] of entries) size += enc.encode(k + '=' + v).length + 1;
    this.mem.write32(count_out, entries.length);
    this.mem.write32(size_out, size);
    return 0;
  }
  environ_get(ptrs, buf) {
    this.mem.check();
    for (const [k, v] of Object.entries(this.environ)) {
      this.mem.write32(ptrs, buf); ptrs += 4;
      buf += this.mem.writeStr(buf, k + '=' + v);
    }
    return 0;
  }
  args_sizes_get(argc_out, size_out) {
    this.mem.check();
    let size = 0;
    for (const a of this.argv) size += enc.encode(a).length + 1;
    this.mem.write32(argc_out, this.argv.length);
    this.mem.write32(size_out, size);
    return 0;
  }
  args_get(ptrs, buf) {
    this.mem.check();
    for (const a of this.argv) {
      this.mem.write32(ptrs, buf); ptrs += 4;
      buf += this.mem.writeStr(buf, a);
    }
    return 0;
  }
  random_get(buf, len) {
    this.mem.check();
    const view = new Uint8Array(this.mem.buffer, buf, len);
    for (let o = 0; o < len; o += 65536) crypto.getRandomValues(view.subarray(o, Math.min(len, o + 65536)));
    return 0;
  }
  clock_time_get(id, _precision, out) {
    this.mem.check();
    const ms = id === 0 ? Date.now() : performance.timeOrigin + performance.now();
    const ns = BigInt(Math.round(ms * 1e6));
    this.mem.write64(out, Number(ns & 0xffffffffn), Number(ns >> 32n));
    return 0;
  }
  clock_res_get(_id, out) { this.mem.check(); this.mem.write64(out, 1000, 0); return 0; }
  poll_oneoff() { return 52; }
  sched_yield() { return 0; }
}

class Tar {
  constructor(buffer) { this.u8 = new Uint8Array(buffer); this.offset = 0; }
  str(len) { const s = readStr(this.u8, this.offset, len); this.offset += len; return s; }
  oct(len) { return parseInt(this.str(len), 8); }
  align() { this.offset = (this.offset + 511) & ~511; }
  entry() {
    if (this.offset + 512 > this.u8.length) return null;
    const e = { filename: this.str(100) };
    this.str(24); // mode, owner, group
    e.size = this.oct(12);
    this.str(20); // mtime, checksum
    e.type = this.str(1);
    this.str(100); // linkname
    if (this.str(8) !== 'ustar  ') return null;
    this.str(32 + 32 + 8 + 8 + 155);
    this.align();
    if (e.type === '0') {
      e.contents = this.u8.subarray(this.offset, this.offset + e.size);
      this.offset += e.size;
      this.align();
    }
    return e;
  }
  untar(fs) {
    let e;
    while ((e = this.entry())) {
      if (e.type === '0') fs.addFile(e.filename, e.contents);
      else if (e.type === '5') fs.addDirectory(e.filename);
    }
  }
}

async function download(name) {
  const url = BASE + name;
  let res;
  try { res = await fetch(url); }
  catch (e) { throw new Error('Could not download ' + url + '. Check your connection, or set a different toolchain source.'); }
  if (!res.ok) throw new Error('Downloading ' + url + ' failed (HTTP ' + res.status + ').');
  if (!res.body || !res.body.getReader) return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0, last = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    const now = performance.now();
    if (now - last > 120) { last = now; post({ type: 'progress', name, loaded }); }
  }
  post({ type: 'progress', name, loaded, done: true });
  const out = new Uint8Array(loaded);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out.buffer;
}

function share(name, value) {
  try { post({ type: 'cache', name, value }); } catch (e) { /* not cloneable here; fine */ }
}

async function getModule(name) {
  if (cache[name]) return cache[name];
  const mod = await WebAssembly.compile(await download(name));
  cache[name] = mod;
  share(name, mod);
  return mod;
}

async function getBuffer(name) {
  if (cache[name]) return cache[name];
  const buf = await download(name);
  cache[name] = buf;
  share(name, buf);
  return buf;
}

async function setup() {
  const t0 = performance.now();
  const [memfsMod, sysroot] = await Promise.all([getModule('memfs'), getBuffer('sysroot.tar'),
                                                 getModule('clang'), getModule('lld')]);
  memfs = new MemFS();
  await memfs.init(memfsMod);
  new Tar(sysroot).untar(memfs);
  post({ type: 'ready', ms: performance.now() - t0 });
}

async function runTool(module, args) {
  return new App(module, args).start();
}

function flushDecoders() {
  for (const key of Object.keys(decoders)) {
    const rest = decoders[key].decode();
    if (rest) post({ type: 'out', channel: key.slice(0, -1), fd: +key.slice(-1), text: rest });
  }
  decoders = {};
}

/* Interactive stdin. The page and this worker share a small buffer:
   ctrl[0] is 0 while waiting and 1 once the page has answered, ctrl[1] is the
   byte count (or -1 for end of input), and the bytes follow. */
function makeRefill(sab) {
  const ctrl = new Int32Array(sab, 0, 2);
  const data = new Uint8Array(sab, 8);
  let eof = false;
  return function refill() {
    if (eof) return;
    const flush = currentExports && currentExports.__cppwasm_flush;
    if (flush) { try { flush(); } catch (e) { /* ignore */ } }
    Atomics.store(ctrl, 0, 0);
    post({ type: 'stdin-request' });
    Atomics.wait(ctrl, 0, 0);
    const len = Atomics.load(ctrl, 1);
    if (len < 0) { eof = true; return; }
    memfs.setStdin(data.slice(0, len), refill);
  };
}

async function build(msg) {
  let stage = 'toolchain';
  const times = {};
  try {
    await ready;
    stage = 'compile';
    post({ type: 'stage', stage });
    channel = 'compiler';
    outBudget = 0;
    // Diagnostics name the user's file; only safe names reach here (see app.js).
    const name = /^[A-Za-z0-9_.+-]{1,64}$/.test(msg.filename || '') ? msg.filename : 'main.cpp';
    memfs.addFile('main.cpp', enc.encode(PRELUDE.replace('__FILE__', name) + expandStdcpp(msg.code)));
    memfs.setStdin(new Uint8Array(0));

    let t = performance.now();
    const optFlag = msg.opt || '-O2';
    const cc = await runTool(cache.clang, ['clang', '-cc1', '-emit-obj', ...CLANG_COMMON,
      '-std=c++14', optFlag, '-Wall', '-o', 'main.o', '-x', 'c++', 'main.cpp']);
    flushDecoders();
    times.compile = performance.now() - t;
    post({ type: 'time', stage, ms: times.compile });
    if (cc !== 0) return post({ type: 'done', ok: false, stage, reason: 'compile' });

    if (msg.compileOnly) {
      return post({ type: 'done', ok: true, stage: 'compile', compileOnly: true });
    }

    stage = 'link';
    post({ type: 'stage', stage });
    t = performance.now();
    const lib = 'lib/wasm32-wasi';
    const ld = await runTool(cache.lld, ['wasm-ld', '--no-threads', '--export-dynamic',
      '-z', 'stack-size=' + (1024 * 1024), '-L' + lib, lib + '/crt1.o', 'main.o',
      '-lc', '-lc++', '-lc++abi', '-lcanvas', '-o', 'main.wasm']);
    flushDecoders();
    times.link = performance.now() - t;
    post({ type: 'time', stage, ms: times.link });
    if (ld !== 0) return post({ type: 'done', ok: false, stage, reason: 'link' });

    stage = 'run';
    post({ type: 'stage', stage });
    const program = await WebAssembly.compile(memfs.getFileContents('main.wasm'));
    if (msg.sab) memfs.setStdin(new Uint8Array(0), makeRefill(msg.sab));
    else memfs.setStdin(enc.encode(msg.stdin || ''));
    channel = 'program';
    t = performance.now();
    let exitCode;
    try {
      exitCode = await runTool(program, ['main']);
    } finally {
      flushDecoders();
      times.run = performance.now() - t;
      post({ type: 'time', stage, ms: times.run });
    }
    post({ type: 'done', ok: true, stage, exitCode });
  } catch (e) {
    flushDecoders();
    const trap = e instanceof WebAssembly.RuntimeError;
    post({ type: 'done', ok: false, stage, reason: trap ? 'trap' : 'error', message: e && e.message ? e.message : String(e) });
  }
}

self.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    BASE = msg.base;
    Object.assign(cache, msg.cache || {});
    ready = setup();
    ready.catch((e) => post({ type: 'fatal', message: e && e.message ? e.message : String(e) }));
  } else if (msg.type === 'run') {
    build(msg);
  }
};
