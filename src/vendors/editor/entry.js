// cpp.wasm editor bundle: CodeMirror 6 (editor), Yjs + y-codemirror.next +
// y-protocols (collaborative editing) and Trystero (WebRTC peers). They share
// one copy of each dependency, which CodeMirror and Yjs both require.
// Exposed as window.CM6 (used by src/js/editor.js) and window.CppCollab
// (used by src/js/collab.js).
import { EditorState, EditorSelection, Compartment, StateEffect, StateField, Annotation, Prec } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightActiveLine, highlightSpecialChars,
  drawSelection, dropCursor, rectangularSelection, crosshairCursor, Decoration, WidgetType,
} from '@codemirror/view';
import { history, historyKeymap, defaultKeymap, indentMore, indentLess, insertTab } from '@codemirror/commands';
import { indentUnit, bracketMatching, syntaxHighlighting, HighlightStyle, indentOnInput, foldGutter, foldKeymap } from '@codemirror/language';
import { cpp } from '@codemirror/lang-cpp';
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap, completeAnyWord } from '@codemirror/autocomplete';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { tags } from '@lezer/highlight';

import * as Y from 'yjs';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import * as awarenessProtocol from 'y-protocols/awareness';
import { joinRoom, selfId } from 'trystero';

window.CM6 = {
  EditorState, EditorSelection, Compartment, StateEffect, StateField, Annotation, Prec,
  EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightActiveLine, highlightSpecialChars,
  drawSelection, dropCursor, rectangularSelection, crosshairCursor, Decoration, WidgetType,
  history, historyKeymap, defaultKeymap, indentMore, indentLess, insertTab,
  indentUnit, bracketMatching, syntaxHighlighting, HighlightStyle, indentOnInput, foldGutter, foldKeymap,
  cpp, closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap, completeAnyWord,
  search, searchKeymap, highlightSelectionMatches, tags,
};
window.CppCollab = { Y, yCollab, yUndoManagerKeymap, awarenessProtocol, joinRoom, selfId };
