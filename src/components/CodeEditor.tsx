import { useEffect, useRef } from 'react';
import { basicSetup } from 'codemirror';
import { Compartment, EditorState, Prec, StateEffect, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { languages } from '@codemirror/language-data';
import { LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { classHighlighter } from '@lezer/highlight';

const cachedStates = new Map<string, EditorState>();
const forgottenStates = new Set<string>();
export function forgetEditor(key: string) { cachedStates.delete(key); forgottenStates.add(key); }

export function CodeEditor({ id, path, text, readOnly, onChange, onSave }: {
  id: string; path: string; text: string; readOnly: boolean;
  onChange: (text: string) => void; onSave: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>();
  const callbacks = useRef({ onChange, onSave });
  callbacks.current = { onChange, onSave };
  useEffect(() => {
    if (!host.current) return;
    forgottenStates.delete(id);
    const language = new Compartment();
    const editable = new Compartment();
    const extensions: Extension[] = [basicSetup, syntaxHighlighting(classHighlighter), language.of([]), editable.of(EditorState.readOnly.of(readOnly)),
        Prec.highest(keymap.of([{ key: 'Mod-s', run: () => { callbacks.current.onSave(); return true; } }])),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) callbacks.current.onChange(update.state.doc.toString());
        }),
        EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--mono)', fontSize: 'var(--code-size, 12px)' },
          '.cm-content': { caretColor: 'var(--fg)' }, '.cm-gutters': { background: 'var(--bg-2)', color: 'var(--fg-muted)', borderColor: 'var(--border)' },
          '.cm-activeLine, .cm-activeLineGutter': { background: 'var(--bg-2)' }, '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { background: 'var(--selected)' } }),
      ];
    // Preserve selection and undo history across tab/repository switches.
    const previous = cachedStates.get(id);
    const state = previous && previous.doc.toString() === text
      ? previous.update({ effects: StateEffect.reconfigure.of(extensions) }).state
      : EditorState.create({ doc: text, extensions });
    const editor = new EditorView({ state, parent: host.current });
    view.current = editor;
    let disposed = false;
    const description = LanguageDescription.matchFilename(languages, path.split('/').pop() ?? path);
    if (description) void description.load().then((support) => {
      if (!disposed) editor.dispatch({ effects: language.reconfigure(support) });
    }).catch(() => undefined);
    return () => {
      disposed = true;
      if (!forgottenStates.delete(id)) cachedStates.set(id, editor.state);
      editor.destroy();
      view.current = undefined;
    };
    // Editor instances follow file identity. Content updates are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, path, readOnly]);
  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== text) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } });
    }
  }, [text]);
  return <div className="code-editor" ref={host} />;
}
