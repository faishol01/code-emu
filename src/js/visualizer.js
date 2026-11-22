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
  width: 50%;
  max-width: 50%;
  min-width: 160px;
  overflow: auto;
  padding: 10px 14px;
  border-right: 1px solid var(--line);
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
.viz-vars-content { flex: 1; overflow: auto; }
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
.viz-vars-table td:nth-child(3) { color: var(--t-num); word-break: break-all; white-space: normal; }
.viz-vars-empty {
  font-size: 12px;
  color: var(--muted);
  font-style: italic;
}

/* ── changed highlight ────────────────────────────────────────────── */
@keyframes viz-flash {
  0%   { background-color: rgba(240, 168, 48, .35); }
  100% { background-color: transparent; }
}
.viz-changed td { animation: viz-flash .5s ease-out; }

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

  var VIZ_PREFIX = '__VIZ__';

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

  /**
   * Search caller frames (top to bottom) and globals for a variable with targetAddr.
   */
  function resolveRefInfo(callStack, globals, targetAddr, ownName) {
    if (!targetAddr) return null;
    if (callStack) {
      for (var f = callStack.length - 1; f >= 0; f--) {
        for (var vn in callStack[f].vars) {
          if (callStack[f].vars[vn].addr === targetAddr && vn !== ownName) {
            return { refVar: vn, refFrameIdx: f };
          }
        }
      }
    }
    if (globals) {
      for (var gn in globals) {
        if (globals[gn].addr === targetAddr && gn !== ownName) {
          return { refVar: gn, refFrameIdx: -1 };
        }
      }
    }
    return null;
  }

  /**
   * Synchronize all aliased variables sharing targetAddr across callStack and globals.
   */
  function syncAliasedVars(callStack, globals, targetAddr, newVal, changedVars, isLast) {
    if (!targetAddr) return;
    if (callStack) {
      for (var f = 0; f < callStack.length; f++) {
        for (var vn in callStack[f].vars) {
          var vobj = callStack[f].vars[vn];
          if (vobj.addr && vobj.addr === targetAddr) {
            vobj.val = newVal;
            if (isLast && changedVars) changedVars.add(vn);
          }
        }
      }
    }
    if (globals) {
      for (var gn in globals) {
        var gobj = globals[gn];
        if (gobj.addr && gobj.addr === targetAddr) {
          gobj.val = newVal;
          if (isLast && changedVars) changedVars.add(gn);
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
          // Add params as vars in this frame, resolving reference bindings by memory address
          for (var p = 0; p < frame.params.length; p++) {
            var prm = frame.params[p];
            var refInfo = resolveRefInfo(callStack, globals, prm.addr, prm.name);
            frame.vars[prm.name] = {
              type: prm.type,
              val: prm.val,
              addr: prm.addr,
              refVar: refInfo ? refInfo.refVar : null,
              refFrameIdx: refInfo ? refInfo.refFrameIdx : null
            };
            if (isLast) changedVars.add(prm.name);
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
          if (isLast) changedVars.add(ev.name);
          if (ev.line) currentLine = ev.line;
          break;

        case 'var_decl':
          if (callStack.length) {
            var refInfo = resolveRefInfo(callStack, globals, ev.addr, ev.name);
            callStack[callStack.length - 1].vars[ev.name] = {
              type: ev.type,
              val: ev.val,
              addr: ev.addr,
              refVar: refInfo ? refInfo.refVar : null,
              refFrameIdx: refInfo ? refInfo.refFrameIdx : null
            };
            if (isLast) changedVars.add(ev.name);
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
              callStack[f].vars[ev.name].val = ev.val;
              if (ev.addr) callStack[f].vars[ev.name].addr = ev.addr;
              else targetAddr = callStack[f].vars[ev.name].addr;
              if (isLast) changedVars.add(ev.name);
              found = true;
              break;
            }
          }
          if (!found && globals[ev.name] !== undefined) {
            globals[ev.name].val = ev.val;
            if (ev.addr) globals[ev.name].addr = ev.addr;
            else targetAddr = globals[ev.name].addr;
            if (isLast) changedVars.add(ev.name);
            found = true;
          }
          if (!found && callStack.length) {
            callStack[callStack.length - 1].vars[ev.name] = { type: ev.type || 'auto', val: ev.val, addr: ev.addr };
            if (isLast) changedVars.add(ev.name);
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
              if (isLast) changedVars.add(ev.name1);
              found1 = true;
              break;
            }
          }
          if (!found1 && callStack.length) {
            callStack[callStack.length - 1].vars[ev.name1] = { type: ev.type1 || 'auto', val: ev.val1, addr: ev.addr1 };
            if (isLast) changedVars.add(ev.name1);
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
              if (isLast) changedVars.add(ev.name2);
              found2 = true;
              break;
            }
          }
          if (!found2 && callStack.length) {
            callStack[callStack.length - 1].vars[ev.name2] = { type: ev.type2 || 'auto', val: ev.val2, addr: ev.addr2 };
            if (isLast) changedVars.add(ev.name2);
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
                if (isLast) changedVars.add(ev.name);
                found = true;
                break;
              }
            }
            if (!found && globals[ev.name] !== undefined) {
              globals[ev.name].val = ev.val;
              if (ev.addr) globals[ev.name].addr = ev.addr;
              else targetAddr = globals[ev.name].addr;
              if (isLast) changedVars.add(ev.name);
              found = true;
            }
            if (!found && callStack.length) {
              callStack[callStack.length - 1].vars[ev.name] = { type: ev.type || 'auto', val: ev.val, addr: ev.addr };
              if (isLast) changedVars.add(ev.name);
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
                if (isLast) changedVars.add(ev.name1);
                found1 = true;
                break;
              }
            }
            if (!found1 && callStack.length) {
              callStack[callStack.length - 1].vars[ev.name1] = { type: ev.type1 || 'auto', val: ev.val1, addr: ev.addr1 };
              if (isLast) changedVars.add(ev.name1);
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
                if (isLast) changedVars.add(ev.name2);
                found2 = true;
                break;
              }
            }
            if (!found2 && callStack.length) {
              callStack[callStack.length - 1].vars[ev.name2] = { type: ev.type2 || 'auto', val: ev.val2, addr: ev.addr2 };
              if (isLast) changedVars.add(ev.name2);
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
                callStack[f].vars[ev.name].val = ev.val;
                if (ev.addr) callStack[f].vars[ev.name].addr = ev.addr;
                else targetAddr = callStack[f].vars[ev.name].addr;
                if (isLast) changedVars.add(ev.name);
                found = true;
                break;
              }
            }
            if (!found && globals[ev.name] !== undefined) {
              globals[ev.name].val = ev.val;
              if (ev.addr) globals[ev.name].addr = ev.addr;
              else targetAddr = globals[ev.name].addr;
              if (isLast) changedVars.add(ev.name);
              found = true;
            }
            if (!found && callStack.length) {
              callStack[callStack.length - 1].vars[ev.name] = { type: ev.type || 'auto', val: ev.val, addr: ev.addr };
              if (isLast) changedVars.add(ev.name);
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

    // Variables
    var varsPane = el('div', 'viz-vars');
    var varsH3 = el('h3'); varsH3.textContent = 'Variables';
    var varsContent = el('div', 'viz-vars-content');
    varsPane.appendChild(varsH3);
    varsPane.appendChild(varsContent);

    body.appendChild(stackPane);
    body.appendChild(varsPane);

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

    // ── Rendering ─────────────────────

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
            if (changedVars.has(gName)) {
              gTr.className = 'viz-changed';
            }
            var gTdName = document.createElement('td');
            gTdName.textContent = gName;
            var gTdType = document.createElement('td');
            gTdType.textContent = gv.type;
            var gTdVal = document.createElement('td');
            gTdVal.textContent = gv.val;
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
              if (changedVars.has(vname)) {
                tr.className = 'viz-changed';
              }
              var tdName = document.createElement('td');
              tdName.textContent = vname;
              var tdType = document.createElement('td');
              tdType.textContent = v.type;
              var tdVal = document.createElement('td');
              tdVal.textContent = v.refVar ? (v.val + ' (\u2192 ' + v.refVar + ')') : v.val;
              tr.appendChild(tdName);
              tr.appendChild(tdType);
              tr.appendChild(tdVal);
              table.appendChild(tr);
            }
            varsContent.appendChild(table);
          }
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
            for (var p = 0; p < frame.params.length; p++) {
              var prm = frame.params[p];
              var refInfo = resolveRefInfo(cs, globals, prm.addr, prm.name);
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
              var refInfo = resolveRefInfo(cs, globals, ev.addr, ev.name);
              cs[cs.length - 1].vars[ev.name] = {
                type: ev.type,
                val: ev.val,
                addr: ev.addr,
                refVar: refInfo ? refInfo.refVar : null,
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
        vars.push({ name: varMatch[1], isArray: d.includes('[') });
      }
    }
    return vars.length ? { type: type, vars: vars } : null;
  }

  function instrumentCode(userCode, filename) {
    const actualFilename = filename || 'main.cpp';
    const header = [
      '#include <iostream>',
      '#include <sstream>',
      '#include <string>',
      '#include <vector>',
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
      '    std::ostringstream ss;',
      '    for (size_t i = 0; i < s.length(); ++i) {',
      '      char c = s[i];',
      '      if (c == \'"\') ss << "\\\\\\\"";',
      '      else if (c == \'\\\\\') ss << "\\\\\\\\";',
      '      else if (c == \'\\b\') ss << "\\\\b";',
      '      else if (c == \'\\f\') ss << "\\\\f";',
      '      else if (c == \'\\n\') ss << "\\\\n";',
      '      else if (c == \'\\r\') ss << "\\\\r";',
      '      else if (c == \'\\t\') ss << "\\\\t";',
      '      else ss << c;',
      '    }',
      '    return ss.str();',
      '  }',
      '',
      '  template<typename T>',
      '  inline std::string to_s(const T& v);',
      '',
      '  inline std::string to_s(bool v) { return v ? "true" : "false"; }',
      '  inline std::string to_s(char v) { return std::string("\'") + v + "\'"; }',
      '  inline std::string to_s(const std::string& v) { return "\\"" + v + "\\""; }',
      '  inline std::string to_s(const char* v) { return v ? (std::string("\\"") + v + "\\"") : "nullptr"; }',
      '',
      '  template<size_t N>',
      '  inline std::string to_s(const char (&arr)[N]) { return std::string("\\"") + arr + "\\""; }',
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
      '    return reinterpret_cast<uintptr_t>(arr);',
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
      '  inline std::string arr_to_s(const char* ptr, size_t size) {',
      '    if (!ptr || size == 0) return "\\"\\"";',
      '    std::ostringstream ss;',
      '    ss << "\\"";',
      '    for (size_t i = 0; i < size && i < 30; ++i) {',
      '      if (ptr[i] == \'\\0\') break;',
      '      if (ptr[i] == \'"\') ss << "\\\\\\\"";',
      '      else if (ptr[i] == \'\\\\\') ss << "\\\\\\\\";',
      '      else if (ptr[i] >= 32 && ptr[i] <= 126) ss << ptr[i];',
      '      else ss << \' \';',
      '    }',
      '    ss << "\\"";',
      '    return ss.str();',
      '  }',
      '',
      '  template<typename T>',
      '  inline void arr_decl(const char* name, const char* type, const T* ptr, size_t size, int ln) {',
      '    std::ostringstream ss;',
      '    ss << "{\\"e\\":\\"var_decl\\",\\"name\\":\\"" << name << "\\",\\"type\\":\\"" << type << "\\",\\"val\\":\\"" << escape_json(arr_to_s(ptr, size)) << "\\",\\"addr\\":\\"" << reinterpret_cast<uintptr_t>(ptr) << "\\",\\"line\\":" << ln << "}";',
      '    emit(ss.str());',
      '  }',
      '',
      '  template<typename T>',
      '  inline void arr_global_decl(const char* name, const char* type, const T* ptr, size_t size, int ln) {',
      '    std::ostringstream ss;',
      '    ss << "{\\"e\\":\\"global_decl\\",\\"name\\":\\"" << name << "\\",\\"type\\":\\"" << type << "\\",\\"val\\":\\"" << escape_json(arr_to_s(ptr, size)) << "\\",\\"addr\\":\\"" << reinterpret_cast<uintptr_t>(ptr) << "\\",\\"line\\":" << ln << "}";',
      '    emit(ss.str());',
      '  }',
      '',
      '  template<typename T>',
      '  inline void arr_set(const char* name, const T* ptr, size_t size, int ln) {',
      '    std::ostringstream ss;',
      '    ss << "{\\"e\\":\\"var_set\\",\\"name\\":\\"" << name << "\\",\\"val\\":\\"" << escape_json(arr_to_s(ptr, size)) << "\\",\\"addr\\":\\"" << reinterpret_cast<uintptr_t>(ptr) << "\\",\\"line\\":" << ln << "}";',
      '    emit(ss.str());',
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
      '  template<typename T, typename E>',
      '  inline void arr_io_input_event(const char* base_name, const T* ptr, size_t size, const char* expr_name, const E& expr_val, int ln, int c_from, int c_to) {',
      '    std::ostringstream ss;',
      '    ss << "{\\"e\\":\\"io\\",\\"io\\":\\"input\\",\\"name\\":\\"" << base_name',
      '       << "\\",\\"val\\":\\"" << escape_json(arr_to_s(ptr, size))',
      '       << "\\",\\"expr\\":\\"" << expr_name',
      '       << "\\",\\"inputVal\\":\\"" << escape_json(to_s(expr_val))',
      '       << "\\",\\"isGetline\\":false"',
      '       << ",\\"colFrom\\":" << c_from',
      '       << ",\\"colTo\\":" << c_to',
      '       << ",\\"addr\\":\\"" << reinterpret_cast<uintptr_t>(ptr) << "\\""',
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

    const lines = userCode.split('\n');
    const outLines = [];
    const knownArrays = new Set();
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
    for (let pi = 0; pi < lines.length; pi++) {
      const pLine = lines[pi];
      const pTrimmed = pLine.trim();
      if (!pTrimmed || pTrimmed.startsWith('//') || pTrimmed.startsWith('/*') || pTrimmed.startsWith('#')) continue;
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
      const ob = (pLine.match(/\{/g) || []).length;
      const cb = (pLine.match(/\}/g) || []).length;
      passDepth += ob - cb;
      if (passDepth <= 0 && cb > 0) {
        passInFunc = false;
        pendingPassFunc = false;
      }
      if (!passInFunc && !pendingPassFunc && passDepth === 0) {
        const dm = parseDecl(pLine);
        if (dm) {
          for (const v of dm.vars) {
            if (v.isArray) knownArrays.add(v.name);
            globalVars.push({ name: v.name, type: dm.type + (v.isArray ? '[]' : ''), line: pi + 1, isArray: v.isArray });
          }
        }
      }
    }

    const buildParamsJson = (pList) => {
      if (!pList.length) return '"[]"';
      const parts = pList.map((p, idx) => {
        const sep = idx === 0 ? '' : ',';
        return `std::string("${sep}{\\"name\\":\\"${p.name}\\",\\"type\\":\\"${p.type}\\",\\"addr\\":\\"") + std::to_string(__viz::get_addr(${p.name})) + std::string("\\",\\"val\\":\\"") + __viz::escape_json(__viz::to_s(${p.name})) + "\\"}"`;
      });
      return `std::string("[") + ` + parts.join(' + ') + ` + "]"`;
    };

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const rawLine = lines[lineIdx];
      const lineNum = lineIdx + 1;
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
            const pTrim = p.trim();
            const pMatch = pTrim.match(/^(.+?)\s*([*&]?)\s*([a-zA-Z_0-9]+)(?:\[\s*\])?(?:\s*=\s*[^,]+)?$/);
            if (pMatch) {
              const pType = (pMatch[1] + (pMatch[2] ? ' ' + pMatch[2] : '')).trim();
              const pName = pMatch[3].trim();
              params.push({ type: pType, name: pName });
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
              gvInjections += ` __viz::arr_global_decl("${gv.name}", "${gv.type}", ${gv.name}, sizeof(${gv.name})/sizeof(${gv.name}[0]), ${gv.line});`;
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
            const pTrim = p.trim();
            const pMatch = pTrim.match(/^(.+?)\s*([*&]?)\s*([a-zA-Z_0-9]+)(?:\[\s*\])?(?:\s*=\s*[^,]+)?$/);
            if (pMatch) {
              const pType = (pMatch[1] + (pMatch[2] ? ' ' + pMatch[2] : '')).trim();
              const pName = pMatch[3].trim();
              params.push({ type: pType, name: pName });
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
                outLines.push(`    __viz::arr_global_decl("${gv.name}", "${gv.type}", ${gv.name}, sizeof(${gv.name})/sizeof(${gv.name}[0]), ${gv.line});`);
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
              outLines.push(`    __viz::arr_global_decl("${gv.name}", "${gv.type}", ${gv.name}, sizeof(${gv.name})/sizeof(${gv.name}[0]), ${gv.line});`);
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
            incWrapped = `((${incText}), __viz::for_step_simple(${lineNum}, ${incFrom}, ${incTo}))`;
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

      const openBraces = (rawLine.match(/\{/g) || []).length;
      const closeBraces = (rawLine.match(/\}/g) || []).length;

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
      const incDecRe = /(?:^|[;{}(,\s])([a-zA-Z_0-9]+)\s*(\+\+|--)|(?:^|[;{}(,\s])(\+\+|--)\s*([a-zA-Z_0-9]+)/g;
      let im;
      while ((im = incDecRe.exec(trimmedCode)) !== null) {
        const v = im[1] || im[4];
        if (v && !reserved.has(v) && !/^\d+$/.test(v)) modifiedVars.add(v);
      }

      // Array assignments: arr[i] = val, arr[i] += val, etc.
      const arrAssignRe = /(?:^|[;{}(,\s])([a-zA-Z_0-9]+)\s*\[.+?\]\s*(?:=(?!=)|\+=|-=|\*=|\/=|%=|<<=|>>=|&=|\^=|\|=)/g;
      let aam;
      while ((aam = arrAssignRe.exec(trimmedCode)) !== null) {
        if (!reserved.has(aam[1])) modifiedVars.add(aam[1]);
      }

      // Array inc/dec: arr[i]++, ++arr[i], arr[i]--, --arr[i]
      const arrIncDecRe = /(?:^|[;{}(,\s])([a-zA-Z_0-9]+)\s*\[.+?\]\s*(\+\+|--)|(?:^|[;{}(,\s])(\+\+|--)\s*([a-zA-Z_0-9]+)\s*\[.+?\]/g;
      let aim;
      while ((aim = arrIncDecRe.exec(trimmedCode)) !== null) {
        const v = aim[1] || aim[4];
        if (v && !reserved.has(v) && !/^\d+$/.test(v)) modifiedVars.add(v);
      }

      // Container method calls: v.push_back(...), v.pop_back(), arr[i].push_back(...), etc.
      const containerMethodRe = /(?:^|[;{}(,\s])([a-zA-Z_0-9]+)(?:\s*\[.+?\])?\s*\.\s*(?:push_back|emplace_back|pop_back|push|pop|insert|emplace|erase|clear|resize|assign|shrink_to_fit|swap)\s*\(/g;
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

      // Container swap: swap(a, b), swap(arr[i], arr[j])
      const swapRe = /(?:^|[;{}(,\s])(?:std::)?swap\s*\(\s*([a-zA-Z_0-9]+)(?:\s*\[.+?\])?\s*,\s*([a-zA-Z_0-9]+)(?:\s*\[.+?\])?\s*\)/g;
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
            outLines.push(`    __viz::arr_decl("${v.name}", "${declMatch.type}[]", ${v.name}, sizeof(${v.name})/sizeof(${v.name}[0]), ${lineNum});`);
          } else {
            outLines.push(`    __viz::var_decl("${v.name}", "${declMatch.type}", ${v.name}, ${lineNum});`);
          }
        }
      }
      if (modifiedVars.size > 0 && inFunction) {
        const declNames = declMatch ? new Set(declMatch.vars.map(v => v.name)) : null;
        for (const varName of modifiedVars) {
          if ((!declNames || !declNames.has(varName)) && !inputBaseNames.has(varName)) {
            if (knownArrays.has(varName)) {
              outLines.push(`    __viz::arr_set("${varName}", ${varName}, sizeof(${varName})/sizeof(${varName}[0]), ${lineNum});`);
            } else {
              outLines.push(`    __viz::var_set("${varName}", ${varName}, ${lineNum});`);
            }
          }
        }
      }

      if (isInput && inFunction) {
        if (inputVars.length > 0) {
          for (const iv of inputVars) {
            if (knownArrays.has(iv.base)) {
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
    create: create
  };

  if (typeof window !== 'undefined') {
    window.CppVisualizer = exp;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exp;
  }

  return exp;

})();
