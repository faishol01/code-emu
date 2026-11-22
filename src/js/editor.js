/* cpp.wasm editor: a small wrapper around CodeMirror 6 (window.CM6, from
   src/vendors/editor/editor.bundle.js). app.js, collab.js and record.js use only
   this API, so a future CodeMirror upgrade only touches this file.

     const ed = CppEditor.create(parentElement, {
       readOnly, onRun, onFormat,
       onChange(changes),     // user edits: [{ pos, del, text }], each applied after the previous
       onSelection(anchor, head),
     });

   A "state" is one document with its own undo history; keep one per file and
   switch with ed.setState(). Positions are character offsets (UTF-16). */
window.CppEditor = (function () {
  'use strict';
  const C = window.CM6;
  if (!C) return null;
  const {
    EditorState, Compartment, StateEffect, StateField, Annotation, Prec,
    EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightActiveLine, highlightSpecialChars,
    drawSelection, dropCursor, rectangularSelection, crosshairCursor, Decoration, WidgetType,
    history, historyKeymap, defaultKeymap, indentMore, indentLess,
    indentUnit, bracketMatching, syntaxHighlighting, HighlightStyle, indentOnInput, foldGutter, foldKeymap,
    cpp, closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap, completeAnyWord,
    search, searchKeymap, highlightSelectionMatches, tags: t,
  } = C;

  // Changes made by the program (player, placeholders), not typed by the user.
  const External = Annotation.define();

  /* ---------- look ---------- */
  const highlight = HighlightStyle.define([
    { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.modifier, t.definitionKeyword, t.moduleKeyword], color: 'var(--t-kw)', fontWeight: '500' },
    { tag: [t.typeName, t.standard(t.typeName), t.className, t.namespace], color: 'var(--t-type)' },
    { tag: [t.string, t.special(t.string), t.character, t.escape], color: 'var(--t-str)' },
    { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--t-num)' },
    { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--t-com)', fontStyle: 'italic' },
    { tag: [t.processingInstruction, t.macroName, t.meta], color: 'var(--t-meta)' },
    { tag: [t.variableName, t.propertyName, t.operator, t.punctuation, t.function(t.variableName)], color: 'var(--t-def)' },
    { tag: t.invalid, color: 'var(--fail)' },
  ]);

  const theme = EditorView.theme({
    '&': { height: '100%', fontSize: '14px', color: 'var(--t-def)', backgroundColor: 'var(--panel)' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.6' },
    '.cm-content': { padding: '10px 0', caretColor: 'var(--accent)' },
    '.cm-line': { padding: '0 4px 0 6px' },
    '.cm-gutters': { backgroundColor: 'var(--panel-2)', color: 'var(--muted)', borderRight: '1px solid var(--line)' },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 8px' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--ink)' },
    '&.cm-focused .cm-cursor, .cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
    '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, ::selection': { backgroundColor: 'var(--sel) !important' },
    '&.cm-focused .cm-matchingBracket': { backgroundColor: 'transparent', outline: '1px solid var(--accent)' },
    '.cm-matchingBracket, .cm-nonmatchingBracket': { backgroundColor: 'transparent' },
    '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
    '.cm-selectionMatch': { backgroundColor: 'var(--match)' },
    '.cm-searchMatch': { backgroundColor: 'var(--match)', outline: '1px solid var(--amber)' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--match-strong)' },
    '.cm-foldGutter .cm-gutterElement': { padding: '0 4px', cursor: 'pointer', color: 'var(--muted)' },
    '.cm-foldPlaceholder': { backgroundColor: 'var(--panel-2)', border: '1px solid var(--line)', color: 'var(--muted)', padding: '0 6px', borderRadius: '4px' },
    '.cm-panels': { backgroundColor: 'var(--panel-2)', color: 'var(--ink)', fontFamily: 'var(--sans)' },
    '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--line)' },
    '.cm-search': { fontSize: '13px', padding: '8px 10px 6px' },
    '.cm-search label': { fontSize: '12.5px', color: 'var(--muted)' },
    '.cm-textfield': { backgroundColor: 'var(--panel)', color: 'var(--ink)', border: '1px solid var(--line)', borderRadius: '5px', padding: '4px 7px', fontFamily: 'var(--mono)', fontSize: '13px' },
    '.cm-textfield:focus': { outline: 'none', borderColor: 'var(--accent)' },
    '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--panel)', color: 'var(--ink)', border: '1px solid var(--line)', borderRadius: '5px', padding: '3px 9px', fontFamily: 'var(--sans)', fontSize: '12.5px' },
    '.cm-button:hover': { borderColor: 'var(--muted)' },
    '.cm-panel button[name=close]': { color: 'var(--muted)', fontSize: '18px' },
    '.cm-tooltip': { backgroundColor: 'var(--panel)', color: 'var(--ink)', border: '1px solid var(--line)', borderRadius: '6px', boxShadow: '0 6px 18px rgba(10, 20, 40, .18)', overflow: 'hidden' },
    '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--mono)', fontSize: '13px', maxHeight: '16em' },
    '.cm-tooltip-autocomplete > ul > li': { padding: '2px 10px 2px 6px' },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent)', color: 'var(--accent-ink)' },
    '.cm-completionIcon': { opacity: '.6' },
    '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: '600' },
  });

  /* ---------- decorations the player and collab draw (selections, carets, flashes) ---------- */
  const setMarks = StateEffect.define();
  const marksField = StateField.define({
    create: () => Decoration.none,
    update(value, tr) {
      value = value.map(tr.changes);
      for (const e of tr.effects) if (e.is(setMarks)) value = e.value;
      return value;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
  const setFlash = StateEffect.define();
  const flashField = StateField.define({
    create: () => Decoration.none,
    update(value, tr) {
      value = value.map(tr.changes);
      for (const e of tr.effects) if (e.is(setFlash)) value = e.value;
      return value;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
  const setVizLine = StateEffect.define();
  const vizLineField = StateField.define({
    create: () => Decoration.none,
    update(value, tr) {
      value = value.map(tr.changes);
      for (const e of tr.effects) if (e.is(setVizLine)) value = e.value;
      return value;
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  class CaretWidget extends WidgetType {
    constructor(name, color) { super(); this.name = name; this.color = color; }
    eq(o) { return o.name === this.name && o.color === this.color; }
    toDOM() {
      const caret = document.createElement('span');
      caret.className = 'remote-caret';
      caret.style.borderColor = this.color;
      const tag = document.createElement('div');
      tag.style.backgroundColor = this.color;
      tag.textContent = this.name;
      caret.appendChild(tag);
      return caret;
    }
    ignoreEvent() { return true; }
  }

  /* ---------- completion: C++ keywords and common library names, plus words in the file ---------- */
  const CPP_WORDS = ('alignas alignof auto bool break case catch char char16_t char32_t class const constexpr ' +
    'const_cast continue decltype default delete do double dynamic_cast else enum explicit extern false float for ' +
    'friend goto if inline int long mutable namespace new noexcept nullptr operator private protected public ' +
    'reinterpret_cast return short signed sizeof static static_assert static_cast struct switch template this ' +
    'throw true try typedef typeid typename union unsigned using virtual void volatile while ' +
    'std cout cin cerr endl string vector map set multimap multiset unordered_map unordered_set pair make_pair ' +
    'tuple queue priority_queue stack deque list array bitset optional variant sort stable_sort reverse ' +
    'min max min_element max_element swap begin end size empty push_back emplace_back pop_back push pop top ' +
    'front back insert erase find count lower_bound upper_bound accumulate iota fill memset getline ' +
    'printf scanf puts size_t int64_t uint64_t').split(' ');
  const PREPROC = ['include', 'define', 'ifdef', 'ifndef', 'endif', 'pragma', 'undef', 'elif', 'else', 'if'];
  const cppWords = (ctx) => {
    const word = ctx.matchBefore(/#?\w+/);
    if (!word || (word.from === word.to && !ctx.explicit)) return null;
    if (word.text.startsWith('#')) return { from: word.from + 1, options: PREPROC.map((label) => ({ label, type: 'keyword' })), validFor: /^\w*$/ };
    return { from: word.from, options: CPP_WORDS.map((label) => ({ label, type: 'keyword' })), validFor: /^\w*$/ };
  };

  // Words already in the file, minus the ones the list above offers (no duplicates).
  const KNOWN = new Set(CPP_WORDS);
  const dedupe = (r) => (r ? Object.assign({}, r, { options: r.options.filter((o) => !KNOWN.has(o.label)) }) : r);
  const fileWords = (ctx) => { const r = completeAnyWord(ctx); return r && typeof r.then === 'function' ? r.then(dedupe) : dedupe(r); };

  // Tab inserts spaces at the cursor, or indents the selected lines.
  const tab = (view) => {
    if (view.state.readOnly) return false;
    if (view.state.selection.ranges.some((r) => !r.empty)) return indentMore(view);
    view.dispatch(view.state.update(view.state.replaceSelection('    '), { scrollIntoView: true, userEvent: 'input' }));
    return true;
  };

  const clamp = (pos, doc) => Math.max(0, Math.min(pos, doc.length));

  class Editor {
    constructor(parent, opts) {
      this.opts = opts || {};
      this.readOnly = new Compartment();
      this.flashTimer = 0;
      this.view = new EditorView({ parent, state: this.newState('') });
    }

    extensions(options) {
      const o = this.opts;
      const keys = [{ key: 'Tab', run: tab, shift: indentLess }];
      if (o.onRun) keys.unshift({ key: 'Mod-Enter', run: () => { o.onRun(); return true; } });
      if (o.onFormat) keys.unshift({ key: 'Shift-Alt-f', run: () => { o.onFormat(); return true; } });
      const ro = options.readOnly || o.readOnly;
      return [
        lineNumbers(),
        foldGutter(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        highlightSpecialChars(),
        drawSelection(),
        dropCursor(),
        // Multiple cursors: Ctrl/Cmd+click, Ctrl/Cmd+Alt+Up/Down, Ctrl/Cmd+D, Alt+drag for a column.
        EditorState.allowMultipleSelections.of(true),
        rectangularSelection(),
        crosshairCursor(),
        highlightSelectionMatches(),
        search({ top: true }),
        autocompletion({ override: [cppWords, fileWords] }),
        indentUnit.of('    '),
        EditorState.tabSize.of(4),
        cpp(),
        syntaxHighlighting(highlight),
        bracketMatching(),
        closeBrackets(),
        indentOnInput(),
        // In a room, undo comes from the shared document (only your own edits).
        options.collab ? [options.collab, Prec.high(keymap.of(window.CppCollab.yUndoManagerKeymap))] : [history(), keymap.of(historyKeymap)],
        Prec.highest(keymap.of(keys)),
        keymap.of([...closeBracketsKeymap, ...completionKeymap, ...searchKeymap, ...foldKeymap, ...defaultKeymap]),
        this.readOnly.of(ro ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
        theme,
        marksField,
        flashField,
        vizLineField,
        EditorView.updateListener.of((u) => this.onUpdate(u)),
      ];
    }

    onUpdate(u) {
      const o = this.opts;
      if (u.docChanged && o.onChange) {
        const changes = [];
        for (const tr of u.transactions) {
          if (!tr.docChanged || tr.annotation(External)) continue;
          // iterChanges gives non-overlapping changes in document order, in the old
          // document's coordinates; shift each by what the earlier ones added.
          let shift = 0;
          tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
            const text = inserted.toString();
            changes.push({ pos: fromA + shift, del: toA - fromA, text, tr });
            shift += text.length - (toA - fromA);
          });
        }
        if (changes.length) o.onChange(changes, u);
      }
      if (u.selectionSet && o.onSelection) {
        const s = u.state.selection.main;
        o.onSelection(s.anchor, s.head);
      }
    }

    /* documents */
    newState(text, options) { return EditorState.create({ doc: text || '', extensions: this.extensions(options || {}) }); }
    get state() { return this.view.state; }
    setState(state) { this.view.setState(state); }
    getValue() { return this.view.state.doc.toString(); }
    get length() { return this.view.state.doc.length; }

    // Replaces the text with the smallest single change (keeps undo, cursors and
    // collaborators' positions as stable as possible). Counts as a user edit.
    replaceAll(text) {
      const old = this.getValue();
      if (old === text) return false;
      let s = 0;
      while (s < old.length && s < text.length && old[s] === text[s]) s++;
      let eo = old.length, en = text.length;
      while (eo > s && en > s && old[eo - 1] === text[en - 1]) { eo--; en--; }
      // CodeMirror maps the selection (and collaborators' cursors) through the change.
      this.view.dispatch({ changes: { from: s, to: eo, insert: text.slice(s, en) }, userEvent: 'input.format' });
      return true;
    }

    // A change made by the program (the player); not reported to onChange.
    applyChange(pos, del, text) {
      const doc = this.view.state.doc;
      const from = clamp(pos, doc), to = clamp(pos + del, doc);
      this.view.dispatch({ changes: { from, to, insert: text }, annotations: [External.of(true)] });
    }

    /* cursor, focus, view */
    getSelection() { const s = this.view.state.selection.main; return { anchor: s.anchor, head: s.head }; }
    setCursor(pos) {
      const p = clamp(pos, this.view.state.doc);
      this.view.dispatch({ selection: { anchor: p }, scrollIntoView: true });
    }
    setSelection(anchor, head) {
      const doc = this.view.state.doc;
      this.view.dispatch({ selection: { anchor: clamp(anchor, doc), head: clamp(head, doc) }, scrollIntoView: true });
    }
    scrollTo(pos) {
      const p = clamp(pos, this.view.state.doc);
      this.view.dispatch({ effects: EditorView.scrollIntoView(p, { y: 'nearest', yMargin: 60 }) });
    }
    focus() { this.view.focus(); }
    get hasFocus() { return this.view.hasFocus; }
    refresh() { this.view.requestMeasure(); }
    setReadOnly(on) {
      this.view.dispatch({ effects: this.readOnly.reconfigure(on ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []) });
    }
    get dom() { return this.view.dom; }

    /* decorations: marks = [{ from, to, color }] selections and [{ caret, name, color }] carets */
    setMarks(marks) {
      const doc = this.view.state.doc;
      const ranges = [];
      for (const m of marks) {
        if (m.caret !== undefined) {
          ranges.push(Decoration.widget({ widget: new CaretWidget(m.name, m.color), side: 1 }).range(clamp(m.caret, doc)));
        } else {
          const from = clamp(Math.min(m.from, m.to), doc), to = clamp(Math.max(m.from, m.to), doc);
          if (from < to) ranges.push(Decoration.mark({ attributes: { style: 'background-color:' + m.color } }).range(from, to));
        }
      }
      this.view.dispatch({ effects: setMarks.of(Decoration.set(ranges, true)) });
    }
    // Briefly highlights a range (newly typed text in the player, a jump target in a room).
    flash(from, to, className) {
      const doc = this.view.state.doc;
      from = clamp(from, doc); to = clamp(to, doc);
      const deco = from < to
        ? Decoration.mark({ class: className || 'rec-new' }).range(from, to)
        : Decoration.widget({ widget: new FlashWidget(), side: 1 }).range(from);
      this.view.dispatch({ effects: setFlash.of(Decoration.set([deco])) });
      clearTimeout(this.flashTimer);
      this.flashTimer = setTimeout(() => this.view.dispatch({ effects: setFlash.of(Decoration.none) }), 900);
    }

    // Highlights a line (1-based) or a token range { from, to } on that line for the visualizer, or clears if lineNum <= 0.
    setHighlightedLine(lineNum, tokenRange) {
      const doc = this.view.state.doc;
      if (!lineNum || lineNum < 1 || lineNum > doc.lines) {
        this.view.dispatch({ effects: setVizLine.of(Decoration.none) });
        return;
      }
      const line = doc.line(lineNum);
      const decos = [];

      if (tokenRange && typeof tokenRange.from === 'number' && typeof tokenRange.to === 'number') {
        const fromPos = Math.min(line.to, line.from + Math.max(0, tokenRange.from));
        const toPos = Math.min(line.to, line.from + Math.max(0, tokenRange.to));
        if (fromPos < toPos) {
          decos.push(Decoration.mark({ class: 'viz-token-highlight' }).range(fromPos, toPos));
        }
      } else {
        decos.push(Decoration.line({ class: 'viz-line-highlight' }).range(line.from));
      }

      this.view.dispatch({
        effects: [
          setVizLine.of(Decoration.set(decos)),
          EditorView.scrollIntoView(line.from, { y: 'center', yMargin: 40 }),
        ],
      });
    }
  }

  class FlashWidget extends WidgetType {
    toDOM() { const s = document.createElement('span'); s.className = 'jump-flash'; return s; }
    ignoreEvent() { return true; }
  }

  return {
    create: (parent, opts) => new Editor(parent, opts),
  };
})();
