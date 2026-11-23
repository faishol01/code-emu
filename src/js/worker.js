/* worker.js: Clang WebAssembly compilation and execution worker.
   Uses @live-codes/clang-wasm@0.3.0 toolchain loaded directly from CDN. */
'use strict';

const CDN_BASE = 'https://cdn.jsdelivr.net/npm/@live-codes/clang-wasm@0.3.0/';
const TOOLCHAIN_SCRIPT = 'https://cdn.jsdelivr.net/npm/@live-codes/clang-wasm@0.3.0/dist/clang-wasm-toolchain.global.js';

let toolchainPromise = null;
let toolchainInstance = null;
let outBudget = 0;
const OUT_LIMIT = 1 << 20; // 1 MB limit for program output

const post = (m) => self.postMessage(m);

/* <bits/stdc++.h> is a GCC header that libc++ doesn't ship. Its #include line is
   swapped for the equivalent list of standard headers, followed by a #line
   directive so diagnostics still point at the user's own line numbers. */
const STDCPP_HEADERS = [
  'cassert', 'cctype', 'cerrno', 'cfenv', 'cfloat', 'cinttypes', 'climits', 'clocale',
  'cmath', 'cstdarg', 'cstddef', 'cstdint', 'cstdio', 'cstdlib', 'cstring', 'ctime',
  'cwchar', 'cwctype',
  'algorithm', 'array', 'bitset', 'chrono', 'codecvt', 'complex', 'deque', 'exception',
  'fstream', 'functional', 'initializer_list', 'iomanip', 'ios', 'iosfwd', 'iostream',
  'istream', 'iterator', 'limits', 'list', 'locale', 'map', 'memory', 'new', 'numeric',
  'ostream', 'queue', 'random', 'ratio', 'regex', 'scoped_allocator', 'set', 'sstream',
  'stack', 'stdexcept', 'streambuf', 'string', 'system_error', 'tuple', 'type_traits',
  'typeindex', 'typeinfo', 'unordered_map', 'unordered_set', 'utility', 'valarray', 'vector',
];
const STDCPP_LATER = ['any', 'charconv', 'optional', 'string_view', 'variant'];
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
      lines[i] = STDCPP_BLOCK + '\n#line ' + (i + 2);
      changed = true;
    }
  }
  return changed ? lines.join('\n') : code;
}

const PRELUDE =
  '#include <stdio.h>\n' +
  'extern "C" __attribute__((used, visibility("default"))) void __cppwasm_flush(void) { fflush(stdout); fflush(stderr); }\n' +
  '#line 1 "__FILE__"\n';

function cleanCompilerOutput(raw) {
  if (!raw) return '';
  const stripped = raw.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
  const lines = stripped.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const meaningful = lines.filter((l) =>
    !l.startsWith('>') &&
    !l.startsWith('Compiling ') &&
    !l.startsWith('Error: process exited with code')
  );
  if (meaningful.length === 0) return '';
  return raw
    .replace(/(?:\u001b\[[0-9;]*[A-Za-z])?>\s*(?:\u001b\[[0-9;]*[A-Za-z])?(?:clang|wasm-ld|Compiling)[^\r\n]*\r?\n?/g, '')
    .trim();
}

function emitProgram(fd, text) {
  if (!text) return;
  if (outBudget >= OUT_LIMIT) return;
  outBudget += text.length;
  post({ type: 'out', channel: 'program', fd, text });
  if (outBudget >= OUT_LIMIT) {
    post({ type: 'out', channel: 'sys', fd: 1, text: 'Output passed 1 MB; the rest is hidden.' });
  }
}

function makeRefill(sab) {
  const ctrl = new Int32Array(sab, 0, 2);
  const data = new Uint8Array(sab, 8);
  let eof = false;
  return function refill() {
    if (eof) return null;
    Atomics.store(ctrl, 0, 0);
    post({ type: 'stdin-request' });
    Atomics.wait(ctrl, 0, 0);
    const len = Atomics.load(ctrl, 1);
    if (len < 0) {
      eof = true;
      return null;
    }
    return data.slice(0, len);
  };
}

async function initToolchain(base) {
  if (toolchainInstance) return toolchainInstance;
  const t0 = performance.now();

  const getToolchainFactory = () =>
    self.clangWasmToolchain || (typeof clangWasmToolchain !== 'undefined' ? clangWasmToolchain : null);

  if (!getToolchainFactory()) {
    try {
      importScripts(TOOLCHAIN_SCRIPT);
    } catch (e) {
      throw new Error('Failed to load clang-wasm-toolchain from CDN: ' + (e.message || String(e)));
    }
  }

  const factory = getToolchainFactory();
  if (!factory || typeof factory.createToolchain !== 'function') {
    throw new Error('clangWasmToolchain is not available after loading ' + TOOLCHAIN_SCRIPT);
  }

  let assetBase = base || CDN_BASE;
  if (!assetBase.endsWith('/')) assetBase += '/';
  if (!assetBase.includes('/assets/')) {
    assetBase = new URL('assets/', assetBase).href;
  }

  toolchainInstance = await factory.createToolchain({
    baseUrl: assetBase,
  });

  post({ type: 'ready', ms: performance.now() - t0 });
  return toolchainInstance;
}

function parseCppVersion(stdFlag) {
  if (!stdFlag) return 'gnu++17';
  const match = stdFlag.match(/(?:c\+\+|gnu\+\+)(\d{2})/);
  if (match) {
    const yr = match[1];
    if (yr === '20') return 'gnu++20';
    if (yr === '17') return 'gnu++17';
    if (yr === '14') return 'gnu++14';
    if (yr === '11') return 'gnu++11';
    if (yr === '23' || yr === '2b') return 'gnu++23';
  }
  return 'gnu++17';
}

async function build(msg) {
  let stage = 'toolchain';
  const times = {};
  outBudget = 0;

  try {
    const toolchain = await toolchainPromise;
    stage = 'compile';
    post({ type: 'stage', stage });

    const fileName = /^[A-Za-z0-9_.+-]{1,64}$/.test(msg.filename || '') ? msg.filename : 'main.cpp';
    const sourceCode = PRELUDE.replace('__FILE__', fileName) + expandStdcpp(msg.code);
    const optFlag = msg.opt || '-O2';
    const cppVersion = parseCppVersion(msg.std);
    const compileArgs = [optFlag, '-Wall'];

    if (msg.compileOnly) {
      let t0 = performance.now();
      const output = await toolchain.captureCompilerOutput(async () => {
        return await toolchain.runtime.compile({
          input: fileName,
          code: sourceCode,
          obj: 'main.o',
          language: 'CPP',
          cppVersion,
          compileArgs,
        });
      });
      times.compile = performance.now() - t0;
      post({ type: 'time', stage: 'compile', ms: times.compile });

      const cleaned = cleanCompilerOutput(output.raw);
      if (cleaned) {
        post({ type: 'out', channel: 'compiler', fd: 2, text: cleaned + '\n' });
      }

      if (output.error) {
        return post({ type: 'done', ok: false, stage: 'compile', reason: 'compile' });
      }

      return post({ type: 'done', ok: true, stage: 'compile', compileOnly: true });
    }

    // Normal compilation and linking
    let t0 = performance.now();
    const buildOutput = await toolchain.captureCompilerOutput(async () => {
      return await toolchain.runtime.compileArtifact(sourceCode, {
        fileName,
        language: 'CPP',
        cppVersion,
        compileArgs,
      });
    });

    times.compile = performance.now() - t0;
    post({ type: 'time', stage: 'compile', ms: times.compile });

    const cleaned = cleanCompilerOutput(buildOutput.raw);
    if (cleaned) {
      post({ type: 'out', channel: 'compiler', fd: 2, text: cleaned + '\n' });
    }

    if (buildOutput.error || !buildOutput.result) {
      const isLinkError = buildOutput.raw.includes('wasm-ld:') || buildOutput.raw.includes('lld:');
      const failStage = isLinkError ? 'link' : 'compile';
      return post({ type: 'done', ok: false, stage: failStage, reason: failStage });
    }

    const artifact = buildOutput.result;
    stage = 'link';
    post({ type: 'stage', stage });
    post({ type: 'time', stage: 'link', ms: 10 });

    stage = 'run';
    post({ type: 'stage', stage });

    let stdinHandler;
    if (msg.sab) {
      const refill = makeRefill(msg.sab);
      stdinHandler = () => refill();
    } else {
      let stdinGiven = msg.stdin || '';
      let readDone = false;
      stdinHandler = () => {
        if (readDone) return null;
        readDone = true;
        return stdinGiven;
      };
    }

    const tRun = performance.now();
    let res;
    try {
      res = await toolchain.execute(artifact, {
        stdin: stdinHandler,
        stdout: (text) => emitProgram(1, text),
        stderr: (text) => emitProgram(2, text),
      });
    } finally {
      times.run = performance.now() - tRun;
      post({ type: 'time', stage: 'run', ms: times.run });
    }

    const exitCode = typeof res.exitCode === 'number' ? res.exitCode : 0;
    post({ type: 'done', ok: true, stage: 'run', exitCode });
  } catch (e) {
    const trap = e instanceof WebAssembly.RuntimeError;
    post({
      type: 'done',
      ok: false,
      stage,
      reason: trap ? 'trap' : 'error',
      message: e && e.message ? e.message : String(e),
    });
  }
}

self.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    toolchainPromise = initToolchain(msg.base);
    toolchainPromise.catch((e) => post({ type: 'fatal', message: e && e.message ? e.message : String(e) }));
  } else if (msg.type === 'run') {
    build(msg);
  }
};
