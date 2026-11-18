# cpp.wasm

Compile and run C++ in the browser. Clang 8 builds your code to WebAssembly and
runs it in the page; nothing is sent to a server.

## Folder layout

```
index.html
coi-serviceworker.js        adds the isolation headers on hosts that can't (GitHub Pages)
.nojekyll                   tells GitHub Pages to serve files as they are
serve.py                    local test server (adds the required headers)
src/
  css/
    style.css               page styles
  js/
    app.js                  editor, terminal, formatter, build orchestration
    worker.js               compiles, links and runs your program (WASI host)
    collab.js               collaboration rooms (WebRTC)
    cpprec.js               the .cpprec recording format (encoder and decoder)
    record.js               recorder, Recordings page and player
    editor.js               the editor: a small wrapper around CodeMirror 6
  vendors/
    wasm-clang/
      clang                 ┐
      lld                   │ add these four yourself, from
      memfs                 │ https://github.com/binji/wasm-clang
      sysroot.tar           ┘
    clang-format/           formatter for the Format button (wasm-fmt 23.1.1)
    editor/                 CodeMirror 6 + Yjs, y-codemirror.next, y-protocols, Trystero (one bundle)
    ibm-plex/               IBM Plex Sans and Mono fonts (Fontsource 5.3.0)
    fflate/                 zip reading and writing (fflate 0.8.3)
    coi-serviceworker/      license for coi-serviceworker.js
```

Everything is self-hosted. The only requests to other sites are the Nostr
relay connections made while you are in a collaboration room. All paths
are relative to `index.html`, so the site works at a domain root or in a
subfolder.

## Run locally

```
python3 serve.py            # then open http://localhost:8000/
```

## Hosting on GitHub Pages

GitHub Pages can't send custom headers, so `coi-serviceworker.js` adds them in
the browser: on the first visit it installs a service worker and reloads the
page once, and from then on interactive mode works.

1. Add the four toolchain files to `src/vendors/wasm-clang/`. Commit them as
   normal files, not with Git LFS (Pages doesn't serve LFS files). Each is under
   GitHub's 100 MB file limit.
2. Push this folder to a repository and turn on Pages (Settings → Pages →
   Deploy from a branch, folder `/` or `/docs`).
3. Open `https://<user>.github.io/<repo>/`. The page reloads once by itself.

Keep `coi-serviceworker.js` next to `index.html`: a service worker only
controls pages at or below its own folder. Interactive mode still needs a
browser that allows service workers; in some private-browsing modes it falls
back to Batch input.

## Required headers for interactive mode (other servers)

Interactive mode pauses your program while you type, which needs
`SharedArrayBuffer`. Browsers only allow that on cross-origin isolated pages,
so the server must send these two headers with the page and its scripts
(including `src/js/worker.js`); setting them for every response is simplest:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

nginx:

```
add_header Cross-Origin-Opener-Policy same-origin always;
add_header Cross-Origin-Embedder-Policy require-corp always;
```

Apache (`.htaccess`, needs mod_headers):

```
Header always set Cross-Origin-Opener-Policy "same-origin"
Header always set Cross-Origin-Embedder-Policy "require-corp"
```

With these headers set on the server, `coi-serviceworker.js` does nothing.
Without either, the page still works, but only in Batch input mode.

## Editor

The editor is CodeMirror 6 (`src/js/editor.js` wraps it). Besides C++
highlighting, auto-closing brackets and per-file undo, it has:

- **Multiple cursors**: Ctrl/⌘+click, Ctrl/⌘+Alt+↑/↓ to add a cursor above or
  below, Ctrl/⌘+D to select the next match, Ctrl/⌘+Shift+L for all matches,
  Alt+drag for a column selection, Esc to go back to one cursor
- **Line commands**: Alt+↑/↓ move a line, Shift+Alt+↑/↓ copy it,
  Ctrl/⌘+Shift+K delete it, Ctrl/⌘+/ toggle a comment
- **Find and replace** (Ctrl/⌘+F, with regex and whole-word options) and go to
  line (Ctrl/⌘+Alt+G)
- **Completion** of C++ keywords, common standard-library names and words in
  the file (Ctrl/⌘+Space to open it yourself)
- **Code folding** (gutter arrows, or Ctrl+Shift+[ and ])
- highlighting of the current line and of other occurrences of the selection

**Shortcuts** in the editor header lists them all. Ctrl/⌘+Enter runs the
program (CodeMirror's default "insert blank line" binding is replaced).
Multi-cursor edits work in collaboration rooms and recordings too; other
people see each person's main cursor and selection.

## Collaboration

**Collaborate** in the editor's header starts a room from your current files
and gives you a link such as `…/#room-k7f3-x9q2-mpta`. You can give the room an
optional name (up to 40 characters) before creating it; everyone who joins
sees it in the room panel, on the header button and in the tab title, and
recordings of the room use it as their title. The name can't be changed once
the room exists. Anyone who opens the link
joins and edits the same files in real time: changes merge without conflicts,
and dots in the Files list show who has which file open.

Everyone's cursor shows in the editor as a bar in their colour with their name
(the name fades after a moment and reappears on hover or when they move), and
any text they select is highlighted in their colour, including blocks across
several lines. Cursors stay visible when someone clicks away from the editor,
for example to press Run. In the room panel, click a person to jump to their
cursor; it opens their file if needed and their cursor flashes. File adds, renames, deletes, imports and each
file's batch input are shared too. Undo only undoes your own edits.

- **Running stays local.** Each person compiles and runs on their own device, so
  output, input mode and the time limit are per person.
- **Your own workspace is untouched.** Joining a room sets your local files
  aside; leaving the room (or going to the home page) brings them back. Export
  zip saves a copy of the room's files.
- **How peers connect.** Browsers in a room talk directly over WebRTC. They
  find each other through public Nostr relays (Trystero), which only see
  encrypted connection details, never your files. No server of your own is
  needed, so it works on GitHub Pages.
- **Someone has to be there.** Files live only in the browsers that have the
  room open. If everyone leaves, the room is empty; whoever joins next can
  start it again with their own files.
- **Privacy.** Anyone with the link can join and edit. Room codes are random
  (about 60 bits), so share links only with people you trust.
- **Hard networks.** Some corporate or mobile networks block direct
  connections. Add a TURN server to `TURN_SERVERS` in `src/js/collab.js`.
- Rooms work best with up to 8 people.

The libraries are bundled with CodeMirror in `src/vendors/editor/` (see its README to rebuild).

## Recordings

**Record** in the editor's header records every change to the files until you
press it again (it shows the elapsed time while recording). In a room it
records everyone's changes, not just yours, each with its author; people in the
room see a red REC badge next to whoever is recording, and a notice when
recording starts or stops. A recording captures:

- files added, renamed and deleted, and imports
- every edit to the code (typing, pasting, undo, Format, other people's edits)
- every edit to each file's batch input
- cursor positions and selections, and people joining and leaving

Recordings are saved in this browser (IndexedDB) as you go, so closing the tab
keeps everything up to about a second before. Recording stops by itself if the
workspace is replaced (joining or leaving a room, or starting a new workspace).

**Recordings** in the footer lists them with Play, Download and Delete, and
opens `.cpprec` files from disk. The player shows the files, the code with
everyone's cursors and selections, who is where, and each file's input. It has
play/pause (Space), seeking (the timeline, or the ← and → keys for 5 seconds),
speeds from 0.5× to 16×, **Skip pauses** (pauses longer than 1.5 s are
shortened), **Follow changes** (show whichever file is being edited; click a
file to stay on it), and **Files at this point**, which downloads the files as
they were at the current moment as a zip. The timeline shows where activity is.

### The .cpprec format

A small binary format, specified at the top of `src/js/cpprec.js`: an 8-byte
header (`CPPREC`, version, flags) and a DEFLATE-compressed stream of events.
Each event is a time delta in 10 ms ticks, a type-and-author byte, and a few
varint fields. Positions are stored relative to where they were expected (the
end of the same person's previous edit), so ordinary typing costs about two
bytes per keystroke. Cursor moves that just follow typing are not stored, and
other cursor moves are limited to about 7 per second per person.

On a simulated two-hour, two-person session (30,000 events):

| Format               | Size     |
|----------------------|----------|
| JSON                 | 2,070 KB |
| JSON, gzip -9        | 264 KB   |
| .cpprec              | 68 KB (2.3 bytes per event) |

## Home page

Opening the site shows the home page: start a **New workspace** (a single
`main.cpp`), **Import a zip** (click or drop a file), or **Continue** the
workspace saved in this browser. Its **Collaborate in a room** section starts a
room (with your name, an optional room name, and either your saved files or a
new `main.cpp`) or joins one from a pasted link or code. Starting a new one or importing from the home
page replaces the saved workspace, after asking; export it first to keep a
copy. `#workspace` opens the editor directly, so it can be bookmarked.

## Import and export

The upload and download buttons in the Files sidebar import and export zips.
Importing there adds the zip's files to the current workspace (renaming any
that clash, like `main-2.cpp`); you can also drop a zip on the sidebar.

Export writes every file at the top level, plus `input/<file name>.txt` for
files with batch input. Import accepts `.cpp`, `.cc`, `.cxx` and `.c++` files
from any folder, reads inputs from that same `input/` layout, and skips other
files. Limits: 20 MB per zip, 1 MB per source file, 200 files.

## Files

The left sidebar lists your C++ files; each one is a separate program, and Run
builds the file that is open. Each file keeps its own batch input. Use **+** to
add a file, the pencil (or double-click, or F2) to rename, and the bin to
delete. The button left of the file name hides or shows the sidebar. Files are
saved in the browser's localStorage, so they stay on this device and browser.

## Input modes

Batch input (the default) sends the Input pane to the program at the start.
Interactive lets you type while the program runs; it needs the headers below.

## Compiler options

Fixed: `-std=c++14 -O2 -Wall`. Programs are stopped after 10 seconds of run
time (`TIME_LIMIT_MS` in `src/js/app.js`); in interactive mode, time spent
waiting for your input doesn't count. `#include <bits/stdc++.h>` is supported.
No exceptions or threads (Clang 8 / WASI limits).
