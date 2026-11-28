/* cpp.wasm visualizer: step-through execution trace viewer for C++.
   Takes instrumented trace events (JSON lines prefixed with __VIZ__ in stdout)
   and provides a Python-Tutor-style step-by-step visualization.

     const viz = CppVisualizer.create(containerElement);
     const { events, programOutput } = CppVisualizer.parseTrace(stdout);
     viz.load(events);
     viz.stepForward();  viz.stepBack();  viz.goToStep(42);
     viz.onStepChange((step, total, line) => { ... });
     viz.destroy();
*/
var CppVisualizer = (function () {
  'use strict';

  // ── CSS injection (once) ──────────────────────────────────────────────
  let styleInjected = false;

  function injectStyles() {
    if (styleInjected) return;
    styleInjected = true;
    const css = `
/* ── visualizer panel ─────────────────────────────────────────────── */
.viz-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--panel);
  border-radius: 10px;
  overflow: hidden;
  font-family: var(--sans);
  color: var(--ink);
}

/* ── controls bar ─────────────────────────────────────────────────── */
.viz-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line);
  flex-shrink: 0;
}
.viz-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: var(--panel-2);
  padding: 5px 10px;
  font-size: 12px;
  font-family: var(--sans);
  color: var(--ink);
  cursor: pointer;
  white-space: nowrap;
  user-select: none;
  transition: background .15s, border-color .15s;
  min-width: 32px;
}
.viz-btn:hover { background: var(--sel); border-color: var(--accent); }
.viz-btn:active { opacity: .8; }
.viz-btn:disabled { cursor: not-allowed; opacity: .4; }
.viz-btn.viz-primary {
  background: var(--accent);
  color: var(--accent-ink);
  border-color: var(--accent);
  font-weight: 600;
}
.viz-btn.viz-primary:hover { opacity: .9; }
.viz-step-info {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--muted);
  margin-left: auto;
  white-space: nowrap;
}
.viz-slider {
  width: 140px;
  accent-color: var(--accent);
  cursor: pointer;
}

/* ── body: stack + vars side by side ──────────────────────────────── */
.viz-body {
  display: flex;
  flex-direction: row;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* ── section headers ──────────────────────────────────────────────── */
.viz-panel h3 {
  font-size: 11.5px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: .06em;
  color: var(--muted);
  margin: 0 0 8px;
  padding: 0;
  line-height: 1.4;
}

/* ── call stack ───────────────────────────────────────────────────── */
.viz-stack {
  display: flex;
  flex-direction: column;
  flex: 0 0 auto;
  width: var(--viz-stack-width, 220px);
  min-width: 90px;
  max-width: calc(100% - 140px);
  overflow: auto;
  padding: 10px 14px;
  border-right: none;
}
.viz-split-resizer {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 8px;
  flex: 0 0 8px;
  cursor: col-resize;
  user-select: none;
  touch-action: none;
  z-index: 5;
  outline: none;
  background-color: var(--line);
  transition: background-color .15s ease;
}
.viz-split-resizer:hover,
.viz-split-resizer:focus-visible,
.viz-split-resizer.dragging {
  background-color: var(--accent);
}
.viz-split-resizer::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 2px;
  height: 20px;
  border-radius: 1px;
  background-color: var(--panel, #fff);
  opacity: 0.8;
}
.viz-stack-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.viz-stack-item {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 10px;
  border-left: 3px solid transparent;
  border-radius: 0 5px 5px 0;
  font-family: var(--mono);
  font-size: 12.5px;
  cursor: default;
  transition: background .15s;
}
.viz-stack-item:hover { background: var(--panel-2); }
.viz-stack-item.active {
  background: var(--sel);
  border-left-color: var(--accent);
  font-weight: 600;
}
.viz-stack-fn { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.viz-stack-line {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--muted);
  white-space: nowrap;
}
.viz-stack-arrow {
  color: var(--accent);
  margin-right: 4px;
  font-size: 10px;
}

/* ── variables ────────────────────────────────────────────────────── */
.viz-vars {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  overflow: auto;
  padding: 10px 14px;
}
.viz-vars-content { flex: 1; overflow: auto; position: relative; }
.viz-vars-frame-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--muted);
  margin: 8px 0 4px;
  font-family: var(--mono);
}
.viz-vars-frame-title:first-child { margin-top: 0; }
.viz-vars-table {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--mono);
  font-size: 12.5px;
  margin-bottom: 6px;
}
.viz-vars-table td {
  padding: 2px 8px 2px 0;
  vertical-align: top;
  white-space: nowrap;
}
.viz-vars-table td:first-child { font-weight: 600; color: var(--ink); }
.viz-vars-table td:nth-child(2) { color: var(--t-type); font-size: 11.5px; }
.viz-vars-table td:nth-child(3) { color: var(--t-num); word-break: break-all; white-space: pre-wrap; }
.viz-vars-table tr { transition: background-color .15s ease; border-radius: 4px; }
.viz-vars-empty {
  font-size: 12px;
  color: var(--muted);
  font-style: italic;
}
.viz-ref-arrows-svg {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
  z-index: 2;
  overflow: visible;
}
.viz-ref-anchor-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background-color: var(--accent);
  margin-left: 6px;
  vertical-align: middle;
}
.viz-ref-target-hook {
  display: inline-block;
  width: 4px;
  height: 4px;
  margin-left: 4px;
  vertical-align: middle;
}
.viz-ref-arrow-path {
  pointer-events: stroke;
  cursor: pointer;
  transition: stroke-width .15s, filter .15s;
}

/* ── changed highlight ────────────────────────────────────────────── */
@keyframes viz-flash {
  0%   { background-color: rgba(240, 168, 48, .35); }
  100% { background-color: transparent; }
}
.viz-changed td { animation: viz-flash .5s ease-out; }

/* ── Array & Vector Tabular Visualization ─────────────────────────── */
.viz-array-view {
  margin: 2px 0 6px 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.viz-array-toolbar {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 11px;
  color: var(--muted);
}
.viz-array-explore {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.viz-array-inputs-row {
  display: flex;
  align-items: center;
  gap: 4px;
}
.viz-explorer-label {
  font-size: 10.5px;
  color: var(--muted);
}
.viz-idx-input {
  width: 38px;
  height: 20px;
  font-family: var(--mono);
  font-size: 11px;
  text-align: center;
  padding: 1px 2px;
  border: 1px solid var(--line);
  border-radius: 3px;
  background: var(--panel, #fff);
  color: var(--ink);
  outline: none;
  box-sizing: border-box;
}
.viz-idx-input:focus {
  border-color: var(--accent);
}
.viz-inspect-row {
  display: flex;
  align-items: center;
  min-height: 0;
}
.viz-inspect-badge {
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
  padding: 1px 6px;
  background: rgba(28, 126, 214, 0.08);
  border-radius: 3px;
  min-height: 18px;
  display: inline-flex;
  align-items: center;
  font-family: var(--mono);
}
.viz-inspect-badge.viz-inspect-idle {
  font-weight: 500;
  color: var(--muted);
  background: rgba(128, 128, 128, 0.08);
}
.viz-inspect-badge:empty {
  display: none;
}
.viz-view-toggle-btn {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  margin-left: auto;
  transition: all 0.15s ease;
}
.viz-view-toggle-btn:hover {
  color: var(--ink);
  background: var(--bg-hover, rgba(0, 0, 0, 0.05));
  border-color: var(--ink);
}
.viz-array-table-wrapper {
  overflow-x: auto;
  max-width: 100%;
  padding-bottom: 2px;
}
.viz-array-table {
  border-collapse: separate;
  border-spacing: 2px;
  font-family: var(--mono);
  font-size: 11.5px;
  margin: 0;
}
.viz-array-table th, .viz-array-table td {
  padding: 2px 6px;
  min-width: 22px;
  text-align: center;
  border-radius: 3px;
  box-sizing: border-box;
}
.viz-idx-corner, .viz-idx-th, .viz-row-th {
  background: var(--bg-hover, rgba(0, 0, 0, 0.04));
  color: var(--muted);
  font-size: 10px;
  font-weight: 600;
  user-select: none;
}
.viz-val-label {
  background: var(--bg-hover, rgba(0, 0, 0, 0.03));
  color: var(--muted);
  font-size: 10px;
  font-style: italic;
  user-select: none;
}
.viz-cell-val {
  background: var(--panel, #fff);
  border: 1px solid var(--line);
  color: var(--ink);
  cursor: pointer;
  transition: background-color 0.15s ease, border-color 0.15s ease, transform 0.1s ease;
  white-space: nowrap;
}
.viz-cell-val:hover {
  border-color: var(--accent);
  background: rgba(28, 126, 214, 0.08);
}
.viz-cell-inspected {
  border-color: #1c7ed6 !important;
  background: rgba(28, 126, 214, 0.18) !important;
  box-shadow: 0 0 0 1px #1c7ed6;
  font-weight: 700;
}
@keyframes viz-cell-flash {
  0%   { background-color: #ffec99; border-color: #f59f00; transform: scale(1.08); }
  50%  { background-color: rgba(245, 159, 0, 0.35); border-color: #f59f00; }
  100% { background-color: rgba(245, 159, 0, 0.15); border-color: #f59f00; }
}
.viz-cell-changed {
  animation: viz-cell-flash 0.6s ease-out;
  background-color: rgba(245, 159, 0, 0.18) !important;
  border-color: #f59f00 !important;
  font-weight: 700;
  box-shadow: 0 0 0 1px #f59f00;
}
.viz-slice-tabs {
  display: flex;
  gap: 3px;
  margin-bottom: 3px;
}
.viz-slice-tab {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.viz-slice-tab.active {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}
.viz-array-raw-view {
  font-family: var(--mono);
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--t-num);
  padding: 4px 6px;
  background: var(--bg-hover, rgba(0, 0, 0, 0.03));
  border-radius: 3px;
  border: 1px solid var(--line);
  margin: 0;
}

/* ── output ───────────────────────────────────────────────────────── */
.viz-output {
  flex-shrink: 0;
  border-top: 1px solid var(--line);
  padding: 8px 14px;
  max-height: 120px;
  overflow: auto;
}
.viz-output-text {
  margin: 0;
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--ink);
  min-height: 1.2em;
}

/* ── IO section ───────────────────────────────────────────────────── */
.viz-io-empty {
  color: var(--muted);
  font-style: italic;
}
.viz-io-consumed {
  color: var(--muted);
  opacity: 0.6;
}
.viz-io-highlight {
  background: rgba(240, 168, 48, .35);
  border-radius: 2px;
  padding: 1px 2px;
}

/* ── empty state ──────────────────────────────────────────────────── */
.viz-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  font-size: 13px;
  color: var(--muted);
}
`;
    const el = document.createElement('style');
    el.textContent = css;
    document.head.appendChild(el);
  }

  // ── Trace parsing ─────────────────────────────────────────────────────

  /**
   * Parse program stdout: extract __VIZ__ lines and inline markers into events, return clean output and initialGlobals.
   * @param {string} outputText
   * @returns {{ events: object[], programOutput: string, initialGlobals: object }}
   */
  function parseTrace(outputText) {
    if (!outputText) return { events: [], programOutput: '', initialGlobals: {} };
    var events = [];
    var initialGlobals = {};
    var cleanOutput = '';
    var re = /__VIZ__(\{[^\r\n]*\})(?:\r?\n)?/g;
    var lastIdx = 0;
    var m;

    while ((m = re.exec(outputText)) !== null) {
      cleanOutput += outputText.slice(lastIdx, m.index);
      try {
        var ev = JSON.parse(m[1]);
        if (ev.endVar) {
          if (!ev.endVars) ev.endVars = [];
          ev.endVars.push(ev.endVar);
        }
        if (ev.endVar1) {
          if (!ev.endVars) ev.endVars = [];
          ev.endVars.push(ev.endVar1);
        }
        if (ev.endVar2) {
          if (!ev.endVars) ev.endVars = [];
          ev.endVars.push(ev.endVar2);
        }
        if (ev.e === 'global_decl') {
          initialGlobals[ev.name] = { type: ev.type, val: ev.val, addr: ev.addr };
        } else if (ev.e === 'var_end') {
          if (events.length > 0) {
            var prev = events[events.length - 1];
            if (!prev.endVars) prev.endVars = [];
            prev.endVars.push(ev.name);
          }
        } else {
          ev._output = cleanOutput;
          events.push(ev);
        }
      } catch (_) { /* skip malformed */ }
      lastIdx = re.lastIndex;
    }

    if (lastIdx < outputText.length) {
      cleanOutput += outputText.slice(lastIdx);
    }

    return { events: events, programOutput: cleanOutput, initialGlobals: initialGlobals };
  }

  /**
   * Pre-calculate input character ranges [start, end] for each input event against programInput.
   * @param {object[]} events
   * @param {string}   programInput
   */
  function assignInputRanges(events, programInput) {
    if (!programInput || !events || !events.length) return;
    var pos = 0;
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      if (ev.e !== 'io' || ev.io !== 'input') continue;
      var valStr = ev.inputVal != null ? String(ev.inputVal) : (ev.val != null ? String(ev.val) : '');
      if ((valStr.startsWith('"') && valStr.endsWith('"')) || (valStr.startsWith("'") && valStr.endsWith("'"))) {
        valStr = valStr.slice(1, -1);
      }
      if (ev.isGetline) {
        if (pos < programInput.length && (programInput[pos] === '\r' || programInput[pos] === '\n')) {
          if (programInput[pos] === '\r' && programInput[pos + 1] === '\n') pos += 2;
          else pos += 1;
        }
        var gStart = pos;
        var nextNl = programInput.indexOf('\n', gStart);
        if (nextNl === -1) nextNl = programInput.length;
        var gEnd = nextNl;
        if (gEnd > gStart && programInput[gEnd - 1] === '\r') gEnd--;
        ev.inputRange = [gStart, gEnd];
        pos = (nextNl < programInput.length) ? nextNl + 1 : nextNl;
      } else {
        while (pos < programInput.length && /\s/.test(programInput[pos])) {
          pos++;
        }
        var start = pos;
        var end = pos;
        if (valStr.length > 0) {
          if (programInput.slice(start, start + valStr.length) === valStr) {
            end = start + valStr.length;
          } else {
            while (end < programInput.length && !/\s/.test(programInput[end])) {
              end++;
            }
          }
        } else {
          while (end < programInput.length && !/\s/.test(programInput[end])) {
            end++;
          }
        }
        ev.inputRange = [start, end];
        pos = end;
      }
    }
  }

  // ── State computation ─────────────────────────────────────────────────

  function getElementSizeInBytes(typeStr) {
    if (!typeStr) return 4;
    var t = typeStr.replace(/[\[\]*&\s]/g, '').toLowerCase();
    if (t === 'char' || t === 'bool' || t === 'int8_t' || t === 'uint8_t' || t === 'byte') return 1;
    if (t === 'short' || t === 'int16_t' || t === 'uint16_t') return 2;
    if (t === 'int' || t === 'float' || t === 'long' || t === 'int32_t' || t === 'uint32_t' || t === 'size_t') return 4;
    if (t === 'double' || t === 'longlong' || t === 'int64_t' || t === 'uint64_t') return 8;
    return 4;
  }

  function parseScalarValue(valStr) {
    if (valStr === null || valStr === undefined) return null;
    valStr = String(valStr).trim();
    if (valStr === 'true') return true;
    if (valStr === 'false') return false;
    if (!isNaN(Number(valStr)) && valStr !== '') return Number(valStr);
    if (valStr.startsWith('"') && valStr.endsWith('"')) {
      try { return JSON.parse(valStr); } catch (_) { return valStr.slice(1, -1); }
    }
    if (valStr.startsWith("'") && valStr.endsWith("'")) {
      return valStr.slice(1, -1);
    }
    return valStr;
  }

  function getArrayElementByAddr(vobj, targetAddr) {
    if (!vobj || !vobj.val || !vobj.addr || !targetAddr) return null;
    var arrData = parseArrayValue(vobj.val);
    if (!arrData) return null;

    var dim = getArrayDimension(arrData);
    var elemSize = getElementSizeInBytes(vobj.type);

    try {
      var baseAddrBig = BigInt(vobj.addr);
      var targetAddrBig = BigInt(targetAddr);
      var byteOffsetBig = targetAddrBig - baseAddrBig;
      if (byteOffsetBig < 0n) return null;

      var byteOffset = Number(byteOffsetBig);
      var linearIdx = Math.round(byteOffset / elemSize);

      if (dim === 1) {
        if (linearIdx >= 0 && linearIdx < arrData.length) {
          return { bracketStr: '[' + linearIdx + ']' };
        }
      } else if (dim === 2) {
        var colCount = (arrData[0] && Array.isArray(arrData[0])) ? arrData[0].length : 0;
        if (colCount > 0) {
          var r = Math.floor(linearIdx / colCount);
          var c = linearIdx % colCount;
          if (r >= 0 && r < arrData.length && arrData[r] && c >= 0 && c < arrData[r].length) {
            return { bracketStr: '[' + r + '][' + c + ']' };
          }
        }
      } else if (dim === 3) {
        var d2 = (arrData[0] && Array.isArray(arrData[0])) ? arrData[0].length : 0;
        var d3 = (arrData[0] && arrData[0][0] && Array.isArray(arrData[0][0])) ? arrData[0][0].length : 0;
        var sliceSize = d2 * d3;
        if (sliceSize > 0 && d3 > 0) {
          var d1 = Math.floor(linearIdx / sliceSize);
          var rem = linearIdx % sliceSize;
          var row = Math.floor(rem / d3);
          var col = rem % d3;
          if (d1 >= 0 && d1 < arrData.length && arrData[d1] && row >= 0 && row < arrData[d1].length && arrData[d1][row] && col >= 0 && col < d3) {
            return { bracketStr: '[' + d1 + '][' + row + '][' + col + ']' };
          }
        }
      }
    } catch (_) {}
    return null;
  }

  function updateArrayElementByAddr(vobj, targetAddr, newVal) {
    if (!vobj || !vobj.val || !vobj.addr || !targetAddr) return false;
    var arrData = parseArrayValue(vobj.val);
    if (!arrData) return false;

    var dim = getArrayDimension(arrData);
    var elemSize = getElementSizeInBytes(vobj.type);

    try {
      var baseAddrBig = BigInt(vobj.addr);
      var targetAddrBig = BigInt(targetAddr);
      var byteOffsetBig = targetAddrBig - baseAddrBig;
      if (byteOffsetBig < 0n) return false;

      var byteOffset = Number(byteOffsetBig);
      var linearIdx = Math.round(byteOffset / elemSize);
      var scalar = parseScalarValue(newVal);

      if (dim === 1) {
        if (linearIdx >= 0 && linearIdx < arrData.length) {
          arrData[linearIdx] = scalar;
          vobj.val = JSON.stringify(arrData);
          return true;
        }
      } else if (dim === 2) {
        var colCount = (arrData[0] && Array.isArray(arrData[0])) ? arrData[0].length : 0;
        if (colCount > 0) {
          var r = Math.floor(linearIdx / colCount);
          var c = linearIdx % colCount;
          if (r >= 0 && r < arrData.length && arrData[r] && c >= 0 && c < arrData[r].length) {
            arrData[r][c] = scalar;
            vobj.val = JSON.stringify(arrData);
            return true;
          }
        }
      } else if (dim === 3) {
        var d2 = (arrData[0] && Array.isArray(arrData[0])) ? arrData[0].length : 0;
        var d3 = (arrData[0] && arrData[0][0] && Array.isArray(arrData[0][0])) ? arrData[0][0].length : 0;
        var sliceSize = d2 * d3;
        if (sliceSize > 0 && d3 > 0) {
          var d1 = Math.floor(linearIdx / sliceSize);
          var rem = linearIdx % sliceSize;
          var row = Math.floor(rem / d3);
          var col = rem % d3;
          if (d1 >= 0 && d1 < arrData.length && arrData[d1] && row >= 0 && row < arrData[d1].length && arrData[d1][row] && col >= 0 && col < d3) {
            arrData[d1][row][col] = scalar;
            vobj.val = JSON.stringify(arrData);
            return true;
          }
        }
      }
    } catch (_) {}
    return false;
  }

  /**
   * Search caller frames (top to bottom) and globals for a variable with targetAddr.
   */
  function resolveRefInfo(callStack, globals, targetAddr, ownName, ownFrameIdx) {
    if (!targetAddr) return null;
    if (callStack) {
      for (var f = callStack.length - 1; f >= 0; f--) {
        for (var vn in callStack[f].vars) {
          if (ownFrameIdx !== undefined && f === ownFrameIdx && vn === ownName) {
            continue;
          }
          var vobj = callStack[f].vars[vn];
          if (!vobj.addr) continue;

          var elemMatch = getArrayElementByAddr(vobj, targetAddr);
          if (elemMatch) {
            return { refVar: vn + elemMatch.bracketStr, refBaseVar: vn, refFrameIdx: f };
          }
          if (vobj.addr === targetAddr) {
            return { refVar: vn, refBaseVar: vn, refFrameIdx: f };
          }
        }
      }
    }
    if (globals) {
      for (var gn in globals) {
        if (ownFrameIdx === -1 && gn === ownName) {
          continue;
        }
        var gobj = globals[gn];
        if (!gobj.addr) continue;

        var elemMatchG = getArrayElementByAddr(gobj, targetAddr);
        if (elemMatchG) {
          return { refVar: gn + elemMatchG.bracketStr, refBaseVar: gn, refFrameIdx: -1 };
        }
        if (gobj.addr === targetAddr) {
          return { refVar: gn, refBaseVar: gn, refFrameIdx: -1 };
        }
      }
    }
    return null;
  }

  function markVarChanged(changedVars, frameIdx, varName, addr) {
    if (!changedVars) return;
    changedVars.add(varName);
    if (frameIdx !== undefined && frameIdx !== null) {
      changedVars.add(frameIdx + ':' + varName);
      changedVars.hasFrameKeys = true;
    }
    if (addr) {
      if (!changedVars.addrs) changedVars.addrs = new Set();
      changedVars.addrs.add(addr);
    }
  }

  function isVarChanged(changedVars, frameIdx, varName, vobj) {
    if (!changedVars) return false;
    if (vobj && vobj.addr && changedVars.addrs && changedVars.addrs.size > 0) {
      return changedVars.addrs.has(vobj.addr);
    }
    if (frameIdx !== undefined && frameIdx !== null && changedVars.has(frameIdx + ':' + varName)) {
      return true;
    }
    if (!changedVars.hasFrameKeys && changedVars.has(varName)) {
      return true;
    }
    return false;
  }

  function parseArrayValue(val) {
    if (typeof val !== 'string') return null;
    val = val.trim();
    if (!val.startsWith('[') || !val.endsWith(']')) return null;
    try {
      var parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed;
    } catch (e) {
      try {
        var sanitized = val
          .replace(/'(\\[0nrt'\\]|\\x[0-9a-fA-F]{2}|[^'\\])'/g, function (_, inner) {
            return JSON.stringify("'" + inner + "'");
          })
          .replace(/\.\.\./g, '"..."');
        var p = JSON.parse(sanitized);
        if (Array.isArray(p)) return p;
      } catch (e2) {}
    }
    return null;
  }

  function getArrayDimension(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return 1;
    if (!Array.isArray(arr[0])) return 1;
    if (arr[0].length === 0 || !Array.isArray(arr[0][0])) return 2;
    return 3;
  }

  function computeArrayDiff(prevValStr, currValStr) {
    var prev = parseArrayValue(prevValStr);
    var curr = parseArrayValue(currValStr);
    if (!curr || !prev) return null;
    var diff = new Set();
    var dim = getArrayDimension(curr);
    if (dim === 1) {
      var maxLen = Math.max(prev.length, curr.length);
      for (var i = 0; i < maxLen; i++) {
        if (prev[i] !== curr[i]) {
          diff.add(String(i));
        }
      }
    } else if (dim === 2) {
      var maxR = Math.max(prev.length, curr.length);
      for (var r = 0; r < maxR; r++) {
        var prevRow = prev[r] || [];
        var currRow = curr[r] || [];
        var maxC = Math.max(prevRow.length, currRow.length);
        for (var c = 0; c < maxC; c++) {
          if (prevRow[c] !== currRow[c]) {
            diff.add(r + ',' + c);
          }
        }
      }
    } else if (dim === 3) {
      var maxD1 = Math.max(prev.length, curr.length);
      for (var d1 = 0; d1 < maxD1; d1++) {
        var prev2 = prev[d1] || [];
        var curr2 = curr[d1] || [];
        var maxD2 = Math.max(prev2.length, curr2.length);
        for (var d2 = 0; d2 < maxD2; d2++) {
          var prev3 = prev2[d2] || [];
          var curr3 = curr2[d2] || [];
          var maxD3 = Math.max(prev3.length, curr3.length);
          for (var d3 = 0; d3 < maxD3; d3++) {
            if (prev3[d3] !== curr3[d3]) {
              diff.add(d1 + ',' + d2 + ',' + d3);
            }
          }
        }
      }
    }
    return diff;
  }

  function recordElementDiff(changedVars, key, prevVal, newVal) {
    if (!changedVars) return;
    if (!changedVars.elementDiffs) changedVars.elementDiffs = new Map();
    var diff = computeArrayDiff(prevVal, newVal);
    if (diff && diff.size > 0) {
      changedVars.elementDiffs.set(key, diff);
    }
  }

  /**
   * Synchronize all aliased variables sharing targetAddr across callStack and globals.
   */
  function syncAliasedVars(callStack, globals, targetAddr, newVal, changedVars, isLast) {
    if (!targetAddr) return;
    var isNewValArray = typeof newVal === 'string' && newVal.trim().startsWith('[');

    if (callStack) {
      for (var f = 0; f < callStack.length; f++) {
        for (var vn in callStack[f].vars) {
          var vobj = callStack[f].vars[vn];
          if (!vobj.addr) continue;

          var isArray = (vobj.type && vobj.type.includes('[]')) || (typeof vobj.val === 'string' && vobj.val.trim().startsWith('['));

          if (vobj.addr === targetAddr) {
            var prevVal = vobj.val;
            if (isArray && !isNewValArray) {
              updateArrayElementByAddr(vobj, targetAddr, newVal);
            } else {
              vobj.val = newVal;
            }
            if (isLast && changedVars) {
              markVarChanged(changedVars, f, vn, targetAddr);
              recordElementDiff(changedVars, f + ':' + vn, prevVal, vobj.val);
            }
          } else if (isArray) {
            var prevValA = vobj.val;
            var updated = updateArrayElementByAddr(vobj, targetAddr, newVal);
            if (updated && isLast && changedVars) {
              markVarChanged(changedVars, f, vn, vobj.addr);
              recordElementDiff(changedVars, f + ':' + vn, prevValA, vobj.val);
            }
          }
        }
      }
    }
    if (globals) {
      for (var gn in globals) {
        var gobj = globals[gn];
        if (!gobj.addr) continue;

        var isArrayG = (gobj.type && gobj.type.includes('[]')) || (typeof gobj.val === 'string' && gobj.val.trim().startsWith('['));

        if (gobj.addr === targetAddr) {
          var prevValG = gobj.val;
          if (isArrayG && !isNewValArray) {
            updateArrayElementByAddr(gobj, targetAddr, newVal);
          } else {
            gobj.val = newVal;
          }
          if (isLast && changedVars) {
            markVarChanged(changedVars, -1, gn, targetAddr);
            recordElementDiff(changedVars, '-1:' + gn, prevValG, gobj.val);
          }
        } else if (isArrayG) {
          var prevValGA = gobj.val;
          var updatedG = updateArrayElementByAddr(gobj, targetAddr, newVal);
          if (updatedG && isLast && changedVars) {
            markVarChanged(changedVars, -1, gn, gobj.addr);
            recordElementDiff(changedVars, '-1:' + gn, prevValGA, gobj.val);
          }
        }
      }
    }
  }

  /**
   * Compute the execution state at a given step by replaying events 0..step.
   * @param {object[]} events
   * @param {number}   step          Index of the last event to apply (inclusive).
   * @param {object}   [snapshot]    Optional snapshot to start from (callStack, currentLine, outputIndex).
   * @param {number}   [startIndex]  Index to start replaying from (0 if no snapshot).
   * @param {object}   [initGlobals] Baseline global variables.
   * @returns {{ callStack: object[], globals: object, currentLine: number, changedVars: Set }}
   */
  function computeState(events, step, snapshot, startIndex, initGlobals) {
    // Deep-clone snapshot if provided, otherwise start fresh.
    var callStack, currentLine, globals;
    if (snapshot) {
      callStack = deepCloneStack(snapshot.callStack);
      globals = deepCloneVars(snapshot.globals || {});
      currentLine = snapshot.currentLine;
    } else {
      callStack = [];
      globals = deepCloneVars(initGlobals || {});
      currentLine = 0;
    }
    var from = (startIndex != null) ? startIndex : 0;

    // Track which vars changed on exactly the target step.
    var changedVars = new Set();
    changedVars.addrs = new Set();
    changedVars.hasFrameKeys = false;
    changedVars.elementDiffs = new Map();

    for (var i = from; i <= step && i < events.length; i++) {
      var ev = events[i];
      var isLast = (i === step);

      switch (ev.e) {
        case 'func_enter':
          var frame = {
            name: ev.name,
            params: ev.params || [],
            line: ev.line,
            depth: ev.depth,
            vars: {}
          };
          var topF = callStack.length;
          // Add params as vars in this frame, resolving reference bindings by memory address
          for (var p = 0; p < frame.params.length; p++) {
            var prm = frame.params[p];
            var refInfo = resolveRefInfo(callStack, globals, prm.addr, prm.name, topF);
            frame.vars[prm.name] = {
              type: prm.type,
              val: prm.val,
              addr: prm.addr,
              refVar: refInfo ? refInfo.refVar : null,
              refBaseVar: refInfo ? refInfo.refBaseVar : null,
              refFrameIdx: refInfo ? refInfo.refFrameIdx : null
            };
            if (isLast) markVarChanged(changedVars, topF, prm.name, prm.addr);
          }
          callStack.push(frame);
          currentLine = ev.line;
          break;

        case 'func_exit':
          if (callStack.length) callStack.pop();
          // Restore currentLine to caller's resume line
          if (callStack.length) {
            currentLine = callStack[callStack.length - 1].line || currentLine;
          }
          break;

        case 'global_decl':
          globals[ev.name] = { type: ev.type, val: ev.val, addr: ev.addr };
          if (isLast) markVarChanged(changedVars, -1, ev.name, ev.addr);
          if (ev.line) currentLine = ev.line;
          break;

        case 'var_decl':
          if (callStack.length) {
            var curTopF = callStack.length - 1;
            var refInfo = resolveRefInfo(callStack, globals, ev.addr, ev.name, curTopF);
            callStack[curTopF].vars[ev.name] = {
              type: ev.type,
              val: ev.val,
              addr: ev.addr,
              refVar: refInfo ? refInfo.refVar : null,
              refBaseVar: refInfo ? refInfo.refBaseVar : null,
              refFrameIdx: refInfo ? refInfo.refFrameIdx : null
            };
            if (isLast) markVarChanged(changedVars, curTopF, ev.name, ev.addr);
          }
          if (ev.line) currentLine = ev.line;
          if (callStack.length && ev.line) callStack[callStack.length - 1].line = ev.line;
          break;

        case 'var_end':
          for (var f = callStack.length - 1; f >= 0; f--) {
            if (callStack[f].vars[ev.name] !== undefined) {
              delete callStack[f].vars[ev.name];
              break;
            }
          }
          break;

        case 'var_set':
        case 'var_step':
          var found = false;
          var targetAddr = ev.addr;
          for (var f = callStack.length - 1; f >= 0; f--) {
            if (callStack[f].vars[ev.name] !== undefined) {
              var prevVal = callStack[f].vars[ev.name].val;
              callStack[f].vars[ev.name].val = ev.val;
              if (ev.addr) callStack[f].vars[ev.name].addr = ev.addr;
              else targetAddr = callStack[f].vars[ev.name].addr;
              if (isLast) {
                markVarChanged(changedVars, f, ev.name, targetAddr);
                recordElementDiff(changedVars, f + ':' + ev.name, prevVal, ev.val);
              }
              found = true;
              break;
            }
          }
          if (!found && globals[ev.name] !== undefined) {
            var prevGVal = globals[ev.name].val;
            globals[ev.name].val = ev.val;
            if (ev.addr) globals[ev.name].addr = ev.addr;
            else targetAddr = globals[ev.name].addr;
            if (isLast) {
              markVarChanged(changedVars, -1, ev.name, targetAddr);
              recordElementDiff(changedVars, '-1:' + ev.name, prevGVal, ev.val);
            }
            found = true;
          }
          if (!found && callStack.length) {
            var curTopF = callStack.length - 1;
            callStack[curTopF].vars[ev.name] = { type: ev.type || 'auto', val: ev.val, addr: ev.addr };
            if (isLast) markVarChanged(changedVars, curTopF, ev.name, ev.addr);
          }
          if (targetAddr) {
            syncAliasedVars(callStack, globals, targetAddr, ev.val, changedVars, isLast);
          }
          if (ev.line) currentLine = ev.line;
          if (callStack.length && ev.line) callStack[callStack.length - 1].line = ev.line;
          break;

        case 'var_step2':
          var found1 = false;
          var targetAddr1 = ev.addr1;
          for (var f = callStack.length - 1; f >= 0; f--) {
            if (callStack[f].vars[ev.name1] !== undefined) {
              callStack[f].vars[ev.name1].val = ev.val1;
              if (ev.addr1) callStack[f].vars[ev.name1].addr = ev.addr1;
              else targetAddr1 = callStack[f].vars[ev.name1].addr;
              if (isLast) markVarChanged(changedVars, f, ev.name1, targetAddr1);
              found1 = true;
              break;
            }
          }
          if (!found1 && callStack.length) {
            var curTopF = callStack.length - 1;
            callStack[curTopF].vars[ev.name1] = { type: ev.type1 || 'auto', val: ev.val1, addr: ev.addr1 };
            if (isLast) markVarChanged(changedVars, curTopF, ev.name1, ev.addr1);
          }
          if (targetAddr1) {
            syncAliasedVars(callStack, globals, targetAddr1, ev.val1, changedVars, isLast);
          }

          var found2 = false;
          var targetAddr2 = ev.addr2;
          for (var f = callStack.length - 1; f >= 0; f--) {
            if (callStack[f].vars[ev.name2] !== undefined) {
              callStack[f].vars[ev.name2].val = ev.val2;
              if (ev.addr2) callStack[f].vars[ev.name2].addr = ev.addr2;
              else targetAddr2 = callStack[f].vars[ev.name2].addr;
              if (isLast) markVarChanged(changedVars, f, ev.name2, targetAddr2);
              found2 = true;
              break;
            }
          }
          if (!found2 && callStack.length) {
            var curTopF = callStack.length - 1;
            callStack[curTopF].vars[ev.name2] = { type: ev.type2 || 'auto', val: ev.val2, addr: ev.addr2 };
            if (isLast) markVarChanged(changedVars, curTopF, ev.name2, ev.addr2);
          }
          if (targetAddr2) {
            syncAliasedVars(callStack, globals, targetAddr2, ev.val2, changedVars, isLast);
          }

          if (ev.line) currentLine = ev.line;
          if (callStack.length && ev.line) callStack[callStack.length - 1].line = ev.line;
          break;

        case 'for_cond':
          if (ev.name) {
            var found = false;
            var targetAddr = ev.addr;
            for (var f = callStack.length - 1; f >= 0; f--) {
              if (callStack[f].vars[ev.name] !== undefined) {
                callStack[f].vars[ev.name].val = ev.val;
                if (ev.addr) callStack[f].vars[ev.name].addr = ev.addr;
                else targetAddr = callStack[f].vars[ev.name].addr;
                if (isLast) markVarChanged(changedVars, f, ev.name, targetAddr);
                found = true;
                break;
              }
            }
            if (!found && globals[ev.name] !== undefined) {
              globals[ev.name].val = ev.val;
              if (ev.addr) globals[ev.name].addr = ev.addr;
              else targetAddr = globals[ev.name].addr;
              if (isLast) markVarChanged(changedVars, -1, ev.name, targetAddr);
              found = true;
            }
            if (!found && callStack.length) {
              var curTopF = callStack.length - 1;
              callStack[curTopF].vars[ev.name] = { type: ev.type || 'auto', val: ev.val, addr: ev.addr };
              if (isLast) markVarChanged(changedVars, curTopF, ev.name, ev.addr);
            }
            if (targetAddr) {
              syncAliasedVars(callStack, globals, targetAddr, ev.val, changedVars, isLast);
            }
          }
          if (ev.line) currentLine = ev.line;
          if (callStack.length && ev.line) callStack[callStack.length - 1].line = ev.line;
          break;

        case 'for_cond2':
          if (ev.name1) {
            var found1 = false;
            var targetAddr1 = ev.addr1;
            for (var f = callStack.length - 1; f >= 0; f--) {
              if (callStack[f].vars[ev.name1] !== undefined) {
                callStack[f].vars[ev.name1].val = ev.val1;
                if (ev.addr1) callStack[f].vars[ev.name1].addr = ev.addr1;
                else targetAddr1 = callStack[f].vars[ev.name1].addr;
                if (isLast) markVarChanged(changedVars, f, ev.name1, targetAddr1);
                found1 = true;
                break;
              }
            }
            if (!found1 && callStack.length) {
              var curTopF = callStack.length - 1;
              callStack[curTopF].vars[ev.name1] = { type: ev.type1 || 'auto', val: ev.val1, addr: ev.addr1 };
              if (isLast) markVarChanged(changedVars, curTopF, ev.name1, ev.addr1);
            }
            if (targetAddr1) {
              syncAliasedVars(callStack, globals, targetAddr1, ev.val1, changedVars, isLast);
            }
          }
          if (ev.name2) {
            var found2 = false;
            var targetAddr2 = ev.addr2;
            for (var f = callStack.length - 1; f >= 0; f--) {
              if (callStack[f].vars[ev.name2] !== undefined) {
                callStack[f].vars[ev.name2].val = ev.val2;
                if (ev.addr2) callStack[f].vars[ev.name2].addr = ev.addr2;
                else targetAddr2 = callStack[f].vars[ev.name2].addr;
                if (isLast) markVarChanged(changedVars, f, ev.name2, targetAddr2);
                found2 = true;
                break;
              }
            }
            if (!found2 && callStack.length) {
              var curTopF = callStack.length - 1;
              callStack[curTopF].vars[ev.name2] = { type: ev.type2 || 'auto', val: ev.val2, addr: ev.addr2 };
              if (isLast) markVarChanged(changedVars, curTopF, ev.name2, ev.addr2);
            }
            if (targetAddr2) {
              syncAliasedVars(callStack, globals, targetAddr2, ev.val2, changedVars, isLast);
            }
          }
          if (ev.line) currentLine = ev.line;
          if (callStack.length && ev.line) callStack[callStack.length - 1].line = ev.line;
          break;

        case 'line':
          currentLine = ev.line;
          if (callStack.length) callStack[callStack.length - 1].line = ev.line;
          break;

        case 'io':
          if (ev.name) {
            var found = false;
            var targetAddr = ev.addr;
            for (var f = callStack.length - 1; f >= 0; f--) {
              if (callStack[f].vars[ev.name] !== undefined) {
                var prevVal = callStack[f].vars[ev.name].val;
                callStack[f].vars[ev.name].val = ev.val;
                if (ev.addr) callStack[f].vars[ev.name].addr = ev.addr;
                else targetAddr = callStack[f].vars[ev.name].addr;
                if (isLast) {
                  markVarChanged(changedVars, f, ev.name, targetAddr);
                  recordElementDiff(changedVars, f + ':' + ev.name, prevVal, ev.val);
                }
                found = true;
                break;
              }
            }
            if (!found && globals[ev.name] !== undefined) {
              var prevGVal = globals[ev.name].val;
              globals[ev.name].val = ev.val;
              if (ev.addr) globals[ev.name].addr = ev.addr;
              else targetAddr = globals[ev.name].addr;
              if (isLast) {
                markVarChanged(changedVars, -1, ev.name, targetAddr);
                recordElementDiff(changedVars, '-1:' + ev.name, prevGVal, ev.val);
              }
              found = true;
            }
            if (!found && callStack.length) {
              var curTopF = callStack.length - 1;
              callStack[curTopF].vars[ev.name] = { type: ev.type || 'auto', val: ev.val, addr: ev.addr };
              if (isLast) markVarChanged(changedVars, curTopF, ev.name, ev.addr);
            }
            if (targetAddr) {
              syncAliasedVars(callStack, globals, targetAddr, ev.val, changedVars, isLast);
            }
          }
          if (ev.line) currentLine = ev.line;
          if (callStack.length && ev.line) callStack[callStack.length - 1].line = ev.line;
          break;

        case 'scope_enter':
          if (ev.line) currentLine = ev.line;
          if (callStack.length && ev.line) callStack[callStack.length - 1].line = ev.line;
          break;

        case 'scope_exit':
          if (ev.line) currentLine = ev.line;
          if (callStack.length && ev.line) callStack[callStack.length - 1].line = ev.line;
          if (ev.vars && callStack.length) {
            var topFrame = callStack[callStack.length - 1];
            for (var vi = 0; vi < ev.vars.length; vi++) {
              delete topFrame.vars[ev.vars[vi]];
            }
          }
          break;
      }

      if (ev.endVars && i < step) {
        for (var evIdx = 0; evIdx < ev.endVars.length; evIdx++) {
          var evName = ev.endVars[evIdx];
          for (var f = callStack.length - 1; f >= 0; f--) {
            if (callStack[f].vars[evName] !== undefined) {
              delete callStack[f].vars[evName];
              break;
            }
          }
        }
      }
    }

    return { callStack: callStack, globals: globals, currentLine: currentLine, changedVars: changedVars };
  }

  /** Deep-clone a variables map { [name]: { type, val, addr, refVar, refFrameIdx } }. */
  function deepCloneVars(vars) {
    var out = {};
    if (!vars) return out;
    for (var k in vars) {
      if (vars.hasOwnProperty(k)) {
        var v = vars[k];
        out[k] = {
          type: v.type,
          val: v.val,
          addr: v.addr,
          refVar: v.refVar,
          refFrameIdx: v.refFrameIdx
        };
      }
    }
    return out;
  }

  /** Deep-clone a call stack array (frames + vars objects). */
  function deepCloneStack(stack) {
    var out = [];
    for (var i = 0; i < stack.length; i++) {
      var fr = stack[i];
      out.push({
        name: fr.name,
        params: fr.params,
        line: fr.line,
        depth: fr.depth,
        vars: deepCloneVars(fr.vars)
      });
    }
    return out;
  }

  // ── DOM helpers ───────────────────────────────────────────────────────

  function el(tag, cls, attrs) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (attrs) {
      for (var k in attrs) {
        if (attrs.hasOwnProperty(k)) {
          if (k === 'textContent') e.textContent = attrs[k];
          else e.setAttribute(k, attrs[k]);
        }
      }
    }
    return e;
  }

  function btn(label, title, cls) {
    var b = el('button', 'viz-btn' + (cls ? ' ' + cls : ''), { title: title || '' });
    b.textContent = label;
    return b;
  }

  // ── Snapshot cache ────────────────────────────────────────────────────

  var SNAPSHOT_INTERVAL = 100;

  function SnapshotCache() {
    this._cache = {};  // step -> { callStack, currentLine }
  }
  SnapshotCache.prototype.clear = function () { this._cache = {}; };
  SnapshotCache.prototype.get = function (step) { return this._cache[step] || null; };
  SnapshotCache.prototype.set = function (step, state) {
    this._cache[step] = {
      callStack: deepCloneStack(state.callStack),
      globals: deepCloneVars(state.globals || {}),
      currentLine: state.currentLine
    };
  };
  /**
   * Find the best cached snapshot at or before `step`.
   * Returns { snapshot, startIndex } or null.
   */
  SnapshotCache.prototype.closest = function (step) {
    var best = -1;
    for (var k in this._cache) {
      if (this._cache.hasOwnProperty(k)) {
        var n = +k;
        if (n <= step && n > best) best = n;
      }
    }
    if (best < 0) return null;
    return { snapshot: this._cache[best], startIndex: best + 1 };
  };

  // ── Create visualizer instance ────────────────────────────────────────

  /**
   * Create a visualizer instance rendering into the given DOM container.
   * @param {HTMLElement} container
   * @returns {object} Visualizer instance with load, step*, goToStep, etc.
   */
  function create(container) {
    injectStyles();

    // ── State ─────────────────────────
    var events = [];
    var initialGlobals = {};
    var lineMap = null;
    var step = -1;
    var totalSteps = 0;
    var listeners = [];
    var snapshots = new SnapshotCache();
    var highlightTimers = [];

    // ── Build DOM ─────────────────────
    var panel = el('div', 'viz-panel');

    // Controls
    var controls = el('div', 'viz-controls');
    var btnReset    = btn('\u275A\u25C0', 'Reset');
    var btnBack     = btn('\u25C0', 'Step Back');
    var btnInto     = btn('Next Step', 'Next Step', 'viz-primary');
    var btnOver     = btn('Step Over', 'Step Over');
    var btnOut      = btn('Step Out', 'Step Out');
    var btnEnd      = btn('\u25B6\u275A', 'Run to End');
    var stepInfo    = el('span', 'viz-step-info');
    stepInfo.textContent = 'Step 0 / 0';
    var slider = el('input', 'viz-slider', { type: 'range', min: '0', max: '0', value: '0' });
    var btnClose    = el('button', 'viz-btn viz-close', { title: 'Close Visualizer', type: 'button' });
    btnClose.textContent = '\u2715';

    controls.appendChild(btnReset);
    controls.appendChild(btnBack);
    controls.appendChild(btnInto);
    controls.appendChild(btnOver);
    controls.appendChild(btnOut);
    controls.appendChild(btnEnd);
    controls.appendChild(stepInfo);
    controls.appendChild(slider);
    controls.appendChild(btnClose);

    // Body
    var body = el('div', 'viz-body');

    // Call stack
    var stackPane = el('div', 'viz-stack');
    var stackH3 = el('h3'); stackH3.textContent = 'Call Stack';
    var stackList = el('ul', 'viz-stack-list');
    stackPane.appendChild(stackH3);
    stackPane.appendChild(stackList);

    // Resizer splitter between Call Stack and Variables
    var splitResizer = el('div', 'viz-split-resizer', {
      role: 'separator',
      'aria-orientation': 'vertical',
      tabindex: '0',
      title: 'Drag to resize Call Stack and Variables (double-click to reset)'
    });

    // Variables
    var varsPane = el('div', 'viz-vars');
    var varsH3 = el('h3'); varsH3.textContent = 'Variables';
    var varsContent = el('div', 'viz-vars-content');
    varsPane.appendChild(varsH3);
    varsPane.appendChild(varsContent);

    body.appendChild(stackPane);
    body.appendChild(splitResizer);
    body.appendChild(varsPane);

    // ── Resizer logic for Call Stack & Variables ──
    var DEFAULT_STACK_WIDTH = 220;
    var MIN_STACK_WIDTH = 90;
    var MIN_VARS_WIDTH = 130;

    var savedStackWidth = null;
    try {
      var sVal = localStorage.getItem('cppwasm.vizStackWidth');
      if (sVal) {
        var pVal = parseInt(sVal, 10);
        if (!isNaN(pVal) && pVal >= MIN_STACK_WIDTH) savedStackWidth = pVal;
      }
    } catch (_) {}

    var stackWidth = (savedStackWidth !== null) ? savedStackWidth : DEFAULT_STACK_WIDTH;

    function applyStackWidth() {
      stackPane.style.width = stackWidth + 'px';
      body.style.setProperty('--viz-stack-width', stackWidth + 'px');
      drawRefArrows();
    }

    applyStackWidth();

    (function () {
      var isDragging = false;

      splitResizer.addEventListener('pointerdown', function (e) {
        if (e.button !== 0) return;
        isDragging = true;
        try { splitResizer.setPointerCapture(e.pointerId); } catch (_) {}
        splitResizer.classList.add('dragging');
        document.body.classList.add('resizing-panels');
        e.preventDefault();
      });

      splitResizer.addEventListener('pointermove', function (e) {
        if (!isDragging) return;
        var bodyRect = body.getBoundingClientRect();
        var newWidth = Math.round(e.clientX - bodyRect.left);
        var maxStackW = bodyRect.width - MIN_VARS_WIDTH - 8;
        stackWidth = Math.max(MIN_STACK_WIDTH, Math.min(newWidth, Math.max(MIN_STACK_WIDTH, maxStackW)));
        applyStackWidth();
      });

      var stopDrag = function (e) {
        if (!isDragging) return;
        isDragging = false;
        try { splitResizer.releasePointerCapture(e.pointerId); } catch (_) {}
        splitResizer.classList.remove('dragging');
        document.body.classList.remove('resizing-panels');
        try {
          localStorage.setItem('cppwasm.vizStackWidth', String(stackWidth));
        } catch (_) {}
        drawRefArrows();
      };

      splitResizer.addEventListener('pointerup', stopDrag);
      splitResizer.addEventListener('pointercancel', stopDrag);

      splitResizer.addEventListener('dblclick', function () {
        stackWidth = DEFAULT_STACK_WIDTH;
        applyStackWidth();
        try {
          localStorage.setItem('cppwasm.vizStackWidth', String(stackWidth));
        } catch (_) {}
      });

      splitResizer.addEventListener('keydown', function (e) {
        var delta = (e.shiftKey ? 32 : 12);
        if (e.key === 'ArrowLeft') {
          stackWidth = Math.max(MIN_STACK_WIDTH, stackWidth - delta);
          applyStackWidth();
          try { localStorage.setItem('cppwasm.vizStackWidth', String(stackWidth)); } catch (_) {}
          e.preventDefault();
        } else if (e.key === 'ArrowRight') {
          var bodyRect = body.getBoundingClientRect();
          var maxStackW = bodyRect.width - MIN_VARS_WIDTH - 8;
          stackWidth = Math.min(maxStackW, stackWidth + delta);
          applyStackWidth();
          try { localStorage.setItem('cppwasm.vizStackWidth', String(stackWidth)); } catch (_) {}
          e.preventDefault();
        }
      });
    })();

    // IO Section (Input & Output with tabs)
    var ioPane = el('div', 'viz-io');
    var ioTabs = el('div', 'viz-io-tabs');
    var tabOutput = el('button', 'viz-io-tab active', { type: 'button' });
    tabOutput.textContent = 'Output';
    var tabInput = el('button', 'viz-io-tab', { type: 'button' });
    tabInput.textContent = 'Input';
    ioTabs.appendChild(tabOutput);
    ioTabs.appendChild(tabInput);

    var ioContent = el('div', 'viz-io-content');
    var outputPre = el('pre', 'viz-output-text');
    var inputPre  = el('pre', 'viz-output-text');
    inputPre.style.display = 'none';

    ioContent.appendChild(outputPre);
    ioContent.appendChild(inputPre);
    ioPane.appendChild(ioTabs);
    ioPane.appendChild(ioContent);

    var currentTab = 'output';
    tabOutput.addEventListener('click', function () {
      currentTab = 'output';
      tabOutput.className = 'viz-io-tab active';
      tabInput.className = 'viz-io-tab';
      outputPre.style.display = '';
      inputPre.style.display = 'none';
    });
    tabInput.addEventListener('click', function () {
      currentTab = 'input';
      tabInput.className = 'viz-io-tab active';
      tabOutput.className = 'viz-io-tab';
      outputPre.style.display = 'none';
      inputPre.style.display = '';
    });

    // Empty state
    var emptyState = el('div', 'viz-empty');
    emptyState.textContent = 'No trace loaded. Run with visualization enabled.';

    panel.appendChild(controls);
    panel.appendChild(body);
    panel.appendChild(ioPane);

    container.appendChild(panel);

    // ── Event handlers ────────────────

    var closeListeners = [];
    btnClose.addEventListener('click', function () {
      for (var i = 0; i < closeListeners.length; i++) {
        try { closeListeners[i](); } catch (_) {}
      }
    });

    btnReset.addEventListener('click', function () { goToStep(0); });
    btnBack.addEventListener('click', function () { stepBack(); });
    btnInto.addEventListener('click', function () { stepForward(); });
    btnOver.addEventListener('click', function () { stepOverFn(); });
    btnOut.addEventListener('click', function () { stepOutFn(); });
    btnEnd.addEventListener('click', function () { goToStep(totalSteps - 1); });

    slider.addEventListener('input', function () {
      goToStep(parseInt(slider.value, 10));
    });

    // Keyboard shortcuts when panel is focused.
    panel.setAttribute('tabindex', '0');
    panel.addEventListener('keydown', function (e) {
      if (e.target.tagName === 'INPUT') return;
      switch (e.key) {
        case 'ArrowRight': case 'l': stepForward(); e.preventDefault(); break;
        case 'ArrowLeft':  case 'h': stepBack();    e.preventDefault(); break;
        case 'Home': goToStep(0); e.preventDefault(); break;
        case 'End':  goToStep(totalSteps - 1); e.preventDefault(); break;
      }
    });

    // ── Reference parameter arrows ───

    var arrowsSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    arrowsSvg.setAttribute('class', 'viz-ref-arrows-svg');
    varsContent.addEventListener('scroll', function () { drawRefArrows(); }, { passive: true });
    window.addEventListener('resize', function () { drawRefArrows(); }, { passive: true });

    function drawRefArrows() {
      if (!arrowsSvg || !varsContent || !panel.isConnected) return;
      arrowsSvg.innerHTML = '';

      var refRows = varsContent.querySelectorAll('tr[data-ref-var]');
      if (!refRows.length) return;

      var cRect = varsContent.getBoundingClientRect();
      var sTop = varsContent.scrollTop;
      var sLeft = varsContent.scrollLeft;

      var scrollW = Math.max(varsContent.scrollWidth, varsContent.clientWidth);
      var scrollH = Math.max(varsContent.scrollHeight, varsContent.clientHeight);
      arrowsSvg.style.width = scrollW + 'px';
      arrowsSvg.style.height = scrollH + 'px';
      arrowsSvg.setAttribute('viewBox', '0 0 ' + scrollW + ' ' + scrollH);

      var defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
      arrowsSvg.appendChild(defs);

      var colors = ['#1c7ed6', '#e8590c', '#2f9e44', '#ae3ec9', '#d6336c', '#0c8599', '#f59f00', '#20c997'];

      // Dynamically adjust right padding to ensure adequate gutter for all reference arrows
      var gutter = Math.max(36, 24 + (refRows.length * 16));
      varsContent.style.paddingRight = gutter + 'px';

      // Find the absolute rightmost edge of all variable content (tables, rows, array grids)
      var maxContentX = 0;
      var contentElements = varsContent.querySelectorAll('tr, .viz-vars-table, .viz-array-view');
      contentElements.forEach(function (el) {
        var r = el.getBoundingClientRect();
        if (r.width > 0) {
          var rx = r.right - cRect.left + sLeft;
          if (rx > maxContentX) maxContentX = rx;
        }
      });
      var visibleRightX = varsContent.clientWidth + sLeft - gutter;
      var baselineRight = Math.max(maxContentX + 10, visibleRightX + 6);

      refRows.forEach(function (srcTr, idx) {
        var refVarName = srcTr.dataset.refVar;
        var refBaseVar = srcTr.dataset.refBaseVar || (refVarName ? refVarName.replace(/\[.*$/, '') : '');
        var refFrame = srcTr.dataset.refFrame;

        var targetTr = null;
        if (refFrame === '-1') {
          targetTr = varsContent.querySelector('tr[data-frame="-1"][data-var="' + refBaseVar + '"]');
        } else {
          targetTr = varsContent.querySelector('tr[data-frame="' + refFrame + '"][data-var="' + refBaseVar + '"]');
        }
        if (!targetTr) {
          var candidates = varsContent.querySelectorAll('tr[data-var="' + refBaseVar + '"]');
          for (var ci = 0; ci < candidates.length; ci++) {
            if (candidates[ci] !== srcTr) {
              targetTr = candidates[ci];
              break;
            }
          }
        }

        if (!targetTr) {
          var valTd = srcTr.querySelector('td.viz-var-val');
          if (valTd && !valTd.textContent.includes('\u2192')) {
            valTd.textContent += ' (\u2192 ' + refVarName + ')';
          }
          return;
        }

        var color = colors[idx % colors.length];
        var markerId = 'viz-ref-arrow-' + idx;
        var marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
        marker.setAttribute('id', markerId);
        marker.setAttribute('viewBox', '0 0 8 8');
        marker.setAttribute('refX', '7');
        marker.setAttribute('refY', '4');
        marker.setAttribute('markerWidth', '7');
        marker.setAttribute('markerHeight', '7');
        marker.setAttribute('orient', 'auto');

        var markerPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        markerPath.setAttribute('d', 'M 0 1 L 7 4 L 0 7 z');
        markerPath.setAttribute('fill', color);
        marker.appendChild(markerPath);
        defs.appendChild(marker);

        var srcAnchor = srcTr.querySelector('.viz-ref-anchor-dot') || srcTr.querySelector('td:last-child') || srcTr;
        var tgtAnchor = targetTr.querySelector('.viz-ref-target-hook') || targetTr.querySelector('td:last-child') || targetTr;

        var sRect = srcAnchor.getBoundingClientRect();
        var tRect = tgtAnchor.getBoundingClientRect();

        var x1 = sRect.right - cRect.left + sLeft + 3;
        var y1 = sRect.top - cRect.top + sTop + sRect.height / 2;

        var x2 = tRect.right - cRect.left + sLeft + 3;
        var y2 = tRect.top - cRect.top + sTop + tRect.height / 2;

        var r = 8;
        var offset = 10 + (idx * 16);
        // Position vertical trunk strictly in the rightmost gutter beyond all content
        var maxX = baselineRight + offset;
        if (maxX + 20 > scrollW) {
          scrollW = maxX + 20;
          arrowsSvg.style.width = scrollW + 'px';
          arrowsSvg.setAttribute('viewBox', '0 0 ' + scrollW + ' ' + scrollH);
        }

        var d;
        if (Math.abs(y1 - y2) < 4) {
          d = 'M ' + x1 + ' ' + y1 + ' L ' + (x2 + 2) + ' ' + y2;
        } else if (y1 < y2) {
          d = 'M ' + x1 + ' ' + y1 +
              ' L ' + (maxX - r) + ' ' + y1 +
              ' A ' + r + ' ' + r + ' 0 0 1 ' + maxX + ' ' + (y1 + r) +
              ' L ' + maxX + ' ' + (y2 - r) +
              ' A ' + r + ' ' + r + ' 0 0 1 ' + (maxX - r) + ' ' + y2 +
              ' L ' + (x2 + 2) + ' ' + y2;
        } else {
          d = 'M ' + x1 + ' ' + y1 +
              ' L ' + (maxX - r) + ' ' + y1 +
              ' A ' + r + ' ' + r + ' 0 0 0 ' + maxX + ' ' + (y1 - r) +
              ' L ' + maxX + ' ' + (y2 + r) +
              ' A ' + r + ' ' + r + ' 0 0 0 ' + (maxX - r) + ' ' + y2 +
              ' L ' + (x2 + 2) + ' ' + y2;
        }

        var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', d);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', color);
        path.setAttribute('stroke-width', '2');
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('stroke-linejoin', 'round');
        path.setAttribute('marker-end', 'url(#' + markerId + ')');
        path.setAttribute('class', 'viz-ref-arrow-path');

        var titleEl = document.createElementNS('http://www.w3.org/2000/svg', 'title');
        titleEl.textContent = srcTr.dataset.var + ' \u2192 ' + refVarName;
        path.appendChild(titleEl);

        var circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', x1);
        circle.setAttribute('cy', y1);
        circle.setAttribute('r', '3');
        circle.setAttribute('fill', color);

        arrowsSvg.appendChild(path);
        arrowsSvg.appendChild(circle);

        var srcDot = srcTr.querySelector('.viz-ref-anchor-dot');
        if (srcDot) {
          srcDot.style.backgroundColor = color;
        }

        function setHighlight(on) {
          path.setAttribute('stroke-width', on ? '3.5' : '2');
          if (on) {
            path.setAttribute('filter', 'drop-shadow(0 0 3px ' + color + ')');
            srcTr.style.backgroundColor = color + '22';
            targetTr.style.backgroundColor = color + '22';
          } else {
            path.removeAttribute('filter');
            srcTr.style.backgroundColor = '';
            targetTr.style.backgroundColor = '';
          }
        }

        srcTr.addEventListener('mouseenter', function () { setHighlight(true); });
        srcTr.addEventListener('mouseleave', function () { setHighlight(false); });
        targetTr.addEventListener('mouseenter', function () { setHighlight(true); });
        targetTr.addEventListener('mouseleave', function () { setHighlight(false); });
      });
    }

    // ── Rendering ─────────────────────

    function formatVarValue(val) {
      if (typeof val !== 'string') return String(val || '');
      if (val.startsWith('[[') && val.endsWith(']]')) {
        return val.replace(/\], ?\[/g, '],\n [');
      }
      return val;
    }

    function formatCellScalar(val) {
      if (val === null || val === undefined) return '-';
      if (typeof val === 'string') return val;
      if (typeof val === 'boolean') return val ? 'true' : 'false';
      return String(val);
    }

    function renderVarValue(container, vname, valStr, typeStr, elemDiff) {
      var arr = parseArrayValue(valStr);
      if (!arr) {
        var valSpan = document.createElement('span');
        valSpan.className = 'viz-val-text';
        valSpan.textContent = formatVarValue(valStr);
        container.appendChild(valSpan);
        return;
      }

      var dim = getArrayDimension(arr);
      var viewDiv = document.createElement('div');
      viewDiv.className = 'viz-array-view';

      // 1. Toolbar
      var toolbar = document.createElement('div');
      toolbar.className = 'viz-array-toolbar';

      // Explore section
      var exploreDiv = document.createElement('div');
      exploreDiv.className = 'viz-array-explore';

      var inputsRow = document.createElement('div');
      inputsRow.className = 'viz-array-inputs-row';

      var exploreLbl = document.createElement('span');
      exploreLbl.className = 'viz-explorer-label';
      exploreLbl.textContent = 'idx:';
      inputsRow.appendChild(exploreLbl);

      var inputIdx1 = null;
      var inputIdx2 = null;
      var inputIdx3 = null;

      if (dim === 1) {
        inputIdx1 = document.createElement('input');
        inputIdx1.type = 'number';
        inputIdx1.className = 'viz-idx-input viz-idx-1d';
        inputIdx1.min = '0';
        inputIdx1.max = String(Math.max(0, arr.length - 1));
        inputIdx1.placeholder = 'i';
        inputIdx1.title = 'Index [i]';
        inputsRow.appendChild(inputIdx1);
      } else if (dim === 2) {
        inputIdx1 = document.createElement('input');
        inputIdx1.type = 'number';
        inputIdx1.className = 'viz-idx-input viz-idx-r';
        inputIdx1.min = '0';
        inputIdx1.max = String(Math.max(0, arr.length - 1));
        inputIdx1.placeholder = 'r';
        inputIdx1.title = 'Row [r]';
        inputsRow.appendChild(inputIdx1);

        inputIdx2 = document.createElement('input');
        inputIdx2.type = 'number';
        inputIdx2.className = 'viz-idx-input viz-idx-c';
        inputIdx2.min = '0';
        var maxCol = arr[0] ? arr[0].length - 1 : 0;
        inputIdx2.max = String(Math.max(0, maxCol));
        inputIdx2.placeholder = 'c';
        inputIdx2.title = 'Col [c]';
        inputsRow.appendChild(inputIdx2);
      } else if (dim === 3) {
        inputIdx1 = document.createElement('input');
        inputIdx1.type = 'number';
        inputIdx1.className = 'viz-idx-input';
        inputIdx1.min = '0';
        inputIdx1.max = String(Math.max(0, arr.length - 1));
        inputIdx1.placeholder = 'd1';
        inputsRow.appendChild(inputIdx1);

        inputIdx2 = document.createElement('input');
        inputIdx2.type = 'number';
        inputIdx2.className = 'viz-idx-input';
        inputIdx2.min = '0';
        var maxD2 = arr[0] ? arr[0].length - 1 : 0;
        inputIdx2.max = String(Math.max(0, maxD2));
        inputIdx2.placeholder = 'd2';
        inputsRow.appendChild(inputIdx2);

        inputIdx3 = document.createElement('input');
        inputIdx3.type = 'number';
        inputIdx3.className = 'viz-idx-input';
        inputIdx3.min = '0';
        var maxD3 = (arr[0] && arr[0][0]) ? arr[0][0].length - 1 : 0;
        inputIdx3.max = String(Math.max(0, maxD3));
        inputIdx3.placeholder = 'd3';
        inputsRow.appendChild(inputIdx3);
      }

      var toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'viz-view-toggle-btn';
      toggleBtn.textContent = 'Raw';
      toggleBtn.title = 'Toggle raw / tabular view';
      inputsRow.appendChild(toggleBtn);

      exploreDiv.appendChild(inputsRow);

      // Inspect row directly underneath index field
      var defaultBadgeText = dim === 1
        ? (vname + '[i]')
        : (dim === 2 ? (vname + '[r][c]') : (vname + '[d1][d2][d3]'));

      var inspectRow = document.createElement('div');
      inspectRow.className = 'viz-inspect-row';

      var inspectBadge = document.createElement('span');
      inspectBadge.className = 'viz-inspect-badge viz-inspect-idle';
      inspectBadge.textContent = defaultBadgeText;
      inspectRow.appendChild(inspectBadge);

      exploreDiv.appendChild(inspectRow);
      toolbar.appendChild(exploreDiv);
      viewDiv.appendChild(toolbar);

      // 2. Tabular Table Wrapper
      var tableWrapper = document.createElement('div');
      tableWrapper.className = 'viz-array-table-wrapper';

      // 3. Raw view wrapper (hidden initially)
      var rawPre = document.createElement('pre');
      rawPre.className = 'viz-array-raw-view';
      rawPre.style.display = 'none';
      rawPre.textContent = formatVarValue(valStr);

      var currentInspectedCell = null;

      function highlightCell(cell, exprText) {
        if (currentInspectedCell && currentInspectedCell !== cell) {
          currentInspectedCell.classList.remove('viz-cell-inspected');
        }
        currentInspectedCell = cell;
        if (cell) {
          cell.classList.add('viz-cell-inspected');
        }
        if (exprText) {
          inspectBadge.textContent = exprText;
          inspectBadge.classList.remove('viz-inspect-idle');
        } else {
          inspectBadge.textContent = defaultBadgeText;
          inspectBadge.classList.add('viz-inspect-idle');
        }
      }

      function clearInspection() {
        if (currentInspectedCell) {
          currentInspectedCell.classList.remove('viz-cell-inspected');
          currentInspectedCell = null;
        }
        inspectBadge.textContent = defaultBadgeText;
        inspectBadge.classList.add('viz-inspect-idle');
        var activeEl = (typeof document !== 'undefined') ? document.activeElement : null;
        if (inputIdx1 && activeEl !== inputIdx1) {
          inputIdx1.value = '';
        }
        if (inputIdx2 && activeEl !== inputIdx2) {
          inputIdx2.value = '';
        }
        if (inputIdx3 && activeEl !== inputIdx3) {
          inputIdx3.value = '';
        }
      }

      function updateExploreFromInputs() {
        if (dim === 1) {
          var iVal = parseInt(inputIdx1.value, 10);
          if (!isNaN(iVal) && iVal >= 0 && iVal < arr.length) {
            var targetCell = tableWrapper.querySelector('.viz-cell-val[data-idx="' + iVal + '"]');
            highlightCell(targetCell, vname + '[' + iVal + '] = ' + formatCellScalar(arr[iVal]));
          } else {
            highlightCell(null, '');
          }
        } else if (dim === 2) {
          var rVal = parseInt(inputIdx1.value, 10);
          var cVal = parseInt(inputIdx2.value, 10);
          if (!isNaN(rVal) && !isNaN(cVal) && rVal >= 0 && rVal < arr.length && arr[rVal] && cVal >= 0 && cVal < arr[rVal].length) {
            var targetCell2 = tableWrapper.querySelector('.viz-cell-val[data-row="' + rVal + '"][data-col="' + cVal + '"]');
            highlightCell(targetCell2, vname + '[' + rVal + '][' + cVal + '] = ' + formatCellScalar(arr[rVal][cVal]));
          } else {
            highlightCell(null, '');
          }
        } else if (dim === 3) {
          var d1Val = parseInt(inputIdx1.value, 10);
          var d2Val = parseInt(inputIdx2.value, 10);
          var d3Val = parseInt(inputIdx3.value, 10);
          if (!isNaN(d1Val) && !isNaN(d2Val) && !isNaN(d3Val) && arr[d1Val] && arr[d1Val][d2Val] && arr[d1Val][d2Val][d3Val] !== undefined) {
            if (selectSlice) selectSlice(d1Val);
            var targetCell3 = tableWrapper.querySelector('.viz-cell-val[data-row="' + d2Val + '"][data-col="' + d3Val + '"]');
            highlightCell(targetCell3, vname + '[' + d1Val + '][' + d2Val + '][' + d3Val + '] = ' + formatCellScalar(arr[d1Val][d2Val][d3Val]));
          } else {
            highlightCell(null, '');
          }
        }
      }

      if (inputIdx1) inputIdx1.addEventListener('input', updateExploreFromInputs);
      if (inputIdx2) inputIdx2.addEventListener('input', updateExploreFromInputs);
      if (inputIdx3) inputIdx3.addEventListener('input', updateExploreFromInputs);

      toggleBtn.addEventListener('click', function () {
        if (rawPre.style.display === 'none') {
          rawPre.style.display = 'block';
          tableWrapper.style.display = 'none';
          toggleBtn.textContent = 'Table';
        } else {
          rawPre.style.display = 'none';
          tableWrapper.style.display = 'block';
          toggleBtn.textContent = 'Raw';
        }
      });

      var selectSlice = null;

      if (dim === 1) {
        var table1d = document.createElement('table');
        table1d.className = 'viz-array-table viz-1d-table';

        var thead = document.createElement('thead');
        var trIdx = document.createElement('tr');
        var thCorner = document.createElement('th');
        thCorner.className = 'viz-idx-corner';
        thCorner.textContent = 'i';
        trIdx.appendChild(thCorner);

        for (var ci = 0; ci < arr.length; ci++) {
          var th = document.createElement('th');
          th.className = 'viz-idx-th';
          th.textContent = '[' + ci + ']';
          trIdx.appendChild(th);
        }
        thead.appendChild(trIdx);
        table1d.appendChild(thead);

        var tbody = document.createElement('tbody');
        var trVal = document.createElement('tr');
        var tdValLbl = document.createElement('td');
        tdValLbl.className = 'viz-val-label';
        tdValLbl.textContent = 'val';
        trVal.appendChild(tdValLbl);

        for (var vi = 0; vi < arr.length; vi++) {
          var tdCell = document.createElement('td');
          tdCell.className = 'viz-cell-val';
          tdCell.dataset.idx = String(vi);
          tdCell.textContent = formatCellScalar(arr[vi]);
          if (elemDiff && elemDiff.has(String(vi))) {
            tdCell.classList.add('viz-cell-changed');
          }
          (function (idx, cellVal, cellEl) {
            cellEl.addEventListener('click', function () {
              if (inputIdx1) inputIdx1.value = String(idx);
              highlightCell(cellEl, vname + '[' + idx + '] = ' + formatCellScalar(cellVal));
            });
            cellEl.addEventListener('mouseenter', function () {
              if (inputIdx1 && document.activeElement !== inputIdx1) {
                inputIdx1.value = String(idx);
                highlightCell(cellEl, vname + '[' + idx + '] = ' + formatCellScalar(cellVal));
              }
            });
            cellEl.addEventListener('mouseleave', function () {
              clearInspection();
            });
          })(vi, arr[vi], tdCell);
          trVal.appendChild(tdCell);
        }
        tbody.appendChild(trVal);
        table1d.appendChild(tbody);
        tableWrapper.appendChild(table1d);

      } else if (dim === 2) {
        var table2d = document.createElement('table');
        table2d.className = 'viz-array-table viz-2d-table';

        var colCount = 0;
        for (var r = 0; r < arr.length; r++) {
          if (arr[r] && arr[r].length > colCount) colCount = arr[r].length;
        }

        var thead2d = document.createElement('thead');
        var trTop = document.createElement('tr');
        var thCorner2d = document.createElement('th');
        thCorner2d.className = 'viz-idx-corner';
        thCorner2d.textContent = 'r\\c';
        trTop.appendChild(thCorner2d);

        for (var c = 0; c < colCount; c++) {
          var thC = document.createElement('th');
          thC.className = 'viz-idx-th';
          thC.textContent = '[' + c + ']';
          trTop.appendChild(thC);
        }
        thead2d.appendChild(trTop);
        table2d.appendChild(thead2d);

        var tbody2d = document.createElement('tbody');
        for (var row = 0; row < arr.length; row++) {
          var trRow = document.createElement('tr');
          var thRow = document.createElement('th');
          thRow.className = 'viz-row-th';
          thRow.textContent = '[' + row + ']';
          trRow.appendChild(thRow);

          var rowArr = arr[row] || [];
          for (var col = 0; col < colCount; col++) {
            var td2d = document.createElement('td');
            td2d.className = 'viz-cell-val';
            td2d.dataset.row = String(row);
            td2d.dataset.col = String(col);
            var val2d = rowArr[col];
            td2d.textContent = formatCellScalar(val2d);
            if (elemDiff && elemDiff.has(row + ',' + col)) {
              td2d.classList.add('viz-cell-changed');
            }
            (function (rIdx, cIdx, cVal, el) {
              el.addEventListener('click', function () {
                if (inputIdx1) inputIdx1.value = String(rIdx);
                if (inputIdx2) inputIdx2.value = String(cIdx);
                highlightCell(el, vname + '[' + rIdx + '][' + cIdx + '] = ' + formatCellScalar(cVal));
              });
              el.addEventListener('mouseenter', function () {
                if (inputIdx1 && document.activeElement !== inputIdx1 && document.activeElement !== inputIdx2) {
                  inputIdx1.value = String(rIdx);
                  if (inputIdx2) inputIdx2.value = String(cIdx);
                  highlightCell(el, vname + '[' + rIdx + '][' + cIdx + '] = ' + formatCellScalar(cVal));
                }
              });
              el.addEventListener('mouseleave', function () {
                clearInspection();
              });
            })(row, col, val2d, td2d);
            trRow.appendChild(td2d);
          }
          tbody2d.appendChild(trRow);
        }
        table2d.appendChild(tbody2d);
        tableWrapper.appendChild(table2d);

      } else if (dim === 3) {
        var sliceTabBar = document.createElement('div');
        sliceTabBar.className = 'viz-slice-tabs';

        function renderSlice(sIdx) {
          tableWrapper.innerHTML = '';
          tableWrapper.appendChild(sliceTabBar);

          var sliceButtons = sliceTabBar.querySelectorAll('.viz-slice-tab');
          sliceButtons.forEach(function (btn, bIdx) {
            btn.classList.toggle('active', bIdx === sIdx);
          });

          var sArr = arr[sIdx] || [];
          var sCols = 0;
          for (var sr = 0; sr < sArr.length; sr++) {
            if (sArr[sr] && sArr[sr].length > sCols) sCols = sArr[sr].length;
          }

          var sTable = document.createElement('table');
          sTable.className = 'viz-array-table viz-3d-slice-table';

          var sThead = document.createElement('thead');
          var sTrTop = document.createElement('tr');
          var sThCorner = document.createElement('th');
          sThCorner.className = 'viz-idx-corner';
          sThCorner.textContent = '[' + sIdx + '][r][c]';
          sTrTop.appendChild(sThCorner);

          for (var sc = 0; sc < sCols; sc++) {
            var thSc = document.createElement('th');
            thSc.className = 'viz-idx-th';
            thSc.textContent = '[' + sc + ']';
            sTrTop.appendChild(thSc);
          }
          sThead.appendChild(sTrTop);
          sTable.appendChild(sThead);

          var sTbody = document.createElement('tbody');
          for (var sRow = 0; sRow < sArr.length; sRow++) {
            var sTrRow = document.createElement('tr');
            var sThRow = document.createElement('th');
            sThRow.className = 'viz-row-th';
            sThRow.textContent = '[' + sRow + ']';
            sTrRow.appendChild(sThRow);

            var sRowArr = sArr[sRow] || [];
            for (var sCol = 0; sCol < sCols; sCol++) {
              var sTd = document.createElement('td');
              sTd.className = 'viz-cell-val';
              sTd.dataset.row = String(sRow);
              sTd.dataset.col = String(sCol);
              var sVal = sRowArr[sCol];
              sTd.textContent = formatCellScalar(sVal);
              if (elemDiff && elemDiff.has(sIdx + ',' + sRow + ',' + sCol)) {
                sTd.classList.add('viz-cell-changed');
              }
              (function (sl, rI, cI, val, el) {
                el.addEventListener('click', function () {
                  if (inputIdx1) inputIdx1.value = String(sl);
                  if (inputIdx2) inputIdx2.value = String(rI);
                  if (inputIdx3) inputIdx3.value = String(cI);
                  highlightCell(el, vname + '[' + sl + '][' + rI + '][' + cI + '] = ' + formatCellScalar(val));
                });
                el.addEventListener('mouseenter', function () {
                  if (inputIdx1 && document.activeElement !== inputIdx1 && document.activeElement !== inputIdx2 && document.activeElement !== inputIdx3) {
                    inputIdx1.value = String(sl);
                    if (inputIdx2) inputIdx2.value = String(rI);
                    if (inputIdx3) inputIdx3.value = String(cI);
                    highlightCell(el, vname + '[' + sl + '][' + rI + '][' + cI + '] = ' + formatCellScalar(val));
                  }
                });
                el.addEventListener('mouseleave', function () {
                  clearInspection();
                });
              })(sIdx, sRow, sCol, sVal, sTd);
              sTrRow.appendChild(sTd);
            }
            sTbody.appendChild(sTrRow);
          }
          sTable.appendChild(sTbody);
          tableWrapper.appendChild(sTable);
        }

        for (var si = 0; si < arr.length; si++) {
          var sBtn = document.createElement('button');
          sBtn.type = 'button';
          sBtn.className = 'viz-slice-tab' + (si === 0 ? ' active' : '');
          sBtn.textContent = '[' + si + ']';
          sBtn.title = 'View slice ' + si;
          (function (sliceNum) {
            sBtn.addEventListener('click', function () {
              if (inputIdx1) inputIdx1.value = String(sliceNum);
              renderSlice(sliceNum);
            });
          })(si);
          sliceTabBar.appendChild(sBtn);
        }

        selectSlice = renderSlice;
        renderSlice(0);
      }

      tableWrapper.addEventListener('mouseleave', function () {
        clearInspection();
      });

      // Auto-inspect changed element if present
      if (elemDiff && elemDiff.size > 0) {
        var firstKey = elemDiff.values().next().value;
        if (firstKey) {
          if (dim === 1) {
            var fiIdx = parseInt(firstKey, 10);
            if (!isNaN(fiIdx) && fiIdx >= 0 && fiIdx < arr.length) {
              if (inputIdx1) inputIdx1.value = String(fiIdx);
              var cEl = tableWrapper.querySelector('.viz-cell-val[data-idx="' + fiIdx + '"]');
              highlightCell(cEl, vname + '[' + fiIdx + '] = ' + formatCellScalar(arr[fiIdx]));
            }
          } else if (dim === 2) {
            var parts = firstKey.split(',');
            var frR = parseInt(parts[0], 10);
            var frC = parseInt(parts[1], 10);
            if (inputIdx1) inputIdx1.value = String(frR);
            if (inputIdx2) inputIdx2.value = String(frC);
            var cEl2 = tableWrapper.querySelector('.viz-cell-val[data-row="' + frR + '"][data-col="' + frC + '"]');
            if (arr[frR]) {
              highlightCell(cEl2, vname + '[' + frR + '][' + frC + '] = ' + formatCellScalar(arr[frR][frC]));
            }
          } else if (dim === 3) {
            var parts3 = firstKey.split(',');
            var fd1 = parseInt(parts3[0], 10);
            var fd2 = parseInt(parts3[1], 10);
            var fd3 = parseInt(parts3[2], 10);
            if (selectSlice) selectSlice(fd1);
            if (inputIdx1) inputIdx1.value = String(fd1);
            if (inputIdx2) inputIdx2.value = String(fd2);
            if (inputIdx3) inputIdx3.value = String(fd3);
            var cEl3 = tableWrapper.querySelector('.viz-cell-val[data-row="' + fd2 + '"][data-col="' + fd3 + '"]');
            if (arr[fd1] && arr[fd1][fd2]) {
              highlightCell(cEl3, vname + '[' + fd1 + '][' + fd2 + '][' + fd3 + '] = ' + formatCellScalar(arr[fd1][fd2][fd3]));
            }
          }
        }
      }

      viewDiv.appendChild(tableWrapper);
      viewDiv.appendChild(rawPre);
      container.appendChild(viewDiv);
    }

    function render(state) {
      var cs = state.callStack;
      var changedVars = state.changedVars;

      // Update controls state
      var atStart = (step <= 0);
      var atEnd = (step >= totalSteps - 1);
      btnReset.disabled = atStart;
      btnBack.disabled = atStart;
      btnInto.disabled = atEnd;
      btnOver.disabled = atEnd;
      btnOut.disabled = atEnd || cs.length === 0;
      btnEnd.disabled = atEnd;
      stepInfo.textContent = 'Step ' + (step + 1) + ' / ' + totalSteps;
      slider.value = String(step);

      // Call stack: render top-to-bottom (top of stack first)
      stackList.innerHTML = '';
      if (cs.length === 0) {
        var emptyLi = el('li', 'viz-stack-item');
        emptyLi.style.color = 'var(--muted)';
        emptyLi.style.fontStyle = 'italic';
        emptyLi.textContent = '(empty)';
        stackList.appendChild(emptyLi);
      } else {
        for (var i = cs.length - 1; i >= 0; i--) {
          var frame = cs[i];
          var isTop = (i === cs.length - 1);
          var li = el('li', 'viz-stack-item' + (isTop ? ' active' : ''));

          var fnSpan = el('span', 'viz-stack-fn');
          // Build function label: name(param=val, ...)
          var label = frame.name + '(';
          for (var p = 0; p < frame.params.length; p++) {
            if (p > 0) label += ', ';
            var prm = frame.params[p];
            var pVar = frame.vars ? frame.vars[prm.name] : null;
            if (pVar && pVar.refVar) {
              label += prm.name + ' \u2192 ' + pVar.refVar + '=' + pVar.val;
            } else {
              label += prm.name + '=' + (pVar ? pVar.val : prm.val);
            }
          }
          label += ')';

          if (isTop) {
            var arrow = el('span', 'viz-stack-arrow');
            arrow.textContent = '\u25B6 ';
            fnSpan.appendChild(arrow);
          }
          fnSpan.appendChild(document.createTextNode(label));
          li.appendChild(fnSpan);

          var lineSpan = el('span', 'viz-stack-line');
          var displayLine = isTop ? (state.currentLine || frame.line) : frame.line;
          lineSpan.textContent = '\u2190 line ' + (displayLine || '?');
          li.appendChild(lineSpan);

          (function (targetLine) {
            li.style.cursor = 'pointer';
            li.title = 'Click to view line ' + targetLine;
            li.addEventListener('click', function () {
              for (var l = 0; l < listeners.length; l++) {
                try { listeners[l](step, totalSteps, targetLine); } catch (_) {}
              }
            });
          })(displayLine);

          stackList.appendChild(li);
        }
      }

      // Variables: global variables first, then grouped by stack frame (top first)
      varsContent.innerHTML = '';
      var globals = state.globals || {};
      var gKeys = Object.keys(globals);
      var hasAnyVars = gKeys.length > 0;
      for (var fidx = 0; fidx < cs.length; fidx++) {
        if (Object.keys(cs[fidx].vars).length > 0) hasAnyVars = true;
      }

      if (!hasAnyVars && cs.length === 0) {
        var emptyVars = el('div', 'viz-vars-empty');
        emptyVars.textContent = 'No variables in scope.';
        varsContent.appendChild(emptyVars);
        drawRefArrows();
      } else {
        // 1. Global variables section
        if (gKeys.length > 0) {
          var gTitle = el('div', 'viz-vars-frame-title');
          gTitle.textContent = 'Global';
          varsContent.appendChild(gTitle);

          var gTable = el('table', 'viz-vars-table');
          for (var gi = 0; gi < gKeys.length; gi++) {
            var gName = gKeys[gi];
            var gv = globals[gName];
            var gTr = document.createElement('tr');
            gTr.dataset.frame = '-1';
            gTr.dataset.var = gName;
            var elemDiff = (changedVars.elementDiffs && changedVars.elementDiffs.get('-1:' + gName)) || null;
            if (isVarChanged(changedVars, -1, gName, gv)) {
              if (!elemDiff || elemDiff.size === 0) {
                gTr.className = 'viz-changed';
              }
            }
            var gTdName = document.createElement('td');
            gTdName.textContent = gName;
            var gTdType = document.createElement('td');
            gTdType.textContent = gv.type;
            var gTdVal = document.createElement('td');
            gTdVal.className = 'viz-var-val';
            renderVarValue(gTdVal, gName, gv.val, gv.type, elemDiff);

            var gTargetHook = document.createElement('span');
            gTargetHook.className = 'viz-ref-target-hook';
            gTdVal.appendChild(gTargetHook);

            gTr.appendChild(gTdName);
            gTr.appendChild(gTdType);
            gTr.appendChild(gTdVal);
            gTable.appendChild(gTr);
          }
          varsContent.appendChild(gTable);
        }

        // 2. Local stack frames
        for (var fi = cs.length - 1; fi >= 0; fi--) {
          var fr = cs[fi];
          var title = el('div', 'viz-vars-frame-title');
          var titleText = 'Local (' + fr.name;
          if (fr.params && fr.params.length) {
            titleText += ': ' + fr.params.map(function (p) {
              var pVar = fr.vars ? fr.vars[p.name] : null;
              var refStr = (pVar && pVar.refVar) ? (' \u2192 ' + pVar.refVar) : '';
              return p.name + (refStr ? refStr : ('=' + (pVar ? pVar.val : p.val)));
            }).join(', ');
          }
          titleText += ')';
          title.textContent = titleText;
          varsContent.appendChild(title);

          var keys = Object.keys(fr.vars);
          if (keys.length === 0) {
            var noVars = el('div', 'viz-vars-empty');
            noVars.textContent = '(no variables)';
            varsContent.appendChild(noVars);
          } else {
            var table = el('table', 'viz-vars-table');
            for (var vi = 0; vi < keys.length; vi++) {
              var vname = keys[vi];
              var v = fr.vars[vname];
              var tr = document.createElement('tr');
              tr.dataset.frame = String(fi);
              tr.dataset.var = vname;
              if (v.refVar) {
                tr.dataset.refVar = v.refVar;
                if (v.refBaseVar) tr.dataset.refBaseVar = v.refBaseVar;
                tr.dataset.refFrame = String(v.refFrameIdx !== undefined ? v.refFrameIdx : -1);
              }
              var elemDiff = (changedVars.elementDiffs && changedVars.elementDiffs.get(fi + ':' + vname)) || null;
              if (isVarChanged(changedVars, fi, vname, v)) {
                if (!elemDiff || elemDiff.size === 0) {
                  tr.className = 'viz-changed';
                }
              }
              var tdName = document.createElement('td');
              tdName.textContent = vname;
              var tdType = document.createElement('td');
              tdType.textContent = v.type;
              var tdVal = document.createElement('td');
              tdVal.className = 'viz-var-val';
              renderVarValue(tdVal, vname, v.val, v.type, elemDiff);

              if (v.refVar) {
                var anchorDot = document.createElement('span');
                anchorDot.className = 'viz-ref-anchor-dot';
                anchorDot.title = vname + ' \u2192 ' + v.refVar;
                tdVal.appendChild(anchorDot);
              }
              var targetHook = document.createElement('span');
              targetHook.className = 'viz-ref-target-hook';
              tdVal.appendChild(targetHook);

              tr.appendChild(tdName);
              tr.appendChild(tdType);
              tr.appendChild(tdVal);
              table.appendChild(tr);
            }
            varsContent.appendChild(table);
          }
        }

        varsContent.appendChild(arrowsSvg);
        drawRefArrows();
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(drawRefArrows);
        }
      }

      // Output & Input: highlight values in output and input
      var curEv = (step >= 0 && step < events.length) ? events[step] : null;
      var curOut = (curEv && curEv._output !== undefined) ? curEv._output : (step >= 0 ? programOutput : '');
      var prevEv = (step > 0 && step <= events.length) ? events[step - 1] : null;
      var prevOut = (prevEv && prevEv._output !== undefined) ? prevEv._output : '';

      // Switch active tab if current event is io
      if (curEv && curEv.e === 'io') {
        if (curEv.io === 'input') {
          currentTab = 'input';
          tabInput.className = 'viz-io-tab active';
          tabOutput.className = 'viz-io-tab';
          outputPre.style.display = 'none';
          inputPre.style.display = '';
        } else if (curEv.io === 'output') {
          currentTab = 'output';
          tabOutput.className = 'viz-io-tab active';
          tabInput.className = 'viz-io-tab';
          outputPre.style.display = '';
          inputPre.style.display = 'none';
        }
      }

      if (!curOut) {
        outputPre.innerHTML = '<span class="viz-io-empty">(no output produced yet)</span>';
      } else {
        outputPre.innerHTML = '';
        if (curOut.length > prevOut.length) {
          var before = curOut.slice(0, prevOut.length);
          var newlyAdded = curOut.slice(prevOut.length);
          if (before) outputPre.appendChild(document.createTextNode(before));
          var hlSpan = el('span', 'viz-io-highlight');
          hlSpan.textContent = newlyAdded;
          outputPre.appendChild(hlSpan);
        } else if (curEv && curEv.e === 'io' && curEv.io === 'output') {
          var hlSpan = el('span', 'viz-io-highlight');
          hlSpan.textContent = curOut;
          outputPre.appendChild(hlSpan);
        } else {
          outputPre.textContent = curOut;
        }
      }

      if (!programInput) {
        inputPre.innerHTML = '<span class="viz-io-empty">(no input provided)</span>';
      } else {
        inputPre.innerHTML = '';
        if (curEv && curEv.e === 'io' && curEv.io === 'input' && curEv.inputRange) {
          var rStart = curEv.inputRange[0];
          var rEnd = curEv.inputRange[1];
          if (rStart > 0) {
            var consumedSpan = el('span', 'viz-io-consumed');
            consumedSpan.textContent = programInput.slice(0, rStart);
            inputPre.appendChild(consumedSpan);
          }
          var hlSpan = el('span', 'viz-io-highlight');
          hlSpan.textContent = programInput.slice(rStart, rEnd);
          inputPre.appendChild(hlSpan);
          if (rEnd < programInput.length) {
            inputPre.appendChild(document.createTextNode(programInput.slice(rEnd)));
          }
        } else {
          var lastConsumedEnd = -1;
          for (var si = step; si >= 0; si--) {
            if (events[si] && events[si].e === 'io' && events[si].io === 'input' && events[si].inputRange) {
              lastConsumedEnd = events[si].inputRange[1];
              break;
            }
          }
          if (lastConsumedEnd > 0) {
            var consumedSpan = el('span', 'viz-io-consumed');
            consumedSpan.textContent = programInput.slice(0, lastConsumedEnd);
            inputPre.appendChild(consumedSpan);
            if (lastConsumedEnd < programInput.length) {
              inputPre.appendChild(document.createTextNode(programInput.slice(lastConsumedEnd)));
            }
          } else {
            inputPre.textContent = programInput;
          }
        }
      }
    }

    // ── Shared output and input text ─────────────
    var programOutput = '';
    var programInput = '';

    // ── State computation with caching ─

    function getState(targetStep) {
      if (targetStep < 0) {
        return { callStack: [], globals: deepCloneVars(initialGlobals), currentLine: 0, changedVars: new Set() };
      }

      // Find the nearest snapshot before or at targetStep.
      var nearest = snapshots.closest(targetStep);
      var state;
      if (nearest && nearest.startIndex <= targetStep) {
        state = computeState(events, targetStep, nearest.snapshot, nearest.startIndex, initialGlobals);
      } else {
        state = computeState(events, targetStep, null, 0, initialGlobals);
      }

      // Cache snapshot at interval boundaries we pass through.
      // Cache the final state at targetStep if it falls on an interval.
      if (targetStep > 0 && (targetStep % SNAPSHOT_INTERVAL === 0) && !snapshots.get(targetStep)) {
        snapshots.set(targetStep, state);
      }

      return state;
    }

    /** Pre-build snapshots at every SNAPSHOT_INTERVAL for the loaded trace. */
    function buildSnapshotCache() {
      snapshots.clear();
      if (events.length === 0) return;
      // Replay once, caching at interval boundaries.
      var cs = [];
      var globals = deepCloneVars(initialGlobals);
      var cl = 0;
      for (var i = 0; i < events.length; i++) {
        var ev = events[i];
        switch (ev.e) {
          case 'func_enter':
            var frame = { name: ev.name, params: ev.params || [], line: ev.line, depth: ev.depth, vars: {} };
            var topF = cs.length;
            for (var p = 0; p < frame.params.length; p++) {
              var prm = frame.params[p];
              var refInfo = resolveRefInfo(cs, globals, prm.addr, prm.name, topF);
              frame.vars[prm.name] = {
                type: prm.type,
                val: prm.val,
                addr: prm.addr,
                refVar: refInfo ? refInfo.refVar : null,
                refFrameIdx: refInfo ? refInfo.refFrameIdx : null
              };
            }
            cs.push(frame);
            cl = ev.line;
            break;
          case 'func_exit':
            if (cs.length) cs.pop();
            if (cs.length) {
              cl = cs[cs.length - 1].line || cl;
            }
            break;
          case 'global_decl':
            globals[ev.name] = { type: ev.type, val: ev.val, addr: ev.addr };
            if (ev.line) cl = ev.line;
            break;
          case 'var_decl':
            if (cs.length) {
              var curTopF = cs.length - 1;
              var refInfo = resolveRefInfo(cs, globals, ev.addr, ev.name, curTopF);
              cs[cs.length - 1].vars[ev.name] = {
                type: ev.type,
                val: ev.val,
                addr: ev.addr,
                refVar: refInfo ? refInfo.refVar : null,
                refBaseVar: refInfo ? refInfo.refBaseVar : null,
                refFrameIdx: refInfo ? refInfo.refFrameIdx : null
              };
            }
            if (ev.line) cl = ev.line;
            if (cs.length && ev.line) cs[cs.length - 1].line = ev.line;
            break;
          case 'var_end':
            for (var f = cs.length - 1; f >= 0; f--) {
              if (cs[f].vars[ev.name] !== undefined) {
                delete cs[f].vars[ev.name];
                break;
              }
            }
            break;
          case 'var_set':
          case 'var_step':
            var found = false;
            var targetAddr = ev.addr;
            for (var f = cs.length - 1; f >= 0; f--) {
              if (cs[f].vars[ev.name] !== undefined) {
                cs[f].vars[ev.name].val = ev.val;
                if (ev.addr) cs[f].vars[ev.name].addr = ev.addr;
                else targetAddr = cs[f].vars[ev.name].addr;
                found = true;
                break;
              }
            }
            if (!found && globals[ev.name] !== undefined) {
              globals[ev.name].val = ev.val;
              if (ev.addr) globals[ev.name].addr = ev.addr;
              else targetAddr = globals[ev.name].addr;
              found = true;
            }
            if (!found && cs.length) {
              cs[cs.length - 1].vars[ev.name] = { type: ev.type || 'auto', val: ev.val, addr: ev.addr };
            }
            if (targetAddr) {
              syncAliasedVars(cs, globals, targetAddr, ev.val, null, false);
            }
            if (ev.line) cl = ev.line;
            if (cs.length && ev.line) cs[cs.length - 1].line = ev.line;
            break;
          case 'var_step2':
            var found1 = false;
            var targetAddr1 = ev.addr1;
            for (var f = cs.length - 1; f >= 0; f--) {
              if (cs[f].vars[ev.name1] !== undefined) {
                cs[f].vars[ev.name1].val = ev.val1;
                if (ev.addr1) cs[f].vars[ev.name1].addr = ev.addr1;
                else targetAddr1 = cs[f].vars[ev.name1].addr;
                found1 = true;
                break;
              }
            }
            if (!found1 && cs.length) {
              cs[cs.length - 1].vars[ev.name1] = { type: ev.type1 || 'auto', val: ev.val1, addr: ev.addr1 };
            }
            if (targetAddr1) {
              syncAliasedVars(cs, globals, targetAddr1, ev.val1, null, false);
            }

            var found2 = false;
            var targetAddr2 = ev.addr2;
            for (var f = cs.length - 1; f >= 0; f--) {
              if (cs[f].vars[ev.name2] !== undefined) {
                cs[f].vars[ev.name2].val = ev.val2;
                if (ev.addr2) cs[f].vars[ev.name2].addr = ev.addr2;
                else targetAddr2 = cs[f].vars[ev.name2].addr;
                found2 = true;
                break;
              }
            }
            if (!found2 && cs.length) {
              cs[cs.length - 1].vars[ev.name2] = { type: ev.type2 || 'auto', val: ev.val2, addr: ev.addr2 };
            }
            if (targetAddr2) {
              syncAliasedVars(cs, globals, targetAddr2, ev.val2, null, false);
            }

            if (ev.line) cl = ev.line;
            if (cs.length && ev.line) cs[cs.length - 1].line = ev.line;
            break;
          case 'for_cond':
            if (ev.name) {
              var found = false;
              var targetAddr = ev.addr;
              for (var f = cs.length - 1; f >= 0; f--) {
                if (cs[f].vars[ev.name] !== undefined) {
                  cs[f].vars[ev.name].val = ev.val;
                  if (ev.addr) cs[f].vars[ev.name].addr = ev.addr;
                  else targetAddr = cs[f].vars[ev.name].addr;
                  found = true;
                  break;
                }
              }
              if (!found && globals[ev.name] !== undefined) {
                globals[ev.name].val = ev.val;
                if (ev.addr) globals[ev.name].addr = ev.addr;
                else targetAddr = globals[ev.name].addr;
                found = true;
              }
              if (!found && cs.length) {
                cs[cs.length - 1].vars[ev.name] = { type: ev.type || 'auto', val: ev.val, addr: ev.addr };
              }
              if (targetAddr) {
                syncAliasedVars(cs, globals, targetAddr, ev.val, null, false);
              }
            }
            if (ev.line) cl = ev.line;
            if (cs.length && ev.line) cs[cs.length - 1].line = ev.line;
            break;
          case 'for_cond2':
            if (ev.name1) {
              var found1 = false;
              var targetAddr1 = ev.addr1;
              for (var f = cs.length - 1; f >= 0; f--) {
                if (cs[f].vars[ev.name1] !== undefined) {
                  cs[f].vars[ev.name1].val = ev.val1;
                  if (ev.addr1) cs[f].vars[ev.name1].addr = ev.addr1;
                  else targetAddr1 = cs[f].vars[ev.name1].addr;
                  found1 = true;
                  break;
                }
              }
              if (!found1 && cs.length) {
                cs[cs.length - 1].vars[ev.name1] = { type: ev.type1 || 'auto', val: ev.val1, addr: ev.addr1 };
              }
              if (targetAddr1) {
                syncAliasedVars(cs, globals, targetAddr1, ev.val1, null, false);
              }
            }
            if (ev.name2) {
              var found2 = false;
              var targetAddr2 = ev.addr2;
              for (var f = cs.length - 1; f >= 0; f--) {
                if (cs[f].vars[ev.name2] !== undefined) {
                  cs[f].vars[ev.name2].val = ev.val2;
                  if (ev.addr2) cs[f].vars[ev.name2].addr = ev.addr2;
                  else targetAddr2 = cs[f].vars[ev.name2].addr;
                  found2 = true;
                  break;
                }
              }
              if (!found2 && cs.length) {
                cs[cs.length - 1].vars[ev.name2] = { type: ev.type2 || 'auto', val: ev.val2, addr: ev.addr2 };
              }
              if (targetAddr2) {
                syncAliasedVars(cs, globals, targetAddr2, ev.val2, null, false);
              }
            }
            if (ev.line) cl = ev.line;
            if (cs.length && ev.line) cs[cs.length - 1].line = ev.line;
            break;
          case 'line':
            cl = ev.line;
            if (cs.length) cs[cs.length - 1].line = ev.line;
            break;
          case 'io':
            if (ev.name) {
              var found = false;
              var targetAddr = ev.addr;
              for (var f = cs.length - 1; f >= 0; f--) {
                if (cs[f].vars[ev.name] !== undefined) {
                  cs[f].vars[ev.name].val = ev.val;
                  if (ev.addr) cs[f].vars[ev.name].addr = ev.addr;
                  else targetAddr = cs[f].vars[ev.name].addr;
                  found = true;
                  break;
                }
              }
              if (!found && globals[ev.name] !== undefined) {
                globals[ev.name].val = ev.val;
                if (ev.addr) globals[ev.name].addr = ev.addr;
                else targetAddr = globals[ev.name].addr;
                found = true;
              }
              if (!found && cs.length) {
                cs[cs.length - 1].vars[ev.name] = { type: ev.type || 'auto', val: ev.val, addr: ev.addr };
              }
              if (targetAddr) {
                syncAliasedVars(cs, globals, targetAddr, ev.val, null, false);
              }
            }
            if (ev.line) cl = ev.line;
            if (cs.length && ev.line) cs[cs.length - 1].line = ev.line;
            break;
          case 'scope_enter':
            if (ev.line) cl = ev.line;
            if (cs.length && ev.line) cs[cs.length - 1].line = ev.line;
            break;
          case 'scope_exit':
            if (ev.line) cl = ev.line;
            if (cs.length && ev.line) cs[cs.length - 1].line = ev.line;
            if (ev.vars && cs.length) {
              var topFr = cs[cs.length - 1];
              for (var vi = 0; vi < ev.vars.length; vi++) {
                delete topFr.vars[ev.vars[vi]];
              }
            }
            break;
        }
        if (ev.endVars) {
          for (var evIdx = 0; evIdx < ev.endVars.length; evIdx++) {
            var evName = ev.endVars[evIdx];
            for (var f = cs.length - 1; f >= 0; f--) {
              if (cs[f].vars[evName] !== undefined) {
                delete cs[f].vars[evName];
                break;
              }
            }
          }
        }
        if (i > 0 && (i % SNAPSHOT_INTERVAL === 0)) {
          snapshots.set(i, { callStack: cs, globals: globals, currentLine: cl });
        }
      }
    }

    // ── Navigation ────────────────────

    function notifyListeners() {
      var curEv = (step >= 0 && step < events.length) ? events[step] : null;
      var currentLine = curEv && curEv.line ? curEv.line : (step >= 0 && step < events.length ? getState(step).currentLine : 0);
      var tokenRange = (curEv && curEv.colFrom != null && curEv.colTo != null)
        ? { from: curEv.colFrom, to: curEv.colTo }
        : null;
      for (var i = 0; i < listeners.length; i++) {
        try { listeners[i](step, totalSteps, currentLine, tokenRange); } catch (_) {}
      }
    }

    function goToStep(n) {
      if (totalSteps === 0) return;
      n = Math.max(0, Math.min(n, totalSteps - 1));
      if (n === step) return;
      step = n;
      var state = getState(step);
      render(state);
      notifyListeners();
    }

    function stepForward() {
      if (step < totalSteps - 1) goToStep(step + 1);
    }

    function stepBack() {
      if (step > 0) goToStep(step - 1);
    }

    function stepOverFn() {
      if (step >= totalSteps - 1) return;
      var st = getState(step);
      var curDepth = st.callStack.length;
      var curLine = st.currentLine;

      for (var i = step + 1; i < totalSteps; i++) {
        var s = getState(i);
        // Exited current function, or reached same depth at a different line
        if (s.callStack.length < curDepth || (s.callStack.length === curDepth && s.currentLine !== curLine)) {
          goToStep(i);
          return;
        }
      }
      goToStep(totalSteps - 1);
    }

    function stepOutFn() {
      if (step >= totalSteps - 1) return;
      var st = getState(step);
      var curDepth = st.callStack.length;
      if (curDepth <= 1) {
        // Already at top level; go to end.
        goToStep(totalSteps - 1);
        return;
      }
      // Move forward until the stack depth decreases (function exit).
      for (var i = step + 1; i < totalSteps; i++) {
        var s = getState(i);
        if (s.callStack.length < curDepth) {
          goToStep(i);
          return;
        }
      }
      goToStep(totalSteps - 1);
    }

    // ── Public API ────────────────────

    var instance = {

      /** Load a trace and reset to step 0. */
      load: function (evts, lMap, output, input, initGlobals) {
        events = evts || [];
        lineMap = lMap || null;
        programOutput = output || '';
        programInput = input || '';
        initialGlobals = initGlobals ? deepCloneVars(initGlobals) : {};
        if (Object.keys(initialGlobals).length === 0 && events.length > 0) {
          var cleanEvents = [];
          for (var i = 0; i < events.length; i++) {
            if (events[i].e === 'global_decl') {
              initialGlobals[events[i].name] = { type: events[i].type, val: events[i].val, addr: events[i].addr };
            } else {
              cleanEvents.push(events[i]);
            }
          }
          events = cleanEvents;
        }
        assignInputRanges(events, programInput);
        totalSteps = events.length;
        step = -1;

        slider.max = String(Math.max(0, totalSteps - 1));
        slider.value = '0';

        // Build snapshot cache for performance.
        buildSnapshotCache();

        if (totalSteps > 0) {
          body.style.display = '';
          ioPane.style.display = '';
          goToStep(0);
        } else {
          step = -1;
          stepInfo.textContent = 'Step 0 / 0';
          stackList.innerHTML = '';
          varsContent.innerHTML = '';
          outputPre.textContent = programOutput;
          inputPre.textContent = programInput;
          btnReset.disabled = true;
          btnBack.disabled = true;
          btnInto.disabled = true;
          btnOver.disabled = true;
          btnOut.disabled = true;
          btnEnd.disabled = true;
        }
      },

      stepForward: stepForward,
      stepBack: stepBack,
      stepInto: stepForward,
      stepOver: stepOverFn,
      stepOut: stepOutFn,
      goToStep: goToStep,
      getState: getState,

      reset: function () { goToStep(0); },

      clear: function () {
        events = [];
        initialGlobals = {};
        totalSteps = 0;
        step = -1;
        programOutput = '';
        programInput = '';
        snapshots.clear();
        stepInfo.textContent = 'Step 0 / 0';
        slider.value = '0';
        slider.max = '0';
        stackList.innerHTML = '';
        varsContent.innerHTML = '';
        outputPre.textContent = '';
        inputPre.textContent = '';
        btnReset.disabled = true;
        btnBack.disabled = true;
        btnInto.disabled = true;
        btnOver.disabled = true;
        btnOut.disabled = true;
        btnEnd.disabled = true;
      },

      getCurrentLine: function () {
        if (step < 0 || step >= events.length) return 0;
        return getState(step).currentLine;
      },

      onStepChange: function (cb) {
        if (typeof cb === 'function') listeners.push(cb);
      },

      onClose: function (cb) {
        if (typeof cb === 'function') closeListeners.push(cb);
      },

      destroy: function () {
        listeners.length = 0;
        events = [];
        initialGlobals = {};
        snapshots.clear();
        for (var i = 0; i < highlightTimers.length; i++) clearTimeout(highlightTimers[i]);
        highlightTimers.length = 0;
        if (panel.parentNode) panel.parentNode.removeChild(panel);
      }
    };

    return instance;
  }

  // ── Code instrumentation for C++ ──────────────────────────────────
  function parseInitVars(init) {
    init = init.trim();
    const assignOnly = init.match(/^[a-zA-Z_0-9]+\s*=/);
    const multiMatch = init.match(/^(?:const\s+)?(unsigned\s+long\s+long(?:\s+int)?|long\s+long(?:\s+int)?|unsigned\s+int|unsigned\s+char|unsigned\s+short(?:\s+int)?|unsigned\s+long(?:\s+int)?|signed\s+char|long\s+double)\s+(.*)$/);
    let baseType = null, rest = null;
    if (multiMatch) {
      baseType = multiMatch[1];
      rest = multiMatch[2];
    } else {
      const singleMatch = init.match(/^(?:const\s+)?([a-zA-Z_0-9:<>\*&]+(?:\s+[*&]*)?)\s+([*&]?\s*[a-zA-Z_0-9]+.*)$/);
      if (singleMatch && !assignOnly) {
        baseType = singleMatch[1];
        rest = singleMatch[2];
      } else {
        rest = init;
      }
    }

    const parts = [];
    let cur = '', depth = 0;
    for (let c of rest) {
      if (c === '<' || c === '(' || c === '{') depth++;
      else if (c === '>' || c === ')' || c === '}') depth--;
      else if (c === ',' && depth === 0) {
        parts.push(cur.trim());
        cur = '';
        continue;
      }
      cur += c;
    }
    if (cur.trim()) parts.push(cur.trim());

    const vars = [];
    for (let p of parts) {
      const m = p.match(/^[*&]?\s*([a-zA-Z_0-9]+)/);
      if (m) {
        vars.push({ name: m[1], type: baseType || 'auto' });
      }
    }
    vars.isDecl = !assignOnly && Boolean(baseType);
    return vars;
  }

  function parseForStatement(line) {
    const forMatch = line.match(/^(\s*)for\s*\(/);
    if (!forMatch) return null;
    const indent = forMatch[1];
    const forIdx = line.indexOf('for');
    const openParen = line.indexOf('(', forIdx);
    let depth = 0, firstSemi = -1, secondSemi = -1, closeParen = -1;
    let inStr = false, quote = '';
    for (let i = openParen; i < line.length; i++) {
      const c = line[i];
      if ((c === '"' || c === "'") && (i === 0 || line[i - 1] !== '\\')) {
        if (!inStr) { inStr = true; quote = c; }
        else if (quote === c) inStr = false;
      } else if (!inStr) {
        if (c === '(') depth++;
        else if (c === ')') {
          depth--;
          if (depth === 0) { closeParen = i; break; }
        } else if (c === ';') {
          if (depth === 1) {
            if (firstSemi === -1) firstSemi = i;
            else if (secondSemi === -1) secondSemi = i;
          }
        }
      }
    }
    if (firstSemi === -1 || secondSemi === -1 || closeParen === -1) return null;
    let initFrom = openParen + 1;
    while (initFrom < firstSemi && /\s/.test(line[initFrom])) initFrom++;
    let initTo = firstSemi;
    while (initTo > initFrom && /\s/.test(line[initTo - 1])) initTo--;
    let condFrom = firstSemi + 1;
    while (condFrom < secondSemi && /\s/.test(line[condFrom])) condFrom++;
    let condTo = secondSemi;
    while (condTo > condFrom && /\s/.test(line[condTo - 1])) condTo--;
    let incFrom = secondSemi + 1;
    while (incFrom < closeParen && /\s/.test(line[incFrom])) incFrom++;
    let incTo = closeParen;
    while (incTo > incFrom && /\s/.test(line[incTo - 1])) incTo--;
    const rest = line.slice(closeParen + 1);
    return {
      indent: indent,
      init: { text: line.slice(initFrom, initTo), from: initFrom, to: initTo },
      cond: { text: line.slice(condFrom, condTo), from: condFrom, to: condTo },
      inc:  { text: line.slice(incFrom, incTo),   from: incFrom,  to: incTo },
      rest: rest
    };
  }

  function parseRangeDecl(decl) {
    decl = decl.trim();
    const m = decl.match(/^(?:const\s+)?([a-zA-Z_0-9:<>\*&]+(?:\s+[*&]*)?)\s+([*&]?)\s*([a-zA-Z_0-9]+)$/);
    if (m) {
      const type = (m[1] + (m[2] ? ' ' + m[2] : '')).trim();
      const name = m[3].trim();
      return { type: type, name: name };
    }
    return null;
  }

  function parseDecl(line) {
    let codeWithoutComment = line;
    const commentIdx = line.indexOf('//');
    if (commentIdx !== -1) {
      let inStr = false, quote = '';
      for (let c = 0; c < commentIdx; c++) {
        if ((line[c] === '"' || line[c] === "'") && (c === 0 || line[c - 1] !== '\\')) {
          if (!inStr) { inStr = true; quote = line[c]; }
          else if (quote === line[c]) inStr = false;
        }
      }
      if (!inStr) codeWithoutComment = line.slice(0, commentIdx);
    }
    const trimmedLine = codeWithoutComment.trim();
    if (!trimmedLine.endsWith(';')) return null;
    let s = trimmedLine.slice(0, -1).trim();

    const reserved = new Set(['return', 'if', 'else', 'while', 'for', 'do', 'switch', 'case', 'break', 'continue',
                              'goto', 'typedef', 'using', 'namespace', 'cout', 'cin', 'cerr', 'std', '__viz', 'struct', 'class', 'enum']);

    // Strip leading qualifiers: const, constexpr, static, inline, volatile, mutable
    s = s.replace(/^(?:(?:const|constexpr|static|inline|volatile|mutable)\s+)+/, '').trim();
    const firstWord = s.split(/[\s<*&]/)[0];
    if (reserved.has(firstWord) || s.startsWith('std::cout') || s.startsWith('std::cin')) return null;

    // Check multi-word types first
    const multiTypes = [
      'unsigned long long int', 'unsigned long long',
      'long long int', 'long long',
      'unsigned int', 'unsigned char',
      'unsigned short int', 'unsigned short',
      'unsigned long int', 'unsigned long',
      'signed char', 'long double'
    ];
    let type = null, rest = null;
    for (const mt of multiTypes) {
      if (s.startsWith(mt) && (s.length === mt.length || /[\s*&]/.test(s[mt.length]))) {
        type = mt;
        rest = s.slice(mt.length).trim();
        break;
      }
    }

    // If not multi-word, parse single/templated type: e.g. int, std::vector<int>, pair<int, int>, char*
    if (!type) {
      let depth = 0;
      let parenDepth = 0;
      let i = 0;
      for (; i < s.length; i++) {
        const c = s[i];
        if (c === '<') depth++;
        else if (c === '>') depth--;
        else if (c === '(') parenDepth++;
        else if (c === ')') parenDepth--;
        else if (depth === 0 && parenDepth === 0 && (c === ' ' || c === '\t' || c === '*' || c === '&')) {
          break;
        }
      }
      if (depth !== 0 || parenDepth !== 0 || i === 0) return null;
      type = s.slice(0, i).trim();
      rest = s.slice(i).trim();
    }

    if (type === 'void' || type.includes('(') || type.includes(')')) return null;

    // Consume any trailing pointer/reference symbols from rest into type (e.g. * or &)
    while (rest.startsWith('*') || rest.startsWith('&')) {
      type += rest[0];
      rest = rest.slice(1).trim();
    }

    if (!rest || /^[^a-zA-Z_0-9*&]/.test(rest)) return null;

    // Now parse comma-separated declarations in rest, respecting <>, (), {}, []
    const decls = [];
    let cur = '';
    let depth = 0;
    for (let c of rest) {
      if (c === '<' || c === '(' || c === '{' || c === '[') depth++;
      else if (c === '>' || c === ')' || c === '}' || c === ']') depth--;
      else if (c === ',' && depth === 0) {
        decls.push(cur.trim());
        cur = '';
        continue;
      }
      cur += c;
    }
    if (cur.trim()) decls.push(cur.trim());

    const vars = [];
    for (const d of decls) {
      const varMatch = d.match(/^[*&]?\s*([a-zA-Z_0-9]+)/);
      if (varMatch && !reserved.has(varMatch[1]) && !/^\d+$/.test(varMatch[1])) {
        const declPart = d.split(/[=({]/)[0];
        const dimMatches = declPart.match(/\[[^\]]*\]/g);
        const dimCount = dimMatches ? dimMatches.length : 0;
        const isArray = dimCount > 0;
        const arrType = isArray ? (type + '[]'.repeat(dimCount)) : type;
        vars.push({ name: varMatch[1], isArray: isArray, dimCount: dimCount, arrType: arrType });
      }
    }
    return vars.length ? { type: type, vars: vars } : null;
  }

  function parseParam(pStr) {
    let pTrim = pStr.trim();
    if (!pTrim || pTrim === 'void') return null;
    const eqIdx = pTrim.indexOf('=');
    if (eqIdx !== -1) pTrim = pTrim.slice(0, eqIdx).trim();

    // Reference to array: type (&name)[dim1][dim2]...
    const refArrMatch = pTrim.match(/^(.+?)\s*\(\s*&\s*([a-zA-Z_0-9]+)\s*\)\s*(\[[^\]]*\](?:\s*\[[^\]]*\])*)$/);
    if (refArrMatch) {
      const rawType = refArrMatch[1].trim();
      const name = refArrMatch[2].trim();
      const brackets = refArrMatch[3].match(/\[[^\]]*\]/g);
      const dims = '[]'.repeat(brackets ? brackets.length : 1);
      return { type: rawType + '&' + dims, name: name, isArray: true };
    }

    // Standard array param: type name[dim1][dim2]...
    const arrMatch = pTrim.match(/^(.+?)\s+([*&]?)\s*([a-zA-Z_0-9]+)\s*(\[[^\]]*\](?:\s*\[[^\]]*\])*)$/);
    if (arrMatch) {
      const baseType = (arrMatch[1] + (arrMatch[2] ? ' ' + arrMatch[2] : '')).trim();
      const name = arrMatch[3].trim();
      const brackets = arrMatch[4].match(/\[[^\]]*\]/g);
      const dims = '[]'.repeat(brackets ? brackets.length : 1);
      let firstDim = null;
      if (brackets && brackets.length > 0) {
        const dMatch = brackets[0].match(/\[\s*(\d+)\s*\]/);
        if (dMatch) firstDim = parseInt(dMatch[1], 10);
      }
      return { type: baseType + dims, name: name, isArray: true, firstDim: firstDim };
    }

    // Scalar, pointer, or normal reference: type [*&]? name
    const scalarMatch = pTrim.match(/^(.+?)\s*([*&]?)\s*([a-zA-Z_0-9]+)$/);
    if (scalarMatch) {
      const type = (scalarMatch[1] + (scalarMatch[2] ? ' ' + scalarMatch[2] : '')).trim();
      const name = scalarMatch[3].trim();
      return { type: type, name: name, isArray: false };
    }

    return null;
  }

  function instrumentCode(userCode, filename) {
    const actualFilename = filename || 'main.cpp';
    const header = [
      '#include <iostream>',
      '#include <sstream>',
      '#include <string>',
      '#include <vector>',
      '#include <array>',
      '#include <initializer_list>',
      '#include <utility>',
      '#include <type_traits>',
      '#include <memory>',
      '#include <cstdint>',
      '',
      '#line 1 "<visualizer-internal>"',
      'namespace __viz {',
      '  static int step_count = 0;',
      '  static const int MAX_STEPS = 10000;',
      '  static bool stopped = false;',
      '',
      '  inline std::string escape_json(const std::string& s) {',
      '    static const char hex[] = "0123456789abcdef";',
      '    std::ostringstream ss;',
      '    for (size_t i = 0; i < s.length(); ++i) {',
      '      unsigned char c = static_cast<unsigned char>(s[i]);',
      '      if (c == \'"\') ss << "\\\\\\\"";',
      '      else if (c == \'\\\\\') ss << "\\\\\\\\";',
      '      else if (c == \'\\b\') ss << "\\\\b";',
      '      else if (c == \'\\f\') ss << "\\\\f";',
      '      else if (c == \'\\n\') ss << "\\\\n";',
      '      else if (c == \'\\r\') ss << "\\\\r";',
      '      else if (c == \'\\t\') ss << "\\\\t";',
      '      else if (c < 0x20) {',
      '        ss << "\\\\u00" << hex[(c >> 4) & 0xF] << hex[c & 0xF];',
      '      }',
      '      else ss << static_cast<char>(c);',
      '    }',
      '    return ss.str();',
      '  }',
      '',
      '  template<typename T>',
      '  inline std::string to_s(const T& v);',
      '',
      '  template<typename T, size_t N>',
      '  inline std::string to_s(const T (&arr)[N]);',
      '',
      '  inline std::string to_s(bool v) { return v ? "true" : "false"; }',
      '  inline std::string to_s(char v) {',
      '    static const char hex[] = "0123456789abcdef";',
      '    unsigned char c = static_cast<unsigned char>(v);',
      '    if (c == \'\\0\') return "\'\\\\0\'";',
      '    if (c == \'\\n\') return "\'\\\\n\'";',
      '    if (c == \'\\r\') return "\'\\\\r\'";',
      '    if (c == \'\\t\') return "\'\\\\t\'";',
      '    if (c == \'\\\\\') return "\'\\\\\\\\\'";',
      '    if (c == \'\\\'\') return "\'\\\\\'\'";',
      '    if (c >= 32 && c <= 126) return std::string("\'") + v + "\'";',
      '    std::string r = "\'\\\\x";',
      '    r += hex[(c >> 4) & 0xF];',
      '    r += hex[c & 0xF];',
      '    r += "\'";',
      '    return r;',
      '  }',
      '  inline std::string to_s(const std::string& v) { return "\\"" + v + "\\""; }',
      '',
      '  template<typename T1, typename T2>',
      '  inline std::string to_s(const std::pair<T1, T2>& p) {',
      '    return "{" + to_s(p.first) + ", " + to_s(p.second) + "}";',
      '  }',
      '',
      '  template<typename T, size_t N>',
      '  inline std::string to_s(const T (&arr)[N]) {',
      '    std::ostringstream ss;',
      '    ss << "[";',
      '    for (size_t i = 0; i < N && i < 15; ++i) {',
      '      if (i > 0) ss << ", ";',
      '      ss << to_s(arr[i]);',
      '    }',
      '    if (N > 15) ss << ", ...";',
      '    ss << "]";',
      '    return ss.str();',
      '  }',
      '',
      '  template<typename T, size_t N>',
      '  inline std::string to_s(const std::array<T, N>& arr) {',
      '    std::ostringstream ss;',
      '    ss << "[";',
      '    for (size_t i = 0; i < N && i < 15; ++i) {',
      '      if (i > 0) ss << ", ";',
      '      ss << to_s(arr[i]);',
      '    }',
      '    if (N > 15) ss << ", ...";',
      '    ss << "]";',
      '    return ss.str();',
      '  }',
      '',
      '  template<typename T>',
      '  inline std::string to_s(const std::vector<T>& v) {',
      '    std::ostringstream ss;',
      '    ss << "[";',
      '    for (size_t i = 0; i < v.size() && i < 15; ++i) {',
      '      if (i > 0) ss << ", ";',
      '      ss << to_s(v[i]);',
      '    }',
      '    if (v.size() > 15) ss << ", ...";',
      '    ss << "]";',
      '    return ss.str();',
      '  }',
      '',
      '  template<typename T, typename = void>',
      '  struct has_ostream_op : std::false_type {};',
      '',
      '  template<typename T>',
      '  struct has_ostream_op<T, decltype(std::declval<std::ostream&>() << std::declval<const T&>(), void())> : std::true_type {};',
      '',
      '  inline std::string to_s_scalar(const char* v) {',
      '    return v ? (std::string("\\"") + v + "\\"") : "nullptr";',
      '  }',
      '',
      '  inline std::string to_s_scalar(char* v) {',
      '    return v ? (std::string("\\"") + v + "\\"") : "nullptr";',
      '  }',
      '',
      '  template<typename T>',
      '  inline typename std::enable_if<has_ostream_op<T>::value, std::string>::type',
      '  to_s_scalar(const T& v) {',
      '    std::ostringstream ss;',
      '    ss << v;',
      '    return ss.str();',
      '  }',
      '',
      '  template<typename T>',
      '  inline typename std::enable_if<!has_ostream_op<T>::value, std::string>::type',
      '  to_s_scalar(const T&) {',
      '    return "{...}";',
      '  }',
      '',
      '  template<typename T>',
      '  inline std::string to_s(const T& v) {',
      '    return to_s_scalar(v);',
      '  }',
      '',
      '  inline void emit(const std::string& json) {',
      '    if (stopped) return;',
      '    if (++step_count > MAX_STEPS) {',
      '      stopped = true;',
      '      std::cout << "\\n__VIZ__{\\"e\\":\\"limit\\",\\"msg\\":\\"Step limit reached\\"}\\n";',
      '      return;',
      '    }',
      '    std::cout << "__VIZ__" << json << "\\n";',
      '  }',
      '',
      '  template<typename T>',
      '  inline uintptr_t get_addr(const T& v) {',
      '    return reinterpret_cast<uintptr_t>(std::addressof(v));',
      '  }',
      '',
      '  template<typename T, size_t N>',
      '  inline uintptr_t get_addr(const T (&arr)[N]) {',
      '    return reinterpret_cast<uintptr_t>(std::addressof(arr));',
      '  }',
      '',
      '  inline void scope_exit(int ln, const char* vars_json) {',
      '    std::ostringstream ss;',
      '    ss << "{\\"e\\":\\"scope_exit\\",\\"line\\":" << ln << ",\\"vars\\":" << vars_json << "}";',
      '    emit(ss.str());',
      '  }',
      '',
      '  inline void line(int ln) {',
      '    std::ostringstream ss;',
      '    ss << "{\\"e\\":\\"line\\",\\"line\\":" << ln << "}";',
      '    emit(ss.str());',
      '  }',
      '',
      '  inline void line_token(int ln, int c_from, int c_to) {',
      '    std::ostringstream ss;',
      '    ss << "{\\"e\\":\\"line\\",\\"line\\":" << ln',
      '       << ",\\"colFrom\\":" << c_from',
      '       << ",\\"colTo\\":" << c_to << "}";',
      '    emit(ss.str());',
      '  }',
      '',
      '  template<typename C>',
      '  inline bool cond(int ln, const C& c) {',
      '    line(ln);',
      '    return static_cast<bool>(c);',
      '  }',
      '',
      '  inline void io_event(const char* kind, const char* var_name, int ln) {',
      '    std::ostringstream ss;',
      '    ss << "{\\"e\\":\\"io\\",\\"io\\":\\"" << kind << "\\",\\"var\\":\\"" << var_name << "\\",\\"line\\":" << ln << "}";',
      '    emit(ss.str());',
      '  }',
      '',
      '  inline void func_enter(const char* name, int ln, const std::string& params_json = "[]") {',
      '    std::ostringstream ss;',
      '    ss << "{\\"e\\":\\"func_enter\\",\\"name\\":\\"" << name << "\\",\\"line\\":" << ln << ",\\"params\\":" << params_json << "}";',
      '    emit(ss.str());',
      '  }',
      '',
      '  inline void func_exit(const char* name, int ln) {',
      '    std::ostringstream ss;',
      '    ss << "{\\"e\\":\\"func_exit\\",\\"name\\":\\"" << name << "\\",\\"line\\":" << ln << "}";',
      '    emit(ss.str());',
      '  }',
      '',
      '  template<typename T>',
      '  inline void global_decl(const char* name, const char* type, const T& val, int ln) {',
      '    std::ostringstream ss;',
      '    ss << "{\\"e\\":\\"global_decl\\",\\"name\\":\\"" << name << "\\",\\"type\\":\\"" << type << "\\",\\"val\\":\\"" << escape_json(to_s(val)) << "\\",\\"addr\\":\\"" << get_addr(val) << "\\",\\"line\\":" << ln << "}";',
      '    emit(ss.str());',
      '  }',
      '',
      '  template<typename T>',
      '  inline std::string arr_to_s(const T* ptr, size_t size) {',
      '    if (!ptr || size == 0) return "[]";',
      '    std::ostringstream ss;',
      '    ss << "[";',
      '    for (size_t i = 0; i < size && i < 15; ++i) {',
      '      if (i > 0) ss << ", ";',
      '      ss << to_s(ptr[i]);',
      '    }',
      '    if (size > 15) ss << ", ...";',
      '    ss << "]";',
      '    return ss.str();',
      '  }',
      '',
      '  template<typename T>',
      '  inline std::string arr_to_s(T* ptr, size_t size) {',
      '    if (!ptr || size == 0) return "[]";',
      '    std::ostringstream ss;',
      '    ss << "[";',
      '    for (size_t i = 0; i < size && i < 15; ++i) {',
      '      if (i > 0) ss << ", ";',
      '      ss << to_s(ptr[i]);',
      '    }',
      '    if (size > 15) ss << ", ...";',
      '    ss << "]";',
      '    return ss.str();',
      '  }',
      '',
      '  template<typename T>',
      '  inline std::string arr_nd_to_s(const T* base, const std::vector<size_t>& dims, size_t dim_idx = 0, size_t offset = 0) {',
      '    if (!base || dims.empty() || dim_idx >= dims.size()) return "[]";',
      '    size_t n = dims[dim_idx];',
      '    size_t stride = 1;',
      '    for (size_t k = dim_idx + 1; k < dims.size(); ++k) stride *= dims[k];',
      '    std::ostringstream ss;',
      '    ss << "[";',
      '    for (size_t i = 0; i < n && i < 15; ++i) {',
      '      if (i > 0) ss << ", ";',
      '      if (dim_idx + 1 == dims.size()) {',
      '        ss << to_s(base[offset + i]);',
      '      } else {',
      '        ss << arr_nd_to_s(base, dims, dim_idx + 1, offset + i * stride);',
      '      }',
      '    }',
      '    if (n > 15) ss << ", ...";',
      '    ss << "]";',
      '    return ss.str();',
      '  }',
      '',
      '  template<typename T>',
      '  inline void arr_decl(const char* name, const char* type, const T* ptr, std::initializer_list<size_t> dims, int ln) {',
      '    std::vector<size_t> dv(dims);',
      '    std::ostringstream ss;',
      '    ss << "{\\"e\\":\\"var_decl\\",\\"name\\":\\"" << name << "\\",\\"type\\":\\"" << type',
      '       << "\\",\\"val\\":\\"" << escape_json(arr_nd_to_s(ptr, dv))',
      '       << "\\",\\"addr\\":\\"" << reinterpret_cast<uintptr_t>(ptr)',
      '       << "\\",\\"line\\":" << ln << "}";',
      '    emit(ss.str());',
      '  }',
      '',
      '  template<typename T>',
      '  inline void arr_global_decl(const char* name, const char* type, const T* ptr, std::initializer_list<size_t> dims, int ln) {',
      '    std::vector<size_t> dv(dims);',
      '    std::ostringstream ss;',
      '    ss << "{\\"e\\":\\"global_decl\\",\\"name\\":\\"" << name << "\\",\\"type\\":\\"" << type',
      '       << "\\",\\"val\\":\\"" << escape_json(arr_nd_to_s(ptr, dv))',
      '       << "\\",\\"addr\\":\\"" << reinterpret_cast<uintptr_t>(ptr)',
      '       << "\\",\\"line\\":" << ln << "}";',
      '    emit(ss.str());',
      '  }',
      '',
      '  template<typename T>',
      '  inline void arr_set(const char* name, const char* type, const T* ptr, std::initializer_list<size_t> dims, int ln) {',
      '    (void)type;',
      '    std::vector<size_t> dv(dims);',
      '    std::ostringstream ss;',
      '    ss << "{\\"e\\":\\"var_set\\",\\"name\\":\\"" << name',
      '       << "\\",\\"val\\":\\"" << escape_json(arr_nd_to_s(ptr, dv))',
      '       << "\\",\\"addr\\":\\"" << reinterpret_cast<uintptr_t>(ptr)',
      '       << "\\",\\"line\\":" << ln << "}";',
      '    emit(ss.str());',
      '  }',
      '',
      '  template<typename T, typename E>',
      '  inline void arr_io_input_event(const char* base_name, const T* ptr, std::initializer_list<size_t> dims, const char* expr_name, const E& expr_val, int ln, int c_from, int c_to, bool is_getline = false) {',
      '    std::vector<size_t> dv(dims);',
      '    std::ostringstream ss;',
      '    ss << "{\\"e\\":\\"io\\",\\"io\\":\\"input\\",\\"name\\":\\"" << base_name',
      '       << "\\",\\"val\\":\\"" << escape_json(arr_nd_to_s(ptr, dv))',
      '       << "\\",\\"expr\\":\\"" << expr_name',
      '       << "\\",\\"inputVal\\":\\"" << escape_json(to_s(expr_val))',
      '       << "\\",\\"isGetline\\":" << (is_getline ? "true" : "false")',
      '       << ",\\"colFrom\\":" << c_from',
      '       << ",\\"colTo\\":" << c_to',
      '       << ",\\"addr\\":\\"" << reinterpret_cast<uintptr_t>(ptr) << "\\""',
      '       << ",\\"line\\":" << ln << "}";',
      '    emit(ss.str());',
      '  }',
      '',
      '  // Fixed-size compile-time arrays (1D, 2D, 3D, etc.)',
      '  template<typename T, size_t N>',
      '  inline void arr_decl(const char* name, const char* type, const T (&arr)[N], size_t, int ln) {',
      '    std::ostringstream ss;',
      '    ss << "{\\"e\\":\\"var_decl\\",\\"name\\":\\"" << name << "\\",\\"type\\":\\"" << type',
      '       << "\\",\\"val\\":\\"" << escape_json(to_s(arr))',
      '       << "\\",\\"addr\\":\\"" << get_addr(arr)',
      '       << "\\",\\"line\\":" << ln << "}";',
      '    emit(ss.str());',
      '  }',
      '',
      '  template<typename T, size_t N>',
      '  inline void arr_global_decl(const char* name, const char* type, const T (&arr)[N], size_t, int ln) {',
      '    std::ostringstream ss;',
      '    ss << "{\\"e\\":\\"global_decl\\",\\"name\\":\\"" << name << "\\",\\"type\\":\\"" << type',
      '       << "\\",\\"val\\":\\"" << escape_json(to_s(arr))',
      '       << "\\",\\"addr\\":\\"" << get_addr(arr)',
      '       << "\\",\\"line\\":" << ln << "}";',
      '    emit(ss.str());',
      '  }',
      '',
      '  template<typename T, size_t N>',
      '  inline void arr_set(const char* name, const char* type, const T (&arr)[N], size_t, int ln) {',
      '    std::ostringstream ss;',
      '    ss << "{\\"e\\":\\"var_set\\",\\"name\\":\\"" << name',
      '       << "\\",\\"val\\":\\"" << escape_json(to_s(arr))',
      '       << "\\",\\"addr\\":\\"" << get_addr(arr)',
      '       << "\\",\\"line\\":" << ln << "}";',
      '    emit(ss.str());',
      '  }',
      '',
      '  template<typename T, size_t N>',
      '  inline void arr_set(const char* name, const T (&arr)[N], size_t size, int ln) {',
      '    arr_set(name, "", arr, size, ln);',
      '  }',
      '',
      '  template<typename T, size_t N, typename E>',
      '  inline void arr_io_input_event(const char* base_name, const T (&arr)[N], size_t, const char* expr_name, const E& expr_val, int ln, int c_from, int c_to) {',
      '    std::ostringstream ss;',
      '    ss << "{\\"e\\":\\"io\\",\\"io\\":\\"input\\",\\"name\\":\\"" << base_name',
      '       << "\\",\\"val\\":\\"" << escape_json(to_s(arr))',
      '       << "\\",\\"expr\\":\\"" << expr_name',
      '       << "\\",\\"inputVal\\":\\"" << escape_json(to_s(expr_val))',
      '       << "\\",\\"isGetline\\":false"',
      '       << ",\\"colFrom\\":" << c_from',
      '       << ",\\"colTo\\":" << c_to',
      '       << ",\\"addr\\":\\"" << get_addr(arr) << "\\""',
      '       << ",\\"line\\":" << ln << "}";',
      '    emit(ss.str());',
      '  }',
      '',
      '  // Pointer overloads for decayed array parameters',
      '  template<typename T>',
      '  inline void arr_decl(const char* name, const char* type, const T* ptr, size_t size, int ln) {',
      '    std::ostringstream ss;',
      '    ss << "{\\"e\\":\\"var_decl\\",\\"name\\":\\"" << name << "\\",\\"type\\":\\"" << type',
      '       << "\\",\\"val\\":\\"" << escape_json(arr_to_s(ptr, size))',
      '       << "\\",\\"addr\\":\\"" << reinterpret_cast<uintptr_t>(ptr)',
      '       << "\\",\\"line\\":" << ln << "}";',
      '    emit(ss.str());',
      '  }',
      '',
      '  template<typename T>',
      '  inline void arr_set(const char* name, const char* type, const T* ptr, size_t size, int ln) {',
      '    std::ostringstream ss;',
      '    ss << "{\\"e\\":\\"var_set\\",\\"name\\":\\"" << name',
      '       << "\\",\\"val\\":\\"" << escape_json(arr_to_s(ptr, size))',
      '       << "\\",\\"addr\\":\\"" << reinterpret_cast<uintptr_t>(ptr)',
      '       << "\\",\\"line\\":" << ln << "}";',
      '    emit(ss.str());',
      '  }',
      '',
      '  template<typename T>',
      '  inline void arr_set(const char* name, const T* ptr, size_t size, int ln) {',
      '    arr_set(name, "", ptr, size, ln);',
      '  }',
      '',
      '  template<typename T>',
      '  inline void var_decl(const char* name, const char* type, const T& val, int ln) {',
      '    std::ostringstream ss;',
      '    ss << "{\\"e\\":\\"var_decl\\",\\"name\\":\\"" << name << "\\",\\"type\\":\\"" << type << "\\",\\"val\\":\\"" << escape_json(to_s(val)) << "\\",\\"addr\\":\\"" << get_addr(val) << "\\",\\"line\\":" << ln << "}";',
      '    emit(ss.str());',
      '  }',
      '',
      '  template<typename T>',
      '  inline void var_set(const char* name, const T& val, int ln) {',
      '    std::ostringstream ss;',
      '    ss << "{\\"e\\":\\"var_set\\",\\"name\\":\\"" << name << "\\",\\"val\\":\\"" << escape_json(to_s(val)) << "\\",\\"addr\\":\\"" << get_addr(val) << "\\",\\"line\\":" << ln << "}";',
      '    emit(ss.str());',
      '  }',
      '',
      '  template<typename T, typename E>',
      '  inline void io_input_event(const char* base_name, const T& base_val, const char* expr_name, const E& expr_val, int ln, int c_from, int c_to, bool is_getline = false) {',
      '    std::ostringstream ss;',
      '    ss << "{\\"e\\":\\"io\\",\\"io\\":\\"input\\",\\"name\\":\\"" << base_name',
      '       << "\\",\\"val\\":\\"" << escape_json(to_s(base_val))',
      '       << "\\",\\"expr\\":\\"" << expr_name',
      '       << "\\",\\"inputVal\\":\\"" << escape_json(to_s(expr_val))',
      '       << "\\",\\"isGetline\\":" << (is_getline ? "true" : "false")',
      '       << ",\\"colFrom\\":" << c_from',
      '       << ",\\"colTo\\":" << c_to',
      '       << ",\\"addr\\":\\"" << get_addr(base_val) << "\\""',
      '       << ",\\"line\\":" << ln << "}";',
      '    emit(ss.str());',
      '  }',
      '',
      '  template<typename T, typename S, typename E>',
      '  inline void arr_io_input_event(const char* base_name, T&& arr, S size, const char* expr_name, const E& expr_val, int ln, int c_from, int c_to) {',
      '    std::ostringstream ss;',
      '    ss << "{\\"e\\":\\"io\\",\\"io\\":\\"input\\",\\"name\\":\\"" << base_name',
      '       << "\\",\\"val\\":\\"" << escape_json(serialize_arr(arr, size))',
      '       << "\\",\\"expr\\":\\"" << expr_name',
      '       << "\\",\\"inputVal\\":\\"" << escape_json(to_s(expr_val))',
      '       << "\\",\\"isGetline\\":false"',
      '       << ",\\"colFrom\\":" << c_from',
      '       << ",\\"colTo\\":" << c_to',
      '       << ",\\"addr\\":\\"" << get_arr_addr(arr) << "\\""',
      '       << ",\\"line\\":" << ln << "}";',
      '    emit(ss.str());',
      '  }',
      '',
      '  inline void var_end(const char* name) {',
      '    std::ostringstream ss;',
      '    ss << "{\\"e\\":\\"var_end\\",\\"name\\":\\"" << name << "\\"}";',
      '    emit(ss.str());',
      '  }',
      '',
      '  template<typename T>',
      '  inline int for_step(const char* name, const T& val, int ln, int c_from, int c_to) {',
      '    std::ostringstream ss;',
      '    ss << "{\\"e\\":\\"var_step\\",\\"name\\":\\"" << name',
      '       << "\\",\\"val\\":\\"" << escape_json(to_s(val))',
      '       << "\\",\\"addr\\":\\"" << get_addr(val) << "\\""',
      '       << ",\\"line\\":" << ln',
      '       << ",\\"colFrom\\":" << c_from',
      '       << ",\\"colTo\\":" << c_to << "}";',
      '    emit(ss.str());',
      '    return 0;',
      '  }',
      '',
      '  template<typename T1, typename T2>',
      '  inline int for_step2(const char* name1, const T1& val1,',
      '                       const char* name2, const T2& val2,',
      '                       int ln, int c_from, int c_to) {',
      '    std::ostringstream ss;',
      '    ss << "{\\"e\\":\\"var_step2\\",\\"name1\\":\\"" << name1',
      '       << "\\",\\"val1\\":\\"" << escape_json(to_s(val1))',
      '       << "\\",\\"addr1\\":\\"" << get_addr(val1) << "\\""',
      '       << ",\\"name2\\":\\"" << name2',
      '       << "\\",\\"val2\\":\\"" << escape_json(to_s(val2))',
      '       << "\\",\\"addr2\\":\\"" << get_addr(val2) << "\\""',
      '       << ",\\"line\\":" << ln',
      '       << ",\\"colFrom\\":" << c_from',
      '       << ",\\"colTo\\":" << c_to << "}";',
      '    emit(ss.str());',
      '    return 0;',
      '  }',
      '',
      '  inline int for_step_simple(int ln, int c_from, int c_to) {',
      '    line_token(ln, c_from, c_to);',
      '    return 0;',
      '  }',
      '',
      '  template<typename T, typename C>',
      '  inline bool for_cond(const char* name, const char* type, const T& val, int ln, int c_from, int c_to, const C& cond, bool is_decl = true) {',
      '    bool res = static_cast<bool>(cond);',
      '    std::ostringstream ss;',
      '    ss << "{\\"e\\":\\"for_cond\\",\\"name\\":\\"" << name',
      '       << "\\",\\"type\\":\\"" << type',
      '       << "\\",\\"val\\":\\"" << escape_json(to_s(val))',
      '       << "\\",\\"line\\":" << ln',
      '       << ",\\"colFrom\\":" << c_from',
      '       << ",\\"colTo\\":" << c_to',
      '       << ",\\"res\\":" << (res ? "true" : "false");',
      '    if (!res && is_decl) {',
      '      ss << ",\\"endVar\\":\\"" << name << "\\"";',
      '    }',
      '    ss << "}";',
      '    emit(ss.str());',
      '    return res;',
      '  }',
      '',
      '  template<typename T1, typename T2, typename C>',
      '  inline bool for_cond2(const char* name1, const char* type1, const T1& val1,',
      '                        const char* name2, const char* type2, const T2& val2,',
      '                        int ln, int c_from, int c_to, const C& cond, bool is_decl = true) {',
      '    bool res = static_cast<bool>(cond);',
      '    std::ostringstream ss;',
      '    ss << "{\\"e\\":\\"for_cond2\\",\\"name1\\":\\"" << name1',
      '       << "\\",\\"type1\\":\\"" << type1',
      '       << "\\",\\"val1\\":\\"" << escape_json(to_s(val1))',
      '       << "\\",\\"name2\\":\\"" << name2',
      '       << "\\",\\"type2\\":\\"" << type2',
      '       << "\\",\\"val2\\":\\"" << escape_json(to_s(val2))',
      '       << "\\",\\"line\\":" << ln',
      '       << ",\\"colFrom\\":" << c_from',
      '       << ",\\"colTo\\":" << c_to',
      '       << ",\\"res\\":" << (res ? "true" : "false");',
      '    if (!res && is_decl) {',
      '      ss << ",\\"endVar1\\":\\"" << name1 << "\\",\\"endVar2\\":\\"" << name2 << "\\"";',
      '    }',
      '    ss << "}";',
      '    emit(ss.str());',
      '    return res;',
      '  }',
      '',
      '  template<typename C>',
      '  inline bool for_cond_simple(int ln, int c_from, int c_to, const C& cond) {',
      '    bool res = static_cast<bool>(cond);',
      '    std::ostringstream ss;',
      '    ss << "{\\"e\\":\\"line\\",\\"line\\":" << ln',
      '       << ",\\"colFrom\\":" << c_from',
      '       << ",\\"colTo\\":" << c_to << "}";',
      '    emit(ss.str());',
      '    return res;',
      '  }',
      '',
      '  struct FuncScope {',
      '    const char* name;',
      '    int line;',
      '    FuncScope(const char* n, int ln) : name(n), line(ln) {}',
      '    ~FuncScope() { func_exit(name, line); }',
      '  };',
      '}',
      ''
    ].join('\n');

    function splitSameLineControl(line) {
      let code = line;
      const commentIdx = line.indexOf('//');
      if (commentIdx !== -1) {
        let inStr = false, quote = '';
        for (let c = 0; c < commentIdx; c++) {
          if ((line[c] === '"' || line[c] === "'") && (c === 0 || line[c - 1] !== '\\')) {
            if (!inStr) { inStr = true; quote = line[c]; }
            else if (quote === line[c]) inStr = false;
          }
        }
        if (!inStr) code = line.slice(0, commentIdx);
      }

      const trimmed = code.trim();
      if (!trimmed || trimmed.startsWith('#')) return [line];

      const indentMatch = code.match(/^(\s*)/);
      const indent = indentMatch ? indentMatch[1] : '';

      const ctrlMatch = trimmed.match(/^(?:(?:\}\s*)?else\s+if|if|while|for)\s*\(/);
      if (ctrlMatch) {
        const kwStart = code.indexOf(ctrlMatch[0]);
        const openParen = code.indexOf('(', kwStart);
        let depth = 0;
        let closeParen = -1;
        let inStr = false, quote = '';
        for (let i = openParen; i < code.length; i++) {
          const c = code[i];
          if ((c === '"' || c === "'") && (i === 0 || code[i - 1] !== '\\')) {
            if (!inStr) { inStr = true; quote = c; }
            else if (quote === c) inStr = false;
          } else if (!inStr) {
            if (c === '(') depth++;
            else if (c === ')') {
              depth--;
              if (depth === 0) { closeParen = i; break; }
            }
          }
        }

        if (closeParen !== -1) {
          const header = code.slice(0, closeParen + 1);
          const rest = code.slice(closeParen + 1).trim();
          if (rest.length > 0 && !rest.startsWith('{') && !rest.startsWith(';')) {
            const sub = splitRest(rest, indent + '    ');
            return [header, ...sub];
          }
        }
      }

      const elseMatch = trimmed.match(/^(?:(?:\}\s*)?)else(?:\s+|$)(.*)/);
      if (elseMatch && !trimmed.startsWith('else if')) {
        const kwStart = code.indexOf('else');
        const header = code.slice(0, kwStart + 4);
        const rest = code.slice(kwStart + 4).trim();
        if (rest.length > 0 && !rest.startsWith('{') && !rest.startsWith(';') && !rest.startsWith('if')) {
          const sub = splitRest(rest, indent + '    ');
          return [header, ...sub];
        }
      }

      return [line];
    }

    function splitRest(rest, indent) {
      let elseIdx = -1;
      let inStr = false, quote = '', depth = 0;
      for (let i = 0; i < rest.length; i++) {
        const c = rest[i];
        if ((c === '"' || c === "'") && (i === 0 || rest[i - 1] !== '\\')) {
          if (!inStr) { inStr = true; quote = c; }
          else if (quote === c) inStr = false;
        } else if (!inStr) {
          if (c === '(' || c === '{') depth++;
          else if (c === ')' || c === '}') depth--;
          else if (depth === 0 && rest.slice(i).match(/^else\b/)) {
            elseIdx = i;
            break;
          }
        }
      }

      if (elseIdx !== -1) {
        const firstPart = rest.slice(0, elseIdx).trim();
        const elsePart = rest.slice(elseIdx).trim();
        const res = [];
        if (firstPart) res.push(...splitSameLineControl(indent + firstPart));
        if (elsePart) res.push(...splitSameLineControl(indent + elsePart));
        return res;
      }

      return [indent + rest];
    }

    function checkBracelessControlHeader(line) {
      let code = line;
      const commentIdx = line.indexOf('//');
      if (commentIdx !== -1) {
        let inStr = false, quote = '';
        for (let c = 0; c < commentIdx; c++) {
          if ((line[c] === '"' || line[c] === "'") && (c === 0 || line[c - 1] !== '\\')) {
            if (!inStr) { inStr = true; quote = line[c]; }
            else if (quote === line[c]) inStr = false;
          }
        }
        if (!inStr) code = line.slice(0, commentIdx);
      }

      const trimmed = code.trim();
      if (trimmed.endsWith('{') || trimmed.endsWith(';') || trimmed.endsWith(':')) return false;

      const ctrlMatch = trimmed.match(/^(?:(?:\}\s*)?else\s+if|if|while|for)\s*\(/);
      if (ctrlMatch) {
        const kwStart = code.indexOf(ctrlMatch[0]);
        const openParen = code.indexOf('(', kwStart);
        let depth = 0;
        let closeParen = -1;
        let inStr = false, quote = '';
        for (let i = openParen; i < code.length; i++) {
          const c = code[i];
          if ((c === '"' || c === "'") && (i === 0 || code[i - 1] !== '\\')) {
            if (!inStr) { inStr = true; quote = c; }
            else if (quote === line[c]) inStr = false;
          } else if (!inStr) {
            if (c === '(') depth++;
            else if (c === ')') {
              depth--;
              if (depth === 0) { closeParen = i; break; }
            }
          }
        }
        if (closeParen !== -1) {
          const rest = code.slice(closeParen + 1).trim();
          if (rest === '' || rest === '{') {
            return rest === '';
          }
        }
      }

      if (/^(?:(?:\}\s*)?)else\s*$/.test(trimmed)) {
        return true;
      }

      return false;
    }

    function normalizeControlFlow(code) {
      const rawLines = code.split('\n');
      const step1 = [];

      for (let i = 0; i < rawLines.length; i++) {
        const origLineNum = i + 1;
        const split = splitSameLineControl(rawLines[i]);
        for (const s of split) {
          step1.push({ text: s, origLineNum });
        }
      }

      const step2 = [];
      const pendingCloses = [];

      for (let i = 0; i < step1.length; i++) {
        const item = step1[i];
        const line = item.text;
        const origLineNum = item.origLineNum;
        const trimmed = line.trim();

        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//') || trimmed.startsWith('/*')) {
          step2.push(item);
          continue;
        }

        const isControlHeader = checkBracelessControlHeader(line);
        if (isControlHeader) {
          step2.push({ text: line + ' {', origLineNum });
          pendingCloses.push({ needStatement: true });
          continue;
        }

        step2.push(item);

        if (trimmed.endsWith(';') || trimmed.endsWith('}')) {
          while (pendingCloses.length > 0) {
            const top = pendingCloses[pendingCloses.length - 1];
            if (top.needStatement) {
              pendingCloses.pop();
              let nextIsElse = false;
              for (let j = i + 1; j < step1.length; j++) {
                const nextTrimmed = step1[j].text.trim();
                if (!nextTrimmed || nextTrimmed.startsWith('//') || nextTrimmed.startsWith('/*')) continue;
                if (/^(?:\}\s*)?else\b/.test(nextTrimmed)) nextIsElse = true;
                break;
              }
              const indent = line.match(/^(\s*)/)[1];
              step2.push({ text: indent + '}', origLineNum });
              if (nextIsElse) break;
            } else {
              break;
            }
          }
        }
      }

      while (pendingCloses.length > 0) {
        pendingCloses.pop();
        step2.push({ text: '}', origLineNum: rawLines.length });
      }

      return step2;
    }

    const normalized = normalizeControlFlow(userCode);
    const lines = normalized.map(x => x.text);
    const lineNums = normalized.map(x => x.origLineNum);
    const outLines = [];
    const knownArrays = new Set();
    const knownArrayTypes = new Map();
    const knownArrayRanks = new Map();
    const buildArrArgs = (name, rank) => {
      const r = Math.max(1, rank || 1);
      let baseExpr = name;
      const dims = [];
      for (let d = 0; d < r; d++) {
        const nextExpr = baseExpr + '[0]';
        dims.push(`(sizeof(${nextExpr}) ? sizeof(${baseExpr})/sizeof(${nextExpr}) : 0)`);
        baseExpr = nextExpr;
      }
      return `&${baseExpr}, {${dims.join(', ')}}`;
    };
    const countBraces = (str) => {
      let open = 0, close = 0;
      let inStr = false, quote = '';
      for (let i = 0; i < str.length; i++) {
        const c = str[i];
        if (!inStr && c === '/' && str[i + 1] === '/') break;
        if ((c === '"' || c === "'") && (i === 0 || str[i - 1] !== '\\')) {
          if (!inStr) { inStr = true; quote = c; }
          else if (quote === c) inStr = false;
        } else if (!inStr) {
          if (c === '{') open++;
          else if (c === '}') close++;
        }
      }
      return { open, close };
    };
    let scopeStack = [];
    const activeForLoops = [];
    let inFunction = false;
    let braceDepth = 0;
    let funcBraceDepth = 0;
    let pendingFunc = null;

    // First pass: collect all global variable declarations
    const globalVars = [];
    let passInFunc = false;
    let pendingPassFunc = false;
    let passDepth = 0;
    let passInInit = false;
    let passInitDepth = 0;
    let passInitBuffer = '';
    let passInitStartLine = 0;
    for (let pi = 0; pi < lines.length; pi++) {
      const pLine = lines[pi];
      const pTrimmed = pLine.trim();
      if (!pTrimmed || pTrimmed.startsWith('//') || pTrimmed.startsWith('/*') || pTrimmed.startsWith('#')) continue;
      if (passInInit) {
        const bc = countBraces(pLine);
        passInitDepth += bc.open - bc.close;
        passInitBuffer += ' ' + pTrimmed;
        if (passInitDepth <= 0 && pTrimmed.endsWith(';')) {
          passInInit = false;
          const dm = parseDecl(passInitBuffer);
          if (dm) {
            for (const v of dm.vars) {
              const actualType = v.arrType || (dm.type + (v.isArray ? '[]' : ''));
              if (v.isArray) {
                knownArrays.add(v.name);
                knownArrayTypes.set(v.name, actualType);
                knownArrayRanks.set(v.name, v.dimCount || 1);
              }
              globalVars.push({ name: v.name, type: actualType, line: passInitStartLine, isArray: v.isArray, dimCount: v.dimCount || 1 });
            }
          }
          passInitBuffer = '';
        }
        continue;
      }
      const singleLineFMatch = pTrimmed.match(/^((?:(?:const|unsigned|signed|static|inline|virtual|long)\s+)*[a-zA-Z_0-9:<>\*&]+(?:\s+[*&]*)?)\s+([a-zA-Z_0-9]+)\s*\(([^)]*)\)\s*\{(.+)\}\s*$/);
      if (singleLineFMatch && !['if', 'for', 'while', 'switch', 'catch'].includes(singleLineFMatch[2])) {
        continue;
      }
      const fMatch = pTrimmed.match(/^((?:(?:const|unsigned|signed|static|inline|virtual|long)\s+)*[a-zA-Z_0-9:<>\*&]+(?:\s+[*&]*)?)\s+([a-zA-Z_0-9]+)\s*\(([^)]*)\)\s*(\{?)\s*$/);
      if (fMatch && !['if', 'for', 'while', 'switch', 'catch'].includes(fMatch[2])) {
        if (fMatch[4] === '{' || pTrimmed.endsWith('{')) {
          passInFunc = true;
          pendingPassFunc = false;
        } else {
          pendingPassFunc = true;
        }
      } else if (pendingPassFunc && pTrimmed.startsWith('{')) {
        passInFunc = true;
        pendingPassFunc = false;
      }
      const { open: ob, close: cb } = countBraces(pLine);
      if (!passInFunc && !pendingPassFunc && passDepth === 0 && ob > cb && pTrimmed.includes('=')) {
        passInInit = true;
        passInitDepth = ob - cb;
        passInitBuffer = pTrimmed;
        passInitStartLine = lineNums[pi];
        continue;
      }
      passDepth += ob - cb;
      if (passDepth <= 0 && cb > 0) {
        passInFunc = false;
        pendingPassFunc = false;
      }
      if (!passInFunc && !pendingPassFunc && passDepth === 0) {
        const dm = parseDecl(pLine);
        if (dm) {
          for (const v of dm.vars) {
            const actualType = v.arrType || (dm.type + (v.isArray ? '[]' : ''));
            if (v.isArray) {
              knownArrays.add(v.name);
              knownArrayTypes.set(v.name, actualType);
              knownArrayRanks.set(v.name, v.dimCount || 1);
            }
            globalVars.push({ name: v.name, type: actualType, line: lineNums[pi], isArray: v.isArray, dimCount: v.dimCount || 1 });
          }
        }
      }
    }

    let inInitializer = false;
    let initBraceDepth = 0;
    let initBuffer = '';
    let initStartLine = 0;

    const buildParamsJson = (pList) => {
      if (!pList.length) return '"[]"';
      const parts = pList.map((p, idx) => {
        const sep = idx === 0 ? '' : ',';
        const valExpr = (p.isArray && p.firstDim)
          ? `__viz::arr_to_s(${p.name}, ${p.firstDim})`
          : `__viz::to_s(${p.name})`;
        return `std::string("${sep}{\\"name\\":\\"${p.name}\\",\\"type\\":\\"${p.type}\\",\\"addr\\":\\"") + std::to_string(__viz::get_addr(${p.name})) + std::string("\\",\\"val\\":\\"") + __viz::escape_json(${valExpr}) + "\\"}"`;
      });
      return `std::string("[") + ` + parts.join(' + ') + ` + "]"`;
    };

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const rawLine = lines[lineIdx];
      const lineNum = lineNums[lineIdx];
      const trimmed = rawLine.trim();

      // Check preprocessor, comments, empty
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('#')) {
        outLines.push(rawLine);
        continue;
      }

      // Check single-line function definitions: Type FuncName(args) { ... }
      const singleLineFuncMatch = trimmed.match(/^((?:(?:const|unsigned|signed|static|inline|virtual|long)\s+)*[a-zA-Z_0-9:<>\*&]+(?:\s+[*&]*)?)\s+([a-zA-Z_0-9]+)\s*\(([^)]*)\)\s*\{(.+)\}\s*$/);
      if (singleLineFuncMatch && !['if', 'for', 'while', 'switch', 'catch'].includes(singleLineFuncMatch[2])) {
        const funcName = singleLineFuncMatch[2].trim();
        const paramsStr = singleLineFuncMatch[3].trim();
        const params = [];
        if (paramsStr && paramsStr !== 'void') {
          const parts = paramsStr.split(',');
          for (const p of parts) {
            const pObj = parseParam(p);
            if (pObj) {
              params.push(pObj);
              if (pObj.isArray) {
                knownArrays.add(pObj.name);
                knownArrayTypes.set(pObj.name, pObj.type);
              }
            }
          }
        }

        const openBraceIdx = rawLine.indexOf('{');
        const closeBraceIdx = rawLine.lastIndexOf('}');
        const prefix = rawLine.slice(0, openBraceIdx + 1);
        const suffix = rawLine.slice(closeBraceIdx);
        const inner = rawLine.slice(openBraceIdx + 1, closeBraceIdx);

        let gvInjections = '';
        if (funcName === 'main' && globalVars.length > 0) {
          for (const gv of globalVars) {
            if (gv.isArray) {
              gvInjections += ` __viz::arr_global_decl("${gv.name}", "${gv.type}", ${buildArrArgs(gv.name, gv.dimCount)}, ${gv.line});`;
            } else {
              gvInjections += ` __viz::global_decl("${gv.name}", "${gv.type}", ${gv.name}, ${gv.line});`;
            }
          }
        }

        const isOutput = inner.includes('cout') || inner.includes('printf');
        let extraIo = '';
        if (isOutput) {
          extraIo = ` __viz::io_event("output", "", ${lineNum});`;
        }

        outLines.push(`${prefix} __viz::FuncScope __viz_fs("${funcName}", ${lineNum}); __viz::func_enter("${funcName}", ${lineNum}, ${buildParamsJson(params)});${gvInjections} __viz::line(${lineNum});${extraIo} ${inner} ${suffix}`);
        continue;
      }

      // Check function definitions: Type FuncName(args) [{]
      const funcMatch = trimmed.match(/^((?:(?:const|unsigned|signed|static|inline|virtual|long)\s+)*[a-zA-Z_0-9:<>\*&]+(?:\s+[*&]*)?)\s+([a-zA-Z_0-9]+)\s*\(([^)]*)\)\s*(\{?)\s*$/);
      if (funcMatch && !['if', 'for', 'while', 'switch', 'catch'].includes(funcMatch[2])) {
        const funcName = funcMatch[2].trim();
        const paramsStr = funcMatch[3].trim();
        const hasOpenBrace = funcMatch[4] === '{' || trimmed.endsWith('{');

        const params = [];
        if (paramsStr && paramsStr !== 'void') {
          const parts = paramsStr.split(',');
          for (const p of parts) {
            const pObj = parseParam(p);
            if (pObj) {
              params.push(pObj);
              if (pObj.isArray) {
                knownArrays.add(pObj.name);
                knownArrayTypes.set(pObj.name, pObj.type);
              }
            }
          }
        }

        if (hasOpenBrace) {
          inFunction = true;
          funcBraceDepth = braceDepth;
          braceDepth += (rawLine.match(/\{/g) || []).length - (rawLine.match(/\}/g) || []).length;
          scopeStack = [{ depth: braceDepth, vars: [] }];
          activeForLoops.length = 0;
          outLines.push(rawLine);
          outLines.push(`    __viz::FuncScope __viz_fs("${funcName}", ${lineNum});`);
          outLines.push(`    __viz::func_enter("${funcName}", ${lineNum}, ${buildParamsJson(params)});`);
          if (funcName === 'main' && globalVars.length > 0) {
            for (const gv of globalVars) {
              if (gv.isArray) {
                outLines.push(`    __viz::arr_global_decl("${gv.name}", "${gv.type}", ${buildArrArgs(gv.name, gv.dimCount)}, ${gv.line});`);
              } else {
                outLines.push(`    __viz::global_decl("${gv.name}", "${gv.type}", ${gv.name}, ${gv.line});`);
              }
            }
          }
          continue;
        } else {
          pendingFunc = { funcName, lineNum, params };
          outLines.push(rawLine);
          continue;
        }
      }

      if (pendingFunc && trimmed.startsWith('{')) {
        inFunction = true;
        funcBraceDepth = braceDepth;
        braceDepth += (rawLine.match(/\{/g) || []).length - (rawLine.match(/\}/g) || []).length;
        scopeStack = [{ depth: braceDepth, vars: [] }];
        activeForLoops.length = 0;
        outLines.push(rawLine);
        outLines.push(`    __viz::FuncScope __viz_fs("${pendingFunc.funcName}", ${pendingFunc.lineNum});`);
        outLines.push(`    __viz::func_enter("${pendingFunc.funcName}", ${pendingFunc.lineNum}, ${buildParamsJson(pendingFunc.params)});`);
        if (pendingFunc.funcName === 'main' && globalVars.length > 0) {
          for (const gv of globalVars) {
            if (gv.isArray) {
              outLines.push(`    __viz::arr_global_decl("${gv.name}", "${gv.type}", ${buildArrArgs(gv.name, gv.dimCount)}, ${gv.line});`);
            } else {
              outLines.push(`    __viz::global_decl("${gv.name}", "${gv.type}", ${gv.name}, ${gv.line});`);
            }
          }
        }
        pendingFunc = null;
        continue;
      }

      // Check 3-part for loop: for (init; cond; inc) [{]
      const forStmt = inFunction && parseForStatement(rawLine);
      if (forStmt) {
        const initVars = parseInitVars(forStmt.init.text);
        const isDecl = initVars.isDecl !== undefined ? initVars.isDecl : true;

        // 1. Emit init token highlight before the for loop
        if (forStmt.init.from < forStmt.init.to) {
          outLines.push(`    __viz::line_token(${lineNum}, ${forStmt.init.from}, ${forStmt.init.to});`);
        }

        // 2. Wrap condition
        const condText = forStmt.cond.text.length > 0 ? forStmt.cond.text : 'true';
        const condFrom = forStmt.cond.from;
        const condTo = forStmt.cond.to;
        let condWrapped = '';
        if (initVars.length === 1) {
          const v = initVars[0];
          condWrapped = `__viz::for_cond("${v.name}", "${v.type}", ${v.name}, ${lineNum}, ${condFrom}, ${condTo}, (${condText}), ${isDecl ? 'true' : 'false'})`;
        } else if (initVars.length >= 2) {
          const v0 = initVars[0], v1 = initVars[1];
          condWrapped = `__viz::for_cond2("${v0.name}", "${v0.type}", ${v0.name}, "${v1.name}", "${v1.type}", ${v1.name}, ${lineNum}, ${condFrom}, ${condTo}, (${condText}), ${isDecl ? 'true' : 'false'})`;
        } else {
          condWrapped = `__viz::for_cond_simple(${lineNum}, ${condFrom}, ${condTo}, (${condText}))`;
        }

        // 3. Wrap update expression (inc)
        const incText = forStmt.inc.text;
        const incFrom = forStmt.inc.from;
        const incTo = forStmt.inc.to;
        let incWrapped = incText;
        if (incText.length > 0) {
          if (initVars.length === 1) {
            const v = initVars[0];
            incWrapped = `((${incText}), __viz::for_step("${v.name}", ${v.name}, ${lineNum}, ${incFrom}, ${incTo}))`;
          } else if (initVars.length >= 2) {
            const v0 = initVars[0], v1 = initVars[1];
            incWrapped = `((${incText}), __viz::for_step2("${v0.name}", ${v0.name}, "${v1.name}", ${v1.name}, ${lineNum}, ${incFrom}, ${incTo}))`;
          } else {
            const incVarM = incText.match(/(?:^|[^a-zA-Z_0-9])([a-zA-Z_0-9]+)\s*(?:\+\+|--|\+=|-=|=)|(?:^|[^a-zA-Z_0-9])(?:\+\+|--)\s*([a-zA-Z_0-9]+)/);
            if (incVarM) {
              const vn = incVarM[1] || incVarM[2];
              incWrapped = `((${incText}), __viz::for_step("${vn}", ${vn}, ${lineNum}, ${incFrom}, ${incTo}))`;
            } else {
              incWrapped = `((${incText}), __viz::for_step_simple(${lineNum}, ${incFrom}, ${incTo}))`;
            }
          }
        }

        outLines.push(`${forStmt.indent}for (${forStmt.init.text}; ${condWrapped}; ${incWrapped})${forStmt.rest}`);
        if (forStmt.rest.includes('{')) {
          scopeStack.push({ depth: braceDepth + 1, vars: [] });
          if (isDecl && initVars.length > 0) {
            activeForLoops.push({ depth: braceDepth + 1, vars: initVars.map(v => v.name), hasBrace: true });
          }
        } else if (isDecl && initVars.length > 0) {
          activeForLoops.push({ depth: braceDepth, vars: initVars.map(v => v.name), hasBrace: false });
        }
        braceDepth += (rawLine.match(/\{/g) || []).length - (rawLine.match(/\}/g) || []).length;
        continue;
      }

      // Check range-based for loop: for (decl : expr) [{]
      const forRangeMatch = inFunction && rawLine.match(/^(\s*)for\s*\(([^:]+):([^)]+)\)\s*(\{?)\s*$/);
      if (forRangeMatch) {
        const indent = forRangeMatch[1];
        const decl = forRangeMatch[2].trim();
        const range = forRangeMatch[3].trim();
        const brace = forRangeMatch[4] || '';

        const rangeVar = parseRangeDecl(decl);
        outLines.push(`    __viz::line(${lineNum});`);
        outLines.push(`${indent}for (${decl} : ${range})${brace ? ' ' + brace : ''}`);
        if (brace === '{') {
          scopeStack.push({ depth: braceDepth + 1, vars: [] });
          if (rangeVar) {
            outLines.push(`    __viz::line(${lineNum});`);
            outLines.push(`    __viz::var_decl("${rangeVar.name}", "${rangeVar.type}", ${rangeVar.name}, ${lineNum});`);
            scopeStack[scopeStack.length - 1].vars.push(rangeVar.name);
          }
        }
        braceDepth += (rawLine.match(/\{/g) || []).length - (rawLine.match(/\}/g) || []).length;
        continue;
      }

      // Strip comments
      let codeWithoutComment = rawLine;
      const commentIdx = rawLine.indexOf('//');
      if (commentIdx !== -1) {
        let inStr = false, quote = '';
        for (let c = 0; c < commentIdx; c++) {
          if ((rawLine[c] === '"' || rawLine[c] === "'") && (c === 0 || rawLine[c - 1] !== '\\')) {
            if (!inStr) { inStr = true; quote = rawLine[c]; }
            else if (quote === rawLine[c]) inStr = false;
          }
        }
        if (!inStr) codeWithoutComment = rawLine.slice(0, commentIdx);
      }
      const trimmedCode = codeWithoutComment.trim();

      const { open: openBraces, close: closeBraces } = countBraces(codeWithoutComment);

      // Continue an ongoing multi-line brace initializer (e.g. multi-line 1D/2D array initialization)
      if (inInitializer) {
        outLines.push(rawLine);
        initBraceDepth += openBraces - closeBraces;
        initBuffer += ' ' + trimmedCode;
        if (initBraceDepth <= 0 && trimmedCode.endsWith(';')) {
          inInitializer = false;
          if (inFunction) {
            const multiDecl = parseDecl(initBuffer);
            if (multiDecl) {
              for (const v of multiDecl.vars) {
                if (scopeStack.length > 0) {
                  scopeStack[scopeStack.length - 1].vars.push(v.name);
                }
                if (v.isArray) {
                  knownArrays.add(v.name);
                  const actualType = v.arrType || (multiDecl.type + '[]');
                  knownArrayTypes.set(v.name, actualType);
                  knownArrayRanks.set(v.name, v.dimCount || 1);
                  outLines.push(`    __viz::arr_decl("${v.name}", "${actualType}", ${buildArrArgs(v.name, v.dimCount)}, ${initStartLine});`);
                } else {
                  outLines.push(`    __viz::var_decl("${v.name}", "${multiDecl.type}", ${v.name}, ${initStartLine});`);
                }
              }
            }
          }
          initBuffer = '';
        }
        continue;
      }

      // Detect start of a multi-line brace initializer: e.g. `string arr[2][2] = {`
      if (openBraces > closeBraces && trimmedCode.includes('=') && !trimmedCode.endsWith(';')) {
        const beforeEq = trimmedCode.slice(0, trimmedCode.indexOf('=')).trim();
        if (!/^(?:if|else|while|for|switch|return)\b/.test(beforeEq)) {
          if (inFunction && !rawLine.startsWith('#')) {
            outLines.push(`    __viz::line(${lineNum});`);
          }
          outLines.push(rawLine);
          inInitializer = true;
          initBraceDepth = openBraces - closeBraces;
          initBuffer = trimmedCode;
          initStartLine = lineNum;
          continue;
        }
      }

      let closingVars = [];
      let suppressLine = false;
      if (closeBraces > 0 && inFunction) {
        const targetDepth = braceDepth + openBraces - closeBraces;
        while (scopeStack.length > 0 && scopeStack[scopeStack.length - 1].depth > targetDepth) {
          const popped = scopeStack.pop();
          if (popped.depth > funcBraceDepth + 1 && popped.vars && popped.vars.length > 0) {
            closingVars = closingVars.concat(popped.vars);
          }
        }
        if (closingVars.length > 0) {
          outLines.push(`    __viz::scope_exit(${lineNum}, ${JSON.stringify(JSON.stringify(closingVars))});`);
          if (trimmed === '}') {
            suppressLine = true;
          }
        }
      }

      if (openBraces > 0 && inFunction) {
        for (let b = 0; b < openBraces; b++) {
          const d = braceDepth - closeBraces + b + 1;
          if (d > funcBraceDepth + 1) {
            scopeStack.push({ depth: d, vars: [] });
          }
        }
      }

      // Variable declaration
      const declMatch = parseDecl(trimmedCode);

      // Modified variables (assignments and increments/decrements)
      const modifiedVars = new Set();
      const reserved = new Set(['return', 'if', 'else', 'while', 'for', 'do', 'switch', 'case', 'break', 'continue',
                                'goto', 'typedef', 'using', 'namespace', 'cout', 'cin', 'cerr', 'std', '__viz']);
      const assignRe = /(?:^|[;{}]\s*)([a-zA-Z_0-9]+)\s*(?:=(?!=)|\+=|-=|\*=|\/=|%=|<<=|>>=|&=|\^=|\|=)/g;
      let am;
      while ((am = assignRe.exec(trimmedCode)) !== null) {
        if (!reserved.has(am[1])) modifiedVars.add(am[1]);
      }
      const incDecRe = /(?:^|[^a-zA-Z_0-9])([a-zA-Z_0-9]+)\s*(\+\+|--)|(?:^|[^a-zA-Z_0-9])(\+\+|--)\s*([a-zA-Z_0-9]+)/g;
      let im;
      while ((im = incDecRe.exec(trimmedCode)) !== null) {
        const v = im[1] || im[4];
        if (v && !reserved.has(v) && !/^\d+$/.test(v)) modifiedVars.add(v);
      }

      // Array assignments: arr[i] = val, arr[i][j] = val, etc.
      const arrAssignRe = /(?:^|[^a-zA-Z_0-9])([a-zA-Z_0-9]+)(?:\s*\[[^\]]*\])+\s*(?:=(?!=)|\+=|-=|\*=|\/=|%=|<<=|>>=|&=|\^=|\|=)/g;
      let aam;
      while ((aam = arrAssignRe.exec(trimmedCode)) !== null) {
        if (!reserved.has(aam[1])) modifiedVars.add(aam[1]);
      }

      // Array inc/dec: arr[i]++, ++arr[i], arr[i][j]++, etc.
      const arrIncDecRe = /(?:^|[^a-zA-Z_0-9])([a-zA-Z_0-9]+)(?:\s*\[[^\]]*\])+\s*(\+\+|--)|(?:^|[^a-zA-Z_0-9])(\+\+|--)\s*([a-zA-Z_0-9]+)(?:\s*\[[^\]]*\])+/g;
      let aim;
      while ((aim = arrIncDecRe.exec(trimmedCode)) !== null) {
        const v = aim[1] || aim[4];
        if (v && !reserved.has(v) && !/^\d+$/.test(v)) modifiedVars.add(v);
      }

      // Container method calls: v.push_back(...), v.pop_back(), arr[i].push_back(...), etc.
      const containerMethodRe = /(?:^|[;{}(,\s])([a-zA-Z_0-9]+)(?:\s*\[[^\]]*\])*\s*\.\s*(?:push_back|emplace_back|pop_back|push|pop|insert|emplace|erase|clear|resize|assign|append|replace|shrink_to_fit|swap)\s*\(/g;
      let cmm;
      while ((cmm = containerMethodRe.exec(trimmedCode)) !== null) {
        if (!reserved.has(cmm[1])) modifiedVars.add(cmm[1]);
      }

      // STL algorithms modifying containers: sort(v.begin(), v.end()), reverse(v.begin(), v.end()), etc.
      const algoRe = /(?:^|[;{}(,\s])(?:std::)?(?:sort|stable_sort|reverse|fill|shuffle|random_shuffle|next_permutation|prev_permutation|rotate|unique|remove|remove_if)\s*\(\s*([a-zA-Z_0-9]+)\.(?:begin|rbegin)\(\)/g;
      let algom;
      while ((algom = algoRe.exec(trimmedCode)) !== null) {
        if (!reserved.has(algom[1])) modifiedVars.add(algom[1]);
      }

      // Container swap: swap(a, b), swap(arr[i], arr[j]), swap(grid[i][j], grid[x][y])
      const swapRe = /(?:^|[;{}(,\s])(?:std::)?swap\s*\(\s*([a-zA-Z_0-9]+)(?:\s*\[[^\]]*\])*\s*,\s*([a-zA-Z_0-9]+)(?:\s*\[[^\]]*\])*\s*\)/g;
      let sm;
      while ((sm = swapRe.exec(trimmedCode)) !== null) {
        if (!reserved.has(sm[1])) modifiedVars.add(sm[1]);
        if (!reserved.has(sm[2])) modifiedVars.add(sm[2]);
      }

      // Input reading (cin >> a >> b; or getline(cin, s); or scanf("%d", &x);)
      const isInput = (rawLine.includes('cin') || rawLine.includes('scanf') || rawLine.includes('getline'));
      const inputVars = [];
      if (isInput) {
        const glMatch = rawLine.match(/getline\s*\(\s*(?:std::)?cin(?:\s*>>\s*(?:std::)?ws)?\s*,\s*([a-zA-Z_0-9]+(?:\s*\[[^\]]+\])*)\s*\)/);
        if (glMatch) {
          const expr = glMatch[1].trim();
          const baseMatch = expr.match(/^[a-zA-Z_0-9]+/);
          if (baseMatch) {
            const from = rawLine.indexOf(glMatch[0]);
            const to = from + glMatch[0].length;
            inputVars.push({ expr, base: baseMatch[0], isGetline: true, colFrom: from, colTo: to });
          }
        } else if (rawLine.includes('scanf')) {
          const scanfArgs = rawLine.match(/scanf\s*\([^,]+,(.+)\)\s*;/);
          if (scanfArgs) {
            const argsStr = scanfArgs[1];
            const argParts = argsStr.split(',');
            let searchOffset = rawLine.indexOf(scanfArgs[1]);
            for (const arg of argParts) {
              const argIdx = rawLine.indexOf(arg, searchOffset);
              const m = arg.trim().match(/^&?\s*([a-zA-Z_0-9]+(?:\s*\[[^\]]+\])*)/);
              if (m) {
                const expr = m[1].trim();
                const baseMatch = expr.match(/^[a-zA-Z_0-9]+/);
                if (baseMatch) {
                  const mOffset = arg.indexOf(m[0]);
                  const from = argIdx + mOffset;
                  const to = from + m[0].length;
                  inputVars.push({ expr, base: baseMatch[0], isGetline: false, colFrom: from, colTo: to });
                }
              }
              searchOffset = argIdx + arg.length;
            }
          }
        } else if (rawLine.includes('cin')) {
          const manipulators = new Set(['ws', 'endl', 'hex', 'dec', 'oct', 'fixed', 'scientific', 'setprecision', 'setw', 'std']);
          const cinIdx = rawLine.indexOf('cin');
          const cinRe = />>\s*([a-zA-Z_0-9]+(?:\s*\[[^\]]+\])*)/g;
          let cm;
          let isFirst = true;
          while ((cm = cinRe.exec(rawLine)) !== null) {
            const expr = cm[1].trim();
            const baseMatch = expr.match(/^[a-zA-Z_0-9]+/);
            if (!baseMatch) continue;
            if (manipulators.has(baseMatch[0])) continue;
            const from = isFirst && cinIdx !== -1 ? cinIdx : cm.index;
            const to = cm.index + cm[0].length;
            isFirst = false;
            inputVars.push({ expr, base: baseMatch[0], isGetline: false, colFrom: from, colTo: to });
          }
        }
      }
      const inputBaseNames = new Set(inputVars.map(iv => iv.base));

      // Output write
      const isOutput = (rawLine.includes('cout') || rawLine.includes('printf'));

      // Condition line transformations (if, else if, else, while)
      let lineToEmit = rawLine;
      let isCondLine = false;
      if (inFunction) {
        const elseIfMatch = codeWithoutComment.match(/^(\s*(?:\}\s*)?)else\s+if\s*\(/);
        const ifMatch = !elseIfMatch && codeWithoutComment.match(/^(\s*(?:\}\s*)?)if\s*\(/);
        const whileMatch = !elseIfMatch && !ifMatch && codeWithoutComment.match(/^(\s*(?:\}\s*)?)while\s*\(/);
        const elseMatch = !elseIfMatch && !ifMatch && !whileMatch && codeWithoutComment.match(/^(\s*(?:\}\s*)?)else(?:\s*\{|\s*$|\s+(?!if\b)[^{;]+;?)/);

        if (elseIfMatch || ifMatch || whileMatch) {
          const kw = elseIfMatch ? 'else if' : (ifMatch ? 'if' : 'while');
          const match = elseIfMatch || ifMatch || whileMatch;
          const kwIdx = codeWithoutComment.indexOf(kw, match.index);
          const openParenIdx = codeWithoutComment.indexOf('(', kwIdx);

          let depth = 0;
          let closeParenIdx = -1;
          let inStrP = false, quoteP = '';
          for (let i = openParenIdx; i < codeWithoutComment.length; i++) {
            const c = codeWithoutComment[i];
            if ((c === '"' || c === "'") && (i === 0 || codeWithoutComment[i - 1] !== '\\')) {
              if (!inStrP) { inStrP = true; quoteP = c; }
              else if (quoteP === c) inStrP = false;
            } else if (!inStrP) {
              if (c === '(') depth++;
              else if (c === ')') {
                depth--;
                if (depth === 0) {
                  closeParenIdx = i;
                  break;
                }
              }
            }
          }

          if (closeParenIdx !== -1) {
            const condText = codeWithoutComment.slice(openParenIdx + 1, closeParenIdx).trim();
            const isDecl = /^(?:const\s+)?[a-zA-Z_0-9:<>\*&]+\s+[*&]?[a-zA-Z_0-9]+\s*=/.test(condText);
            if (!isDecl && condText.length > 0) {
              const before = rawLine.slice(0, openParenIdx + 1);
              const after = rawLine.slice(closeParenIdx);
              lineToEmit = `${before}__viz::cond(${lineNum}, (${condText}))${after}`;
              isCondLine = true;
            }
          }
        } else if (elseMatch) {
          const kwIdx = rawLine.indexOf('else', elseMatch.index);
          const before = rawLine.slice(0, kwIdx);
          const after = rawLine.slice(kwIdx + 4);
          lineToEmit = `${before}else if (__viz::cond(${lineNum}, true))${after}`;
          isCondLine = true;
        }
      }

      if (inFunction && !rawLine.startsWith('#') && !isInput && !isCondLine && !suppressLine) {
        outLines.push(`    __viz::line(${lineNum});`);
      }

      outLines.push(lineToEmit);

      if (declMatch && inFunction) {
        for (const v of declMatch.vars) {
          if (scopeStack.length > 0) {
            scopeStack[scopeStack.length - 1].vars.push(v.name);
          }
          if (v.isArray) {
            knownArrays.add(v.name);
            const actualType = v.arrType || (declMatch.type + '[]');
            knownArrayTypes.set(v.name, actualType);
            knownArrayRanks.set(v.name, v.dimCount || 1);
            outLines.push(`    __viz::arr_decl("${v.name}", "${actualType}", ${buildArrArgs(v.name, v.dimCount)}, ${lineNum});`);
          } else {
            outLines.push(`    __viz::var_decl("${v.name}", "${declMatch.type}", ${v.name}, ${lineNum});`);
          }
        }
      }
      if (modifiedVars.size > 0 && inFunction) {
        const declNames = declMatch ? new Set(declMatch.vars.map(v => v.name)) : null;
        for (const varName of modifiedVars) {
          if ((!declNames || !declNames.has(varName)) && !inputBaseNames.has(varName)) {
            if (knownArrayRanks.has(varName)) {
              const aType = knownArrayTypes.get(varName) || '';
              outLines.push(`    __viz::arr_set("${varName}", "${aType}", ${buildArrArgs(varName, knownArrayRanks.get(varName))}, ${lineNum});`);
            } else if (knownArrays.has(varName)) {
              const aType = knownArrayTypes.get(varName) || '';
              outLines.push(`    __viz::arr_set("${varName}", "${aType}", ${varName}, sizeof(${varName})/sizeof(${varName}[0]), ${lineNum});`);
            } else {
              outLines.push(`    __viz::var_set("${varName}", ${varName}, ${lineNum});`);
            }
          }
        }
      }

      if (isInput && inFunction) {
        if (inputVars.length > 0) {
          for (const iv of inputVars) {
            if (knownArrayRanks.has(iv.base)) {
              outLines.push(`    __viz::arr_io_input_event("${iv.base}", ${buildArrArgs(iv.base, knownArrayRanks.get(iv.base))}, "${iv.expr}", ${iv.expr}, ${lineNum}, ${iv.colFrom}, ${iv.colTo}, ${iv.isGetline ? 'true' : 'false'});`);
            } else if (knownArrays.has(iv.base)) {
              outLines.push(`    __viz::arr_io_input_event("${iv.base}", ${iv.base}, sizeof(${iv.base})/sizeof(${iv.base}[0]), "${iv.expr}", ${iv.expr}, ${lineNum}, ${iv.colFrom}, ${iv.colTo});`);
            } else {
              outLines.push(`    __viz::io_input_event("${iv.base}", ${iv.base}, "${iv.expr}", ${iv.expr}, ${lineNum}, ${iv.colFrom}, ${iv.colTo}, ${iv.isGetline ? 'true' : 'false'});`);
            }
          }
        } else {
          outLines.push(`    __viz::io_event("input", "", ${lineNum});`);
        }
      } else if (isOutput && inFunction) {
        outLines.push(`    __viz::io_event("output", "", ${lineNum});`);
      }

      braceDepth += openBraces - closeBraces;
      if (closeBraces > 0 && activeForLoops.length > 0 && braceDepth < activeForLoops[activeForLoops.length - 1].depth) {
        const ended = activeForLoops.pop();
        outLines.push(`    __viz::scope_exit(${lineNum}, ${JSON.stringify(JSON.stringify(ended.vars))});`);
      }
      if (activeForLoops.length > 0 && !activeForLoops[activeForLoops.length - 1].hasBrace) {
        const ended = activeForLoops.pop();
        outLines.push(`    __viz::scope_exit(${lineNum}, ${JSON.stringify(JSON.stringify(ended.vars))});`);
      }
      if (braceDepth <= funcBraceDepth && closeBraces > 0) {
        inFunction = false;
      }
    }

    return header + '\n#line 1 "' + actualFilename + '"\n' + outLines.join('\n');
  }

  // ── Public module ─────────────────────────────────────────────────────

  var exp = {
    parseTrace: parseTrace,
    instrumentCode: instrumentCode,
    create: create,
    computeState: computeState
  };

  if (typeof window !== 'undefined') {
    window.CppVisualizer = exp;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exp;
  }

  return exp;

})();
