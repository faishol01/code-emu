/* cpp.wasm page script: editor, terminal, formatter and worker orchestration. */
(function () {
'use strict';

// worker.js sits next to this script.
const WORKER_URL = new URL('worker.js?v=1.3', document.currentScript.src).href;

// The toolchain files can be loaded from the @live-codes/clang-wasm package on CDN
// or from the local copy in src/vendors/wasm-clang/.
const DEFAULT_BASE = 'https://cdn.jsdelivr.net/npm/@live-codes/clang-wasm@0.3.0/';
const OLD_DEFAULT_BASES = ['https://binji.github.io/wasm-clang/', '/wasm-clang/', '/src/wasm-clang/', 'src/vendors/wasm-clang/', '/src/vendors/wasm-clang/'];
// Resolve here so the worker gets a full URL (it would resolve relative paths against src/js/).
const resolveBase = (b) => new URL(b, location.href).href;
const $ = (s) => document.querySelector(s);

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
};

/* ---------------- editor ---------------- */
const fallback = $('#fallback-editor');
let cm = null;
const STARTER = `#include <iostream>
#include <string>
using namespace std;

int main() {
    string name;
    cout << "What's your name? ";
    getline(cin, name);
    cout << "Hello, " << name << "!\\n";
}
`;
const NEW_FILE_TEMPLATE = '#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    \n}\n';

if (window.CppEditor) {
  // CodeMirror 6 (through src/js/editor.js). The textarea is only the fallback.
  const wrap = $('#editor-wrap');
  fallback.remove();
  cm = CppEditor.create(wrap, {
    onRun: () => runOrStop(),
    onFormat: () => formatCode(),
    onChange(changes) {
      if (isVisualizing) return;
      if (room.active) return;   // rooms sync and record through the shared document (collab.js)
      // Recording (local workspace): each change is applied after the previous one.
      if (rec.active && shownId) for (const c of changes) rec.code(shownId, c.pos, c.del, c.text);
      const f = files.find((x) => x.id === shownId);
      if (f) { f.code = cm.getValue(); saveFiles(); }
    },
    onSelection(anchor, head) {
      if (rec.active && !room.active && shownId) rec.cursor(shownId, anchor, head);
    },
  });
} else {
  fallback.addEventListener('input', () => { activeFile().code = fallback.value; saveFiles(); });
  fallback.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = fallback.selectionStart;
      fallback.setRangeText('    ', s, fallback.selectionEnd, 'end');
      activeFile().code = fallback.value;
      saveFiles();
    }
  });
}
const getCode = () => (cm ? cm.getValue() : fallback.value);
const setCode = (v) => { if (cm) cm.replaceAll(v); else { fallback.value = v; activeFile().code = v; saveFiles(); } };

/* ---------------- files ----------------
   Each file is its own program: Run builds the file that is open. Files, with
   their own batch input, are kept in this browser's localStorage. */
const NAME_RE = /^[A-Za-z0-9_+-][A-Za-z0-9_.+-]{0,63}$/;
const EXT_RE = /\.(cpp|cc|cxx|c\+\+)$/i;
let files = [];
let activeId = null;
let workspaceActive = false;   // false until the visitor opens or creates a workspace
// While in a collaboration room, collab.js fills in room.ops and the files come from the room.
const room = { active: false, ops: null, route: null };
// Filled in by record.js. While recording, app.js reports local changes to it.
const rec = { active: false };
const views = {};   // extra views (recordings, player) registered by record.js
// Smallest single replacement that turns a into b (for the batch input box).
function diffStrings(a, b) {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  return { pos: s, del: ea - s, text: b.slice(s, eb) };
}
let lastEdited = 0;
// file id -> editor state, so each file keeps its own undo history. The state of the
// file on screen lives in the editor; it is put back here when you switch away.
const docs = new Map();
let shownId = null;   // the local file whose state is in the editor
function stashShown() { if (cm && shownId) docs.set(shownId, cm.state); }
const newId = () => 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const activeFile = () => files.find((f) => f.id === activeId);

(function loadFiles() {
  let data = null;
  try { data = JSON.parse(store.get('cppwasm.files', 'null')); } catch (e) {}
  if (data && Array.isArray(data.files)) {
    files = data.files.filter((f) => f && typeof f.id === 'string' && NAME_RE.test(f.name || ''))
      .map((f) => ({ id: f.id, name: f.name, code: String(f.code || ''), stdin: String(f.stdin || '') }));
    activeId = data.active;
    lastEdited = Number(data.updated) || 0;
  }
  if (files.length) workspaceActive = true;
  if (!files.length) {
    // First visit, or upgrading from the single-file version.
    const code = store.get('cppwasm.code', null);
    files = [{ id: newId(), name: 'main.cpp', code: code !== null ? code : STARTER, stdin: store.get('cppwasm.stdin', '') }];
    if (code !== null) workspaceActive = true;
  }
  if (!activeFile()) activeId = files[0].id;
})();

let saveTimer = 0;
function flushSave() {
  clearTimeout(saveTimer);
  if (!workspaceActive || room.active) return;
  lastEdited = Date.now();
  store.set('cppwasm.files', JSON.stringify({ active: activeId, updated: lastEdited, files }));
}
function saveFiles() { clearTimeout(saveTimer); if (workspaceActive && !room.active) saveTimer = setTimeout(flushSave, 300); }
window.addEventListener('pagehide', flushSave);

const fileList = $('#file-list');
const filesMsg = $('#files-msg');
let msgTimer = 0;
function filesMessage(text, ok) {
  filesMsg.textContent = text;
  filesMsg.className = 'files-msg' + (ok ? ' ok' : '');
  clearTimeout(msgTimer);
  if (text) msgTimer = setTimeout(() => { filesMsg.textContent = ''; }, 5000);
}

function openFile(id, focusEditor) {
  if (document.body.classList.contains('show-visualizer')) {
    closeVisualizer();
  }
  if (room.active) { room.ops.open(id, focusEditor); return; }
  const f = files.find((x) => x.id === id);
  if (!f) return;
  activeId = id;
  if (cm) {
    if (shownId !== id) {
      stashShown();
      cm.setState(docs.get(id) || cm.newState(f.code));
      shownId = id;
    }
    if (focusEditor) cm.focus();
  } else {
    fallback.value = f.code;
    if (focusEditor) fallback.focus();
  }
  $('#stdin').value = f.stdin;
  $('#file-title').textContent = f.name;
  renderFiles();
  saveFiles();
}

function checkName(raw, exceptId) {
  let name = raw.trim();
  if (!name) return { error: 'Enter a file name.' };
  if (!name.includes('.')) name += '.cpp';
  if (!NAME_RE.test(name)) return { error: 'Use letters, digits, and . _ - + only (up to 64 characters).' };
  if (!EXT_RE.test(name)) return { error: 'File names must end in .cpp, .cc, .cxx or .c++.' };
  if (files.some((f) => f.id !== exceptId && f.name.toLowerCase() === name.toLowerCase())) return { error: name + ' already exists.' };
  return { name };
}

function uniqueName(base) {
  return makeUnique(base + '.cpp', new Set(files.map((f) => f.name.toLowerCase())));
}
// "a.cpp" -> "a-2.cpp", "a-3.cpp", ... until the (lower-cased) name is free; records it as taken.
function makeUnique(name, taken) {
  const dot = name.lastIndexOf('.');
  const stem = name.slice(0, dot), ext = name.slice(dot);
  let out = name;
  for (let i = 2; taken.has(out.toLowerCase()); i++) out = stem + '-' + i + ext;
  taken.add(out.toLowerCase());
  return out;
}

const ICON_EDIT = '<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 2.5l2 2L5 11H3V9z"/></svg>';
const ICON_DELETE = '<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M3 4h8M5.5 4V2.5h3V4M4.5 4l.5 7.5h4l.5-7.5"/></svg>';

let lastFileClick = { id: null, t: 0 };
// An open rename box survives re-renders (in a room, other people's edits re-render the list).
let renaming = null;   // { id, value, sel: [start, end] | null, fresh }
let rerendering = false;
function renderFiles(startRenameId) {
  if (startRenameId) renaming = { id: startRenameId, value: null, sel: null, fresh: true };
  if (renaming && !files.some((f) => f.id === renaming.id)) renaming = null;
  const prev = fileList.querySelector('.rename-input');
  if (renaming && prev && document.activeElement === prev) renaming.sel = [prev.selectionStart, prev.selectionEnd];
  let renameInput = null;
  rerendering = true;
  fileList.textContent = '';
  rerendering = false;
  for (const f of files) {
    const li = document.createElement('li');
    li.className = 'file-item' + (f.id === activeId ? ' active' : '');
    if (renaming && f.id === renaming.id) {
      const input = document.createElement('input');
      input.className = 'rename-input';
      input.value = renaming.value !== null ? renaming.value : f.name;
      input.addEventListener('input', () => { if (renaming) renaming.value = input.value; });
      input.spellcheck = false;
      input.setAttribute('aria-label', 'File name');
      let done = false;
      const finish = (commit, fromBlur) => {
        if (done || (fromBlur && rerendering)) return;
        if (commit) {
          const r = checkName(input.value, f.id);
          if (r.error && !fromBlur) { filesMessage(r.error); input.focus(); return; }
          if (r.error) { done = true; renaming = null; renderFiles(); filesMessage(r.error + ' Kept ' + f.name + '.'); return; }
          if (room.active) room.ops.rename(f.id, r.name);
          else { if (rec.active && r.name !== f.name) rec.rename(f.id, r.name); f.name = r.name; saveFiles(); }
          if (f.id === activeId) $('#file-title').textContent = r.name;
        }
        done = true;
        renaming = null;
        filesMessage('');
        renderFiles();
        if (commit && cm && f.id === activeId) cm.focus();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
      input.addEventListener('blur', () => finish(true, true));
      li.appendChild(input);
      fileList.appendChild(li);
      renameInput = input;
      continue;
    }
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'open';
    open.textContent = f.name;
    open.title = f.name + ' (F2 to rename)';
    if (f.id === activeId) open.setAttribute('aria-current', 'true');
    // The list re-renders on open, so a double-click is detected by hand.
    open.addEventListener('click', () => {
      const now = Date.now();
      const twice = lastFileClick.id === f.id && now - lastFileClick.t < 450;
      lastFileClick = { id: f.id, t: now };
      if (twice) renderFiles(f.id);
      else if (f.id !== activeId) openFile(f.id, true);
      else if (cm) cm.focus();
    });
    open.addEventListener('keydown', (e) => { if (e.key === 'F2') { e.preventDefault(); renderFiles(f.id); } });

    const ren = document.createElement('button');
    ren.type = 'button';
    ren.className = 'act';
    ren.title = 'Rename ' + f.name;
    ren.setAttribute('aria-label', 'Rename ' + f.name);
    ren.innerHTML = ICON_EDIT;
    ren.addEventListener('click', () => renderFiles(f.id));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'act del';
    del.title = files.length > 1 ? 'Delete ' + f.name : 'Keep at least one file';
    del.setAttribute('aria-label', 'Delete ' + f.name);
    del.innerHTML = ICON_DELETE;
    del.disabled = files.length < 2;
    del.addEventListener('click', () => deleteFile(f.id));

    li.append(open);
    if (room.active) {
      const who = room.ops.viewers(f.id);
      if (who.length) {
        const dots = document.createElement('span');
        dots.className = 'viewers';
        dots.title = who.map((u) => u.name).join(', ') + ' here';
        for (const u of who.slice(0, 4)) {
          const d = document.createElement('span');
          d.className = 'dot';
          d.style.background = u.color;
          dots.appendChild(d);
        }
        li.appendChild(dots);
      }
    }
    li.append(ren, del);
    fileList.appendChild(li);
  }
  if (renameInput) {
    renameInput.focus();
    if (renaming.fresh || !renaming.sel) {
      const dot = renameInput.value.lastIndexOf('.');
      renameInput.setSelectionRange(0, dot > 0 ? dot : renameInput.value.length);
    } else {
      renameInput.setSelectionRange(renaming.sel[0], renaming.sel[1]);
    }
    renaming.fresh = false;
  }
}

function newFile() {
  let id;
  if (room.active) {
    [id] = room.ops.addFiles([{ name: uniqueName('untitled'), code: NEW_FILE_TEMPLATE, stdin: '' }]);
    files = files.concat([{ id, name: '', code: NEW_FILE_TEMPLATE, stdin: '' }]);   // refreshed from the room right after
  } else {
    id = newId();
    files.push({ id, name: uniqueName('untitled'), code: NEW_FILE_TEMPLATE, stdin: '' });
    if (rec.active) rec.add(files[files.length - 1]);
  }
  openFile(id);
  if (cm) cm.setCursor(NEW_FILE_TEMPLATE.indexOf('    \n') + 4);   // inside main()
  if (room.active) queueMicrotask(() => renderFiles(id));
  else renderFiles(id);   // start with the name ready to type over
}

function deleteFile(id) {
  const f = files.find((x) => x.id === id);
  if (!f || files.length < 2) return;
  if (!window.confirm('Delete ' + f.name + '?' + (room.active ? ' It will be deleted for everyone in the room.' : ' This can’t be undone.'))) return;
  if (room.active) { room.ops.remove(id); return; }
  if (rec.active) rec.remove(id);
  const i = files.indexOf(f);
  files.splice(i, 1);
  docs.delete(id);
  if (shownId === id) shownId = null;
  if (activeId === id) openFile(files[Math.min(i, files.length - 1)].id);
  else { renderFiles(); saveFiles(); }
}

$('#new-file').addEventListener('click', newFile);

/* ---------------- zip import / export ----------------
   Layout: every source file at the top level, plus input/<file name>.txt for
   files that have batch input. Import accepts C++ files from any folder. */
const ZIP_MAX_BYTES = 20 * 1024 * 1024;
const ZIP_MAX_FILES = 200;
const SOURCE_MAX_BYTES = 1024 * 1024;

function exportZip() {
  if (!window.fflate) { filesMessage('Zip support didn’t load.'); return; }
  const entries = {};
  for (const f of files) {
    entries[f.name] = fflate.strToU8(f.code);
    if (f.stdin) entries['input/' + f.name + '.txt'] = fflate.strToU8(f.stdin);
  }
  const data = fflate.zipSync(entries, { level: 6, mtime: new Date() });
  const url = URL.createObjectURL(new Blob([data], { type: 'application/zip' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'cpp-wasm-workspace-' + new Date().toISOString().slice(0, 10) + '.zip';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function decodeText(bytes) {
  return fflate.strFromU8(bytes).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

function safeName(base) {
  const dot = base.lastIndexOf('.');
  let stem = base.slice(0, dot).replace(/[^A-Za-z0-9_.+-]/g, '_').replace(/^[._]+/, '') || 'file';
  const ext = base.slice(dot).toLowerCase();
  stem = stem.slice(0, 64 - ext.length);
  return stem + ext;
}

// Reads a zip File into new file records. Names are made unique against `taken`.
async function readZip(file, taken) {
  if (!window.fflate) throw new Error('Zip support didn’t load.');
  if (file.size > ZIP_MAX_BYTES) throw new Error(file.name + ' is larger than 20 MB.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let tooBig = 0;
  let entries;
  try {
    entries = fflate.unzipSync(bytes, {
      filter: (info) => {
        if (info.name.endsWith('/')) return false;
        if (info.originalSize > SOURCE_MAX_BYTES * 2) { tooBig++; return false; }
        return true;
      },
    });
  } catch (e) {
    throw new Error(file.name + ' couldn’t be read as a zip file.');
  }
  const sources = [], inputs = new Map();
  let skipped = 0;
  for (const [path, data] of Object.entries(entries)) {
    const parts = path.split('/');
    if (parts.some((p) => p.startsWith('.') || p === '__MACOSX')) continue;
    const input = path.match(/(?:^|\/)input\/([^/]+)\.txt$/i);
    if (input) { inputs.set(input[1].toLowerCase(), decodeText(data)); continue; }
    const base = parts[parts.length - 1];
    if (!EXT_RE.test(base)) { skipped++; continue; }
    if (data.length > SOURCE_MAX_BYTES) { tooBig++; continue; }
    sources.push({ path, base, code: decodeText(data) });
  }
  if (!sources.length) throw new Error('No C++ files (.cpp, .cc, .cxx) were found in ' + file.name + '.');
  sources.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  const extra = Math.max(0, sources.length - ZIP_MAX_FILES);
  const result = sources.slice(0, ZIP_MAX_FILES).map((src) => ({
    id: newId(),
    name: makeUnique(safeName(src.base), taken),
    code: src.code,
    stdin: inputs.get(src.base.toLowerCase()) || '',
  }));
  const notes = [];
  if (skipped) notes.push(skipped + ' other file' + (skipped > 1 ? 's' : '') + ' skipped');
  if (tooBig) notes.push(tooBig + ' over 1 MB skipped');
  if (extra) notes.push(extra + ' over the ' + ZIP_MAX_FILES + '-file limit skipped');
  return { files: result, notes };
}

function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

// Adds a zip's files to the current workspace.
async function importIntoWorkspace(file) {
  try {
    const { files: added, notes } = await readZip(file, new Set(files.map((f) => f.name.toLowerCase())));
    if (room.active) {
      const ids = room.ops.addFiles(added);
      queueMicrotask(() => openFile(ids[0]));
    } else {
      files.push(...added);
      if (rec.active) added.forEach((f) => rec.add(f));
      openFile(added[0].id);
      flushSave();
    }
    filesMessage('Imported ' + plural(added.length, 'file') + (notes.length ? ' (' + notes.join(', ') + ')' : '') + '.', true);
  } catch (e) {
    filesMessage(e.message);
  }
}

// Replaces the whole workspace (used by the home page).
function startWorkspace(newFiles) {
  if (rec.active) rec.stop('workspace');
  files = newFiles;
  docs.clear();
  shownId = null;
  workspaceActive = true;
  openFile(files[0].id);
  flushSave();
  go('workspace');
}

const zipInput = $('#zip-input');
let zipTarget = 'workspace';
function chooseZip(target) { zipTarget = target; zipInput.value = ''; zipInput.click(); }
zipInput.addEventListener('change', () => {
  const file = zipInput.files[0];
  if (!file) return;
  if (zipTarget === 'home') importFromHome(file); else importIntoWorkspace(file);
});
$('#import-zip').addEventListener('click', () => chooseZip('workspace'));
$('#export-zip').addEventListener('click', exportZip);

function dropTarget(el, onFile) {
  const isFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  el.addEventListener('dragover', (e) => { if (!isFiles(e)) return; e.preventDefault(); el.classList.add('dragging'); });
  el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('dragging'); });
  el.addEventListener('drop', (e) => {
    if (!isFiles(e)) return;
    e.preventDefault();
    el.classList.remove('dragging');
    const file = e.dataTransfer.files[0];
    if (file) onFile(file);
  });
}
dropTarget($('#files'), importIntoWorkspace);
$('#stdin').addEventListener('input', (e) => {
  if (room.active) { room.ops.setStdin(activeId, e.target.value); return; }
  if (rec.active) { const d = diffStrings(activeFile().stdin, e.target.value); rec.input(activeId, d.pos, d.del, d.text); }
  activeFile().stdin = e.target.value;
  saveFiles();
});

// Show / hide the file list.
const toggleFiles = $('#toggle-files');
function setFilesHidden(hidden) {
  document.body.classList.toggle('files-hidden', hidden);
  toggleFiles.setAttribute('aria-expanded', String(!hidden));
  store.set('cppwasm.filesHidden', hidden ? '1' : '0');
  if (cm) cm.refresh();
}
toggleFiles.addEventListener('click', () => setFilesHidden(!document.body.classList.contains('files-hidden')));
setFilesHidden(store.get('cppwasm.filesHidden', window.matchMedia('(max-width: 820px)').matches ? '1' : '0') === '1');

openFile(activeId);

/* ---------------- format (clang-format, loaded on first use) ---------------- */
const FORMAT_STYLE = JSON.stringify({
  BasedOnStyle: 'LLVM',
  IndentWidth: 4,
  ColumnLimit: 100,
  AccessModifierOffset: -4,
});
// The formatter sits next to this page, in src/vendors/clang-format/.
const FORMATTER_DIR = 'src/vendors/clang-format/';
let formatterPromise = null;
let noteTimer = 0;
function note(text, bad) {
  const el = $('#format-note');
  el.textContent = text;
  el.className = 'notice' + (bad ? ' bad' : '');
  clearTimeout(noteTimer);
  if (text) noteTimer = setTimeout(() => { el.textContent = ''; }, bad ? 8000 : 2500);
}
function loadFormatter() {
  if (!formatterPromise) {
    const url = new URL(FORMATTER_DIR + 'clang-format-web.js', location.href).href;
    formatterPromise = import(url).then(async (mod) => { await mod.default(); return mod; });
    formatterPromise.catch(() => { formatterPromise = null; });
  }
  return formatterPromise;
}
async function formatCode() {
  const btn = $('#format');
  if (btn.disabled || !activeFile()) return;
  btn.disabled = true;
  if (!formatterPromise) note('Loading formatter…');
  try {
    const mod = await loadFormatter();
    const src = getCode();
    const result = mod.format(src, activeFile().name, FORMAT_STYLE);
    if (result === src) { note('Already formatted'); return; }
    if (cm) {
      cm.replaceAll(result);   // one undoable change; the cursor stays with its text
    } else {
      setCode(result);
    }
    note('Formatted');
  } catch (e) {
    let where = '';
    try { where = new URL(FORMATTER_DIR, location.href).href; } catch (_) {}
    note('Formatter not found at ' + (where || 'the toolchain folder'), true);
    console.error(e);
  } finally {
    btn.disabled = false;
  }
}
$('#format').addEventListener('click', formatCode);

/* ---------------- keyboard shortcuts list ---------------- */
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const SHORTCUTS = [
  ['Program', [['Mod+Enter', 'Run or stop'], ['Shift+Alt+F', 'Format code']]],
  ['Multiple cursors', [
    ['Mod+Click', 'Add a cursor'],
    ['Mod+Alt+↑ / ↓', 'Add a cursor above / below'],
    ['Mod+D', 'Select the next match of the selection'],
    ['Mod+Shift+L', 'Select all matches'],
    ['Alt+Drag', 'Column (box) selection'],
    ['Esc', 'Back to one cursor'],
  ]],
  ['Lines', [
    ['Alt+↑ / ↓', 'Move line up / down'],
    ['Shift+Alt+↑ / ↓', 'Copy line up / down'],
    ['Shift+Mod+K', 'Delete line'],
    [isMac ? 'Ctrl+L' : 'Alt+L', 'Select line'],
    ['Tab / Shift+Tab', 'Indent / outdent'],
    ['Mod+/', 'Toggle line comment'],
    [isMac ? 'Shift+Ctrl+A' : 'Shift+Alt+A', 'Toggle block comment'],
  ]],
  ['Find', [
    ['Mod+F', 'Find and replace'],
    ['Mod+G / F3', 'Next match (Shift for previous)'],
    ['Mod+Alt+G', 'Go to line'],
  ]],
  ['Code', [
    ['Mod+Space', 'Show completions'],
    ['Mod+I', 'Select the enclosing block'],
    ['Shift+Mod+\\', 'Jump to matching bracket'],
    [isMac ? 'Mod+Alt+[ / ]' : 'Ctrl+Shift+[ / ]', 'Fold / unfold block'],
    ['Mod+Z / Mod+Shift+Z', 'Undo / redo'],
  ]],
];
function renderShortcuts() {
  const box = $('#shortcuts');
  box.textContent = '';
  const mod = isMac ? '⌘' : 'Ctrl';
  for (const [group, rows] of SHORTCUTS) {
    const h = document.createElement('h4');
    h.textContent = group;
    const dl = document.createElement('dl');
    for (const [keys, what] of rows) {
      const dt = document.createElement('dt');
      for (const [i, part] of keys.replace(/Mod/g, mod).split(' / ').entries()) {
        if (i) dt.append(' / ');
        const k = document.createElement('kbd');
        k.textContent = part;
        dt.appendChild(k);
      }
      const dd = document.createElement('dd');
      dd.textContent = what;
      dl.append(dt, dd);
    }
    box.append(h, dl);
  }
}
const shortcutsBtn = $('#shortcuts-btn');
function toggleShortcuts(open) {
  const box = $('#shortcuts');
  if (open === undefined) open = box.hidden;
  if (open) renderShortcuts();
  box.hidden = !open;
  shortcutsBtn.setAttribute('aria-expanded', String(open));
}
shortcutsBtn.addEventListener('click', () => toggleShortcuts());
document.addEventListener('pointerdown', (e) => {
  if (!$('#shortcuts').hidden && !e.target.closest('.shortcuts-wrap')) toggleShortcuts(false);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#shortcuts').hidden) toggleShortcuts(false); });

/* ---------------- output ---------------- */
const out = $('#output');
const compOut = $('#compiler-output');
const tabProgram = $('#tab-program');
const tabCompiler = $('#tab-compiler');
const compilerBadge = $('#compiler-badge');
const OUT_CAP = 300000;
const COLORS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];

let activeOutTab = 'program';

function switchOutputTab(tab) {
  activeOutTab = tab;
  const isProg = tab === 'program';
  if (tabProgram) {
    tabProgram.classList.toggle('active', isProg);
    tabProgram.setAttribute('aria-selected', String(isProg));
  }
  if (tabCompiler) {
    tabCompiler.classList.toggle('active', !isProg);
    tabCompiler.setAttribute('aria-selected', String(!isProg));
  }

  if (out) out.hidden = !isProg;
  if (compOut) compOut.hidden = isProg;

  if (termRow) {
    termRow.style.display = (isProg && mode === 'interactive') ? 'flex' : 'none';
  }
}

if (tabProgram) tabProgram.addEventListener('click', () => switchOutputTab('program'));
if (tabCompiler) tabCompiler.addEventListener('click', () => switchOutputTab('compiler'));

function setCompilerBadge(type, text) {
  if (!compilerBadge) return;
  if (type === 'error') {
    compilerBadge.textContent = text || 'Error';
    compilerBadge.className = 'out-badge error';
    compilerBadge.hidden = false;
  } else if (type === 'warning') {
    if (compilerBadge.className.includes('error') && !compilerBadge.hidden) return;
    compilerBadge.textContent = text || 'Warning';
    compilerBadge.className = 'out-badge warning';
    compilerBadge.hidden = false;
  } else {
    compilerBadge.hidden = true;
  }
}

let scheduled = false;
function scheduleFlush() {
  if (!scheduled) {
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      progStream.flush();
      compStream.flush();
    });
  }
}

function createOutputStream(el, defaultEmptyHtml) {
  let chars = 0, capped = false;
  let queue = [];
  const ansi = { fg: null, bold: false, pending: '' };

  function clear() {
    el.innerHTML = defaultEmptyHtml;
    chars = 0; capped = false; queue = [];
    ansi.fg = null; ansi.bold = false; ansi.pending = '';
  }

  function span(text, cls) {
    if (!text || capped) return;
    if (chars + text.length > OUT_CAP) {
      text = text.slice(0, Math.max(0, OUT_CAP - chars));
      capped = true;
    }
    chars += text.length;
    const s = document.createElement('span');
    const classes = [cls];
    if (ansi.bold) classes.push('b');
    if (ansi.fg) classes.push('c-' + ansi.fg);
    s.className = classes.join(' ');
    s.textContent = text;
    el.appendChild(s);
    if (capped) {
      const note = document.createElement('span');
      note.className = 'o-sys';
      note.textContent = '\nDisplay limit reached; later output is not shown.\n';
      el.appendChild(note);
    }
  }

  function applySgr(codes) {
    const list = codes === '' ? [0] : codes.split(';').map(Number);
    for (const c of list) {
      if (c === 0) { ansi.fg = null; ansi.bold = false; }
      else if (c === 1) ansi.bold = true;
      else if (c === 22) ansi.bold = false;
      else if (c === 39) ansi.fg = null;
      else if (c >= 30 && c <= 37) ansi.fg = COLORS[c - 30];
      else if (c >= 90 && c <= 97) ansi.fg = COLORS[c - 90];
    }
  }

  function writeAnsi(text, cls) {
    text = ansi.pending + text;
    ansi.pending = '';
    const esc = text.lastIndexOf('\x1b');
    if (esc !== -1 && text.length - esc < 16 && !/^\x1b\[[0-9;]*m/.test(text.slice(esc))) {
      ansi.pending = text.slice(esc);
      text = text.slice(0, esc);
    }
    const re = /\x1b\[([0-9;]*)m/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      span(text.slice(last, m.index), cls);
      applySgr(m[1]);
      last = re.lastIndex;
    }
    span(text.slice(last), cls);
  }

  function flush() {
    const hint = el.querySelector('.empty');
    if (hint && queue.length) hint.remove();
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    for (const item of queue) {
      if (item.sys) {
        if (el.lastChild && !/\n$/.test(el.lastChild.textContent)) {
          el.appendChild(document.createTextNode('\n'));
        }
        const s = document.createElement('span');
        s.className = 'o-sys' + (item.tone ? ' ' + item.tone : '');
        s.textContent = item.text + '\n';
        el.appendChild(s);
      } else {
        writeAnsi(item.text, item.cls);
      }
    }
    queue = [];
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }

  return {
    write(text, cls) { queue.push({ text, cls }); scheduleFlush(); },
    sys(text, tone) { queue.push({ sys: true, text, tone }); scheduleFlush(); },
    clear,
    flush,
    hasContent() { return chars > 0 || queue.length > 0; }
  };
}

const progStream = createOutputStream(out, '<span class="empty">Press Run or Ctrl+Enter. The first run waits for the compiler download (a few dozen MB). After that, builds take a second or two.</span>');
const compStream = createOutputStream(compOut, '<span class="empty">No compiler output. Build errors and warnings will appear here.</span>');

function clearOutput() { progStream.clear(); }
function clearCompilerOutput() { compStream.clear(); setCompilerBadge(null); }
function sys(text, tone) { progStream.sys(text, tone); }
function write(text, cls) { progStream.write(text, cls); }
function sysCompiler(text, tone) { compStream.sys(text, tone); }
function writeCompiler(text, cls = 'o-cc') { compStream.write(text, cls); }

$('#clear').addEventListener('click', () => {
  if (activeOutTab === 'compiler') {
    clearCompilerOutput();
  } else {
    clearOutput();
  }
});

/* ---------------- input mode ---------------- */
const canInteract = !!(window.crossOriginIsolated && typeof SharedArrayBuffer === 'function');
let mode = store.get('cppwasm.inputMode', 'batch');
if (!canInteract) mode = 'batch';
const termRow = $('#term-row');
const termInput = $('#term-input');
const termEof = $('#term-eof');

function setMode(m) {
  if (running) return;
  mode = m === 'interactive' && canInteract ? 'interactive' : 'batch';
  if (canInteract) store.set('cppwasm.inputMode', mode);
  document.body.classList.toggle('mode-interactive', mode === 'interactive');
  $('#mode-interactive').setAttribute('aria-pressed', String(mode === 'interactive'));
  $('#mode-batch').setAttribute('aria-pressed', String(mode === 'batch'));
  $('#out-title').textContent = mode === 'interactive' ? 'Terminal' : 'Program Output';
  if (activeOutTab === 'program' && termRow) {
    termRow.style.display = mode === 'interactive' ? 'flex' : 'none';
  }
}
if (!canInteract) {
  const b = $('#mode-interactive');
  b.disabled = true;
  b.title = 'Needs a cross-origin isolated page: serve it with the COOP and COEP headers (see README).';
  $('#batch-hint').textContent = 'Sent all at once before the program starts. Interactive mode needs the COOP/COEP server headers.';
}
$('#mode-interactive').addEventListener('click', () => setMode('interactive'));
$('#mode-batch').addEventListener('click', () => setMode('batch'));
$('#mode-interactive').title = $('#mode-interactive').title || 'Type input while the program runs';
$('#mode-batch').title = 'Give all input up front in the Input pane';

// Shared with the worker: [state, length] as Int32, then up to 64 KB of input bytes.
const STDIN_CAP = 65536;
const stdinSab = canInteract ? new SharedArrayBuffer(8 + STDIN_CAP) : null;
const stdinCtrl = stdinSab ? new Int32Array(stdinSab, 0, 2) : null;
const stdinData = stdinSab ? new Uint8Array(stdinSab, 8) : null;
const te = new TextEncoder();
let inputQueue = [];      // Uint8Array chunks typed but not yet read
let eofQueued = false;
let waitingForInput = false;
const inputHistory = [];
let historyPos = 0;

function resetTerminal(active) {
  inputQueue = []; eofQueued = false; waitingForInput = false;
  termInput.disabled = !active;
  termEof.disabled = !active;
  termRow.classList.remove('waiting');
  termInput.placeholder = active ? 'Type ahead; sent when the program reads input' : 'Run the program to type input';
  if (!active) termInput.value = '';
}

/* ---------------- run time limit ---------------- */
// A program may run for 10 seconds. In interactive mode the clock pauses while
// the program waits for you to type, so only its own running time counts.
const TIME_LIMIT_MS = 10000;
const runClock = { used: 0, since: 0, timer: 0 };
function clockResume() {
  if (runClock.timer) return;
  runClock.since = performance.now();
  runClock.timer = setTimeout(onTimeLimit, Math.max(0, TIME_LIMIT_MS - runClock.used));
}
function clockPause() {
  if (!runClock.timer) return;
  clearTimeout(runClock.timer);
  runClock.timer = 0;
  runClock.used += performance.now() - runClock.since;
}
function clockStart() { clockStop(); runClock.used = 0; clockResume(); }
function clockStop() { clearTimeout(runClock.timer); runClock.timer = 0; }
function onTimeLimit() {
  runClock.timer = 0;
  if (!running || current !== 'run') return;
  if (worker) { worker.terminate(); worker = null; }
  setStep('run', 'fail', '> ' + TIME_LIMIT_MS / 1000 + ' s');
  sys('Time limit exceeded: the program ran for more than ' + TIME_LIMIT_MS / 1000 + ' seconds and was stopped.', 'bad');
  finishRun();
  spawn(); // keep a warm worker for the next run
}

function deliver() {
  const wasWaiting = waitingForInput;
  let n;
  if (inputQueue.length) {
    let chunk = inputQueue[0];
    if (chunk.length > STDIN_CAP) { inputQueue[0] = chunk.subarray(STDIN_CAP); chunk = chunk.subarray(0, STDIN_CAP); }
    else inputQueue.shift();
    stdinData.set(chunk);
    n = chunk.length;
  } else if (eofQueued) {
    n = -1;
  } else {
    return false;
  }
  Atomics.store(stdinCtrl, 1, n);
  Atomics.store(stdinCtrl, 0, 1);
  Atomics.notify(stdinCtrl, 0);
  waitingForInput = false;
  if (wasWaiting) clockResume();
  termRow.classList.remove('waiting');
  termInput.placeholder = 'Type ahead; sent when the program reads input';
  return true;
}

function onStdinRequest() {
  if (deliver()) return;
  waitingForInput = true;
  clockPause();
  termRow.classList.add('waiting');
  termInput.placeholder = 'The program is waiting for input';
  if (document.activeElement !== termInput && !(cm && cm.hasFocus)) termInput.focus();
}

function sendLine(text) {
  if (!running || mode !== 'interactive' || eofQueued) return;
  write(text + '\n', 'o-in');
  inputQueue.push(te.encode(text + '\n'));
  if (text) inputHistory.push(text);
  historyPos = inputHistory.length;
  if (waitingForInput) deliver();
}

function sendEof() {
  if (!running || mode !== 'interactive' || eofQueued) return;
  if (termInput.value) { sendLine(termInput.value); termInput.value = ''; }
  eofQueued = true;
  sys('End of input sent.');
  termInput.disabled = true;
  termEof.disabled = true;
  if (waitingForInput) deliver();
}

termInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    sendLine(termInput.value);
    termInput.value = '';
  } else if (e.key.toLowerCase() === 'd' && e.ctrlKey) {
    e.preventDefault();
    sendEof();
  } else if (e.key === 'ArrowUp' && inputHistory.length) {
    e.preventDefault();
    historyPos = Math.max(0, historyPos - 1);
    termInput.value = inputHistory[historyPos];
  } else if (e.key === 'ArrowDown' && inputHistory.length) {
    e.preventDefault();
    historyPos = Math.min(inputHistory.length, historyPos + 1);
    termInput.value = inputHistory[historyPos] || '';
  }
});
termInput.addEventListener('paste', (e) => {
  const text = (e.clipboardData || window.clipboardData).getData('text');
  if (!/\r?\n/.test(text)) return;
  e.preventDefault();
  const start = termInput.selectionStart, end = termInput.selectionEnd;
  const combined = termInput.value.slice(0, start) + text + termInput.value.slice(end);
  const lines = combined.split(/\r?\n/);
  termInput.value = lines.pop();
  for (const line of lines) sendLine(line);
});
termEof.addEventListener('click', () => { sendEof(); termInput.focus(); });
$('#output').addEventListener('click', () => {
  if (mode === 'interactive' && !termInput.disabled && !window.getSelection().toString()) termInput.focus();
});

/* ---------------- pipeline + status ---------------- */
const steps = {};
document.querySelectorAll('.step').forEach((el) => { steps[el.dataset.step] = el; });
function setStep(name, state, time) {
  const el = steps[name];
  el.classList.remove('active', 'done', 'fail');
  if (state) el.classList.add(state);
  if (time !== undefined) el.querySelector('.time').textContent = time;
}
const fmt = (ms) => (ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + ' s');
const statusEl = $('#status');
function status(text, state) { statusEl.textContent = text; statusEl.dataset.state = state; }

/* ---------------- worker orchestration ---------------- */
let base = store.get('cppwasm.base', DEFAULT_BASE);
if (OLD_DEFAULT_BASES.includes(base)) { base = DEFAULT_BASE; store.set('cppwasm.base', base); }
let worker = null;
let toolchain = 'idle';   // idle | loading | ready | error
let running = false;
let current = null;       // stage currently running
const modCache = {};
let progress = {};

function spawn() {
  let absBase;
  try { absBase = resolveBase(base); } catch (e) { absBase = ''; }
  if (!/^https?:/.test(absBase)) {
    toolchain = 'error';
    setStep('toolchain', 'fail', 'failed');
    status('The compiler could not be loaded', 'error');
    sys(location.protocol === 'file:'
      ? 'This page was opened from a file, so ' + base + ' has no web server to load from. Serve the page over http(s) with the toolchain in src/vendors/wasm-clang/, or enter a full URL under “Toolchain source”.'
      : 'The toolchain source “' + base + '” isn’t a valid address. Fix it under “Toolchain source”.', 'bad');
    return false;
  }
  try {
    worker = new Worker(WORKER_URL);
  } catch (e) {
    toolchain = 'error';
    status('This browser blocked the background worker. Serve the page over http(s) and try again.', 'error');
    return false;
  }
  worker.onmessage = onMessage;
  worker.onerror = (e) => {
    sys('Worker error: ' + (e.message || 'unknown'), 'bad');
    finishRun();
  };
  const haveAll = ['memfs', 'sysroot.tar', 'clang', 'lld'].every((k) => modCache[k]);
  progress = {};
  if (!haveAll) {
    toolchain = 'loading';
    setStep('toolchain', 'active', '');
    status('Downloading the compiler…', 'loading');
  }
  try { worker.postMessage({ type: 'init', base: absBase, cache: modCache }); }
  catch (e) { worker.postMessage({ type: 'init', base: absBase, cache: {} }); }
  return true;
}

function onMessage(ev) {
  const m = ev.data;
  switch (m.type) {
    case 'progress': {
      progress[m.name] = m.loaded;
      const total = Object.values(progress).reduce((a, b) => a + b, 0);
      status('Downloading the compiler… ' + (total / 1048576).toFixed(1) + ' MB', 'loading');
      setStep('toolchain', 'active', (total / 1048576).toFixed(0) + ' MB');
      break;
    }
    case 'cache':
      modCache[m.name] = m.value;
      break;
    case 'ready':
      toolchain = 'ready';
      setStep('toolchain', 'done', m.ms > 300 ? fmt(m.ms) : 'cached');
      status('Compiler ready: clang -std=c++17 -O2 -Wall  |  ' + TIME_LIMIT_MS / 1000 + ' s limit', 'ready');
      statusEl.title = 'Clang 22 with libc++, targeting wasm32-wasi';
      break;
    case 'fatal':
      toolchain = 'error';
      setStep('toolchain', 'fail', 'failed');
      status('The compiler could not be loaded', 'error');
      sys(m.message, 'bad');
      sys('Open “Toolchain source” below to point at another copy, then run again.');
      if (worker) { worker.terminate(); worker = null; }
      finishRun();
      break;
    case 'stage':
      if (current) setStep(current, 'done');
      current = m.stage;
      setStep(m.stage, 'active', '');
      if (m.stage === 'run') {
        clockStart();
        switchOutputTab('program');
      }
      break;
    case 'time':
      steps[m.stage].querySelector('.time').textContent = fmt(m.ms);
      break;
    case 'out':
      if (m.channel === 'sys') sys(m.text);
      else if (m.channel === 'compiler') {
        writeCompiler(m.text, 'o-cc');
        if (/error:/i.test(m.text)) {
          setCompilerBadge('error', 'Error');
        } else if (/warning:/i.test(m.text)) {
          setCompilerBadge('warning', 'Warning');
        }
      } else {
        if (isVisualizing) vizOutputCollector += m.text;
        else write(m.text, m.fd === 2 ? 'o-err' : 'o-out');
      }
      break;
    case 'stdin-request':
      onStdinRequest();
      break;
    case 'done':
      onDone(m);
      break;
  }
}

function onDone(m) {
  if (m.ok) {
    if (isVisualizing && vizPhase === 'checking') {
      vizPhase = 'running';
      vizOutputCollector = '';
      setStep('compile', 'done');
      proceedToVizRun();
      return;
    }
    setStep('run', 'done');
    sys('Exited with code ' + m.exitCode + '.', m.exitCode === 0 ? 'good' : 'bad');
  } else {
    setStep(m.stage, 'fail');
    if (m.reason === 'compile') {
      sysCompiler('Compilation failed. Fix the errors above and run again.', 'bad');
      sys('Compilation failed. Check the Compiler Output tab for details.', 'bad');
      setCompilerBadge('error', 'Error');
      switchOutputTab('compiler');
    } else if (m.reason === 'link') {
      sysCompiler('Linking failed. A function may be declared but never defined, or need a library this toolchain lacks.', 'bad');
      sys('Linking failed. Check the Compiler Output tab for details.', 'bad');
      setCompilerBadge('error', 'Error');
      switchOutputTab('compiler');
    } else if (m.reason === 'trap') {
      sys('The program crashed: ' + m.message + (/unreachable/.test(m.message) ? ' (often abort(), a failed assert, or a throw)' : ''), 'bad');
    } else if (m.stage !== 'toolchain') {
      sys('Stopped during ' + m.stage + ': ' + m.message, 'bad');
    }
    if (isVisualizing) {
      vizOutputCollector = '';
      vizPendingCode = null;
      vizPhase = 'idle';
    }
  }
  finishRun(m.ok);
}

let isVisualizing = false;
let vizPhase = 'idle';
let vizPendingCode = null;
let vizOutputCollector = '';
let vizInstance = null;
let originalCodeBeforeViz = null;
let lastFormattedCode = null;

function finishRun(ok = true) {
  clockStop();
  running = false;
  current = null;
  resetTerminal(false);
  $('#run').classList.remove('stop');
  $('#run-label').textContent = 'Run';
  if (isVisualizing) {
    if (ok && vizOutputCollector) {
      handleVizOutput(vizOutputCollector);
    } else {
      closeVisualizer(true);
    }
  }
}

function handleVizOutput(rawOutput) {
  if (!window.CppVisualizer) {
    closeVisualizer(true);
    return;
  }
  try {
    const { events, programOutput, initialGlobals } = window.CppVisualizer.parseTrace(rawOutput);
    if (!events.length) {
      sys('No visualization events captured. Check program syntax or step limit.', 'bad');
      closeVisualizer(true);
      return;
    }
    document.body.classList.add('show-visualizer');
    $('#visualize').classList.remove('processing');
    $('#visualize').classList.add('active', 'stop');
    $('#visualize-label').textContent = 'Stop Viz';
    $('#visualize').title = 'Stop visualization';

    // Show the formatted code version as readonly in the editor
    if (lastFormattedCode) {
      if (cm) {
        cm.replaceAll(lastFormattedCode);
        cm.setReadOnly(true);
      } else {
        fallback.value = lastFormattedCode;
        fallback.readOnly = true;
      }
    }

    if (!vizInstance) {
      const vizContainer = $('#viz-container');
      vizInstance = window.CppVisualizer.create(vizContainer);
      vizInstance.onStepChange((step, total, line, tokenRange) => {
        if (cm) cm.setHighlightedLine(line, tokenRange);
      });
      vizInstance.onClose(() => {
        closeVisualizer();
      });
    }
    vizInstance.load(events, null, programOutput, $('#stdin').value, initialGlobals);
    if (cm) cm.refresh();
  } catch (err) {
    console.error('Visualization load error:', err);
    sys('Visualization error: ' + (err && err.message ? err.message : String(err)), 'bad');
    closeVisualizer(true);
  }
}

function closeVisualizer(keepOutput = false) {
  document.body.classList.remove('show-visualizer');
  $('#visualize').classList.remove('active', 'stop', 'processing');
  $('#visualize-label').textContent = 'Visualize';
  $('#visualize').title = 'Step-by-step visualization';
  isVisualizing = false;
  vizPhase = 'idle';
  vizPendingCode = null;

  // Restore the original code and make editor editable again
  if (originalCodeBeforeViz !== null) {
    if (cm) {
      cm.setReadOnly(false);
      cm.replaceAll(originalCodeBeforeViz);
    } else {
      fallback.readOnly = false;
      fallback.value = originalCodeBeforeViz;
    }
    const f = activeFile();
    if (f) {
      f.code = originalCodeBeforeViz;
      saveFiles();
    }
    originalCodeBeforeViz = null;
  } else if (cm) {
    cm.setReadOnly(false);
  } else {
    fallback.readOnly = false;
  }
  lastFormattedCode = null;

  if (cm) {
    cm.setHighlightedLine(0);
    cm.refresh();
  }
  if (!keepOutput) {
    clearOutput();
    clearCompilerOutput();
  }
  if (vizInstance && typeof vizInstance.clear === 'function') {
    try { vizInstance.clear(); } catch (_) {}
  }
}

function toggleVisualizer() {
  if (document.body.classList.contains('show-visualizer')) {
    closeVisualizer();
    return;
  }
  if (running && isVisualizing) {
    stop();
    return;
  }
  visualizeOrStop();
}

async function visualizeOrStop() {
  if (running) return stop();
  if (!activeFile()) { filesMessage('There’s no file to run yet.'); return; }
  if (!worker && !spawn()) return;

  clearOutput();
  clearCompilerOutput();
  switchOutputTab('program');
  for (const s of ['compile', 'link', 'run']) setStep(s, null, '');
  running = true;
  isVisualizing = true;
  vizPhase = 'checking';
  vizOutputCollector = '';
  $('#visualize').classList.remove('active', 'stop');
  $('#visualize').classList.add('processing');
  $('#visualize-label').textContent = 'Processing';
  $('#visualize').title = 'Processing visualization...';

  const userCode = getCode();
  originalCodeBeforeViz = userCode;
  lastFormattedCode = userCode;
  vizPendingCode = userCode;

  resetTerminal(false);
  // Step 1: Run compilation on original code first
  worker.postMessage({
    type: 'run',
    compileOnly: true,
    code: userCode,
    filename: activeFile().name,
    opt: '-O0',
  });
}

async function proceedToVizRun() {
  const userCode = vizPendingCode || getCode();
  vizPendingCode = null;
  vizPhase = 'running';
  vizOutputCollector = '';

  let codeToRun = userCode;
  try {
    let formattedCode = userCode;
    try {
      const mod = await loadFormatter();
      if (mod && typeof mod.format === 'function') {
        const activeName = activeFile() ? activeFile().name : 'main.cpp';
        formattedCode = mod.format(userCode, activeName, FORMAT_STYLE);
      }
    } catch (fmtErr) {
      console.warn('Visualization format note (using original code):', fmtErr);
    }

    lastFormattedCode = formattedCode;

    if (window.CppVisualizer && window.CppVisualizer.instrumentCode) {
      const activeName = activeFile() ? activeFile().name : 'main.cpp';
      codeToRun = window.CppVisualizer.instrumentCode(formattedCode, activeName);
    } else {
      codeToRun = formattedCode;
    }
  } catch (err) {
    console.error('Visualization instrumentation error:', err);
    sys('Visualization error: ' + (err && err.message ? err.message : String(err)), 'bad');
    closeVisualizer(true);
    running = false;
    return;
  }

  // Clear compile output from step 1 before compiling and running visualization version
  clearOutput();
  clearCompilerOutput();
  switchOutputTab('program');
  for (const s of ['compile', 'link', 'run']) setStep(s, null, '');
  resetTerminal(false);
  worker.postMessage({
    type: 'run',
    compileOnly: false,
    code: codeToRun,
    filename: activeFile() ? activeFile().name : 'main.cpp',
    stdin: $('#stdin').value,
    sab: null,
    opt: '-O0',
  });
}

function runOrStop() {
  if (running) return stop();
  if (document.body.classList.contains('show-visualizer')) {
    closeVisualizer();
  }
  isVisualizing = false;
  if (!activeFile()) { filesMessage('There’s no file to run yet.'); return; }
  if (!worker && !spawn()) return;
  clearOutput();
  clearCompilerOutput();
  switchOutputTab('program');
  for (const s of ['compile', 'link', 'run']) setStep(s, null, '');
  running = true;
  $('#run').classList.add('stop');
  $('#run-label').textContent = 'Stop';
  if (toolchain !== 'ready') sys('Waiting for the compiler download to finish…');
  const interactive = mode === 'interactive';
  resetTerminal(interactive);
  worker.postMessage({
    type: 'run',
    code: getCode(),
    filename: activeFile().name,
    stdin: interactive ? '' : $('#stdin').value,
    sab: interactive ? stdinSab : null,
  });
}

function stop() {
  if (worker) { worker.terminate(); worker = null; }
  if (current) setStep(current, 'fail');
  if (toolchain !== 'ready') { setStep('toolchain', null, ''); toolchain = 'idle'; status('Download stopped', 'idle'); }
  sys('Stopped.', 'bad');
  finishRun();
  spawn(); // keep a warm worker; cached modules make this quick
}

$('#run').addEventListener('click', runOrStop);
$('#visualize').addEventListener('click', toggleVisualizer);
document.addEventListener('keydown', (e) => {
  if (view !== 'workspace') return;
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !(cm && cm.hasFocus)) { e.preventDefault(); runOrStop(); }
  else if (e.shiftKey && e.altKey && e.code === 'KeyF' && !(cm && cm.hasFocus)) { e.preventDefault(); formatCode(); }
});
if (/Mac|iPhone|iPad/.test(navigator.platform)) $('#run kbd').textContent = '⌘↵';

/* ---------------- toolchain source ---------------- */
const baseInput = $('#base-url');
function showResolved() {
  const v = baseInput.value.trim() || DEFAULT_BASE;
  let abs = '';
  try { abs = resolveBase(v.endsWith('/') ? v : v + '/'); } catch (e) {}
  $('#base-resolved').textContent = abs ? 'Loads from ' + abs : 'Not a valid folder or URL';
}
baseInput.value = base;
showResolved();
baseInput.addEventListener('input', showResolved);
$('#base-default').addEventListener('click', () => { baseInput.value = DEFAULT_BASE; showResolved(); });
$('#base-save').addEventListener('click', () => {
  let v = baseInput.value.trim() || DEFAULT_BASE;
  if (!v.endsWith('/')) v += '/';
  baseInput.value = v;
  $('#settings').open = false;
  if (v === base && toolchain !== 'error') return;
  base = v;
  store.set('cppwasm.base', v);
  if (worker) { worker.terminate(); worker = null; }
  for (const k of Object.keys(modCache)) delete modCache[k];
  toolchain = 'idle';
  finishRun();
  setStep('toolchain', null, '');
  spawn();
});

/* ---------------- views: home, workspace, credits ---------------- */
let view = 'home';
let lastView = 'home';   // 'home', 'workspace' or 'room-<id>', for the credits Back link
// Tab titles are "cpp.wasm: <page>". In the editor, <page> is the room's name, its
// code when it has no name, or "Local workspace".
const TITLES = { home: 'run C++ in your browser', credits: 'Credits', recordings: 'Recordings', player: 'Recording player' };
function updateTitle() {
  let page = TITLES[view];
  if (view === 'workspace') page = room.active && room.label ? room.label() || 'Room' : 'Local workspace';
  document.title = 'cpp.wasm: ' + page;
}

function go(name) {
  if (name === 'home') history.pushState(null, '', location.pathname + location.search);
  else history.pushState(null, '', '#' + name);
  route();
}

function route() {
  const h = location.hash;
  const roomMatch = h.match(/^#room-([A-Za-z0-9-]{1,40})$/);
  const playMatch = h.match(/^#play-([A-Za-z0-9]{1,40})$/);
  const prev = view;
  view = h === '#credits' ? 'credits' : h === '#recordings' ? 'recordings' : playMatch ? 'player'
    : (h === '#workspace' || roomMatch) ? 'workspace' : 'home';
  if (view === 'workspace' && !workspaceActive && !roomMatch) { workspaceActive = true; flushSave(); }  // a bookmarked #workspace starts one
  // Only the home page and the workspace change rooms; other pages keep you where you are.
  if (view === 'home' || view === 'workspace') {
    lastView = roomMatch ? 'room-' + roomMatch[1] : view;
    if (room.route) room.route(roomMatch ? roomMatch[1].toLowerCase() : null);
  }
  if (prev === 'player' && views.player) views.player.leave();
  for (const v of ['credits', 'home', 'recordings', 'player']) document.body.classList.toggle('show-' + v, view === v);
  updateTitle();
  window.scrollTo(0, 0);
  if (view === 'credits') $('#credits-title').focus({ preventScroll: true });
  else if (view === 'home') renderHome();
  else if (view === 'recordings') { if (views.recordings) views.recordings.enter(); }
  else if (view === 'player') { if (views.player) views.player.enter(playMatch[1]); }
  else if (cm) cm.refresh();
}

function timeAgo(ms) {
  const s = Math.round((ms - Date.now()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const steps = [[60, 'second'], [60, 'minute'], [24, 'hour'], [30, 'day'], [12, 'month'], [Infinity, 'year']];
  let v = s;
  for (const [size, unit] of steps) {
    if (Math.abs(v) < size) return rtf.format(Math.round(v), unit);
    v /= size;
  }
  return '';
}

function renderHome() {
  $('#home-msg').textContent = '';
  renderHomeCollab();
  const resume = $('#resume');
  resume.hidden = !workspaceActive;
  if (!workspaceActive) return;
  const names = files.map((f) => f.name);
  let list = names.slice(0, 3).join(', ');
  if (names.length > 3) list += ' and ' + (names.length - 3) + ' more';
  $('#resume-detail').textContent = list + (lastEdited ? ', edited ' + timeAgo(lastEdited) : '');
}

function confirmReplace(what) {
  if (!workspaceActive) return true;
  return window.confirm(what + '\n\nYour current ' + plural(files.length, 'file') +
    ' will be replaced. Use “Export zip” first if you want to keep them.');
}

$('#home-continue').addEventListener('click', () => go('workspace'));
$('#home-export').addEventListener('click', exportZip);
$('#home-new').addEventListener('click', () => {
  if (!confirmReplace('Start a new workspace?')) return;
  startWorkspace([{ id: newId(), name: 'main.cpp', code: STARTER, stdin: '' }]);
});
/* Homepage: start or join a collaboration room (collab.js does the work). */
function renderHomeCollab() {
  const box = $('#home-collab');
  box.hidden = !(room.available && cm);
  if (box.hidden) return;
  const nameInput = $('#home-my-name');
  if (document.activeElement !== nameInput) nameInput.value = room.getMyName();
  $('#home-room-error').textContent = '';
  // Offer "my files" only when there is a saved workspace to share.
  const seed = $('#home-seed');
  seed.hidden = !workspaceActive;
  $('#home-seed-mine').textContent = 'My files (' + files.map((f) => f.name).slice(0, 2).join(', ') + (files.length > 2 ? ' and ' + (files.length - 2) + ' more' : '') + ')';
  seed.querySelector('input[value="' + (workspaceActive ? 'mine' : 'new') + '"]').checked = true;
}
$('#home-my-name').addEventListener('change', (e) => { e.target.value = room.setMyName(e.target.value); });
$('#home-room-start').addEventListener('click', () => {
  room.setMyName($('#home-my-name').value);
  const useMine = workspaceActive && document.querySelector('input[name="home-seed"]:checked').value === 'mine';
  const seedFiles = useMine ? null : [{ name: 'main.cpp', code: STARTER, stdin: '' }];
  room.create($('#home-room-name').value, seedFiles);
  $('#home-room-name').value = '';
});
$('#home-room-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#home-room-start').click(); });
$('#home-room-join').addEventListener('click', () => {
  room.setMyName($('#home-my-name').value);
  const id = room.parseCode($('#home-room-code').value);
  if (!id) { $('#home-room-error').textContent = 'Paste a room link, or a code like abcd-efgh-jkmn.'; return; }
  $('#home-room-code').value = '';
  go('room-' + id);
});
$('#home-room-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#home-room-join').click(); });

$('#home-import').addEventListener('click', () => chooseZip('home'));
dropTarget($('#home-import'), importFromHome);

async function importFromHome(file) {
  const msg = $('#home-msg');
  msg.textContent = '';
  const card = $('#home-import');
  card.disabled = true;
  try {
    const { files: imported, notes } = await readZip(file, new Set());
    if (!confirmReplace('Open the ' + plural(imported.length, 'file') + ' from ' + file.name + '?')) return;
    startWorkspace(imported);
    filesMessage('Imported ' + plural(imported.length, 'file') + ' from ' + file.name + (notes.length ? ' (' + notes.join(', ') + ')' : '') + '.', true);
  } catch (e) {
    msg.textContent = e.message;
  } finally {
    card.disabled = false;
  }
}

$('#brand-link').addEventListener('click', (e) => { e.preventDefault(); go('home'); });
$('#credits-back').addEventListener('click', (e) => { e.preventDefault(); go(lastView); });
$('#recs-back').addEventListener('click', (e) => { e.preventDefault(); go(lastView); });

/* ---------------- collaboration (src/js/collab.js) ---------------- */
let roomStash = null;
const collabApi = {
  $, cm, store, room, rec, views, NAME_RE, newId, makeUnique, filesMessage, go, updateTitle,
  getFiles: () => files,
  setFiles: (list) => { files = list; },
  getActiveId: () => activeId,
  setActiveId: (id) => { activeId = id; },
  renderFiles: () => renderFiles(),
  setTitle: (t) => { $('#file-title').textContent = t; },
  setFileActionsEnabled: (on) => { for (const id of ['#new-file', '#import-zip']) $(id).disabled = !on; },
  // Put the local workspace aside while in a room; it is restored, untouched, on leaving.
  enterRoom() {
    if (rec.active) rec.stop('workspace');
    flushSave();
    stashShown();   // keep the open file's undo history for when you come back
    shownId = null;
    roomStash = { files, activeId, docs: new Map(docs) };
    docs.clear();
    room.active = true;
    return { files: files.map((f) => ({ name: f.name, code: f.code, stdin: f.stdin })) };
  },
  exitRoom() {
    if (rec.active) rec.stop('workspace');
    room.active = false;
    if (!roomStash) return;
    files = roomStash.files;
    docs.clear();
    shownId = null;
    roomStash.docs.forEach((d, id) => docs.set(id, d));
    const id = roomStash.activeId;
    roomStash = null;
    openFile(files.some((f) => f.id === id) ? id : files[0].id);
  },
};
if (cm && window.CppWasmCollabInstall) window.CppWasmCollabInstall(collabApi);
else { const b = $('#collab-btn'); b.disabled = true; b.title = 'Collaboration needs the code editor to load'; }
if (cm && window.CppWasmRecordInstall) window.CppWasmRecordInstall(collabApi);
else { const b = $('#rec-btn'); b.disabled = true; b.title = 'Recording needs the code editor to load'; }

window.addEventListener('hashchange', route);
window.addEventListener('popstate', route);
route();

setMode(mode);

// Start fetching the toolchain right away so the first Run is quick.
spawn();
})();
