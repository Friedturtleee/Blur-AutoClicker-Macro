import {
  acceptCompletion,
  type Completion,
  type CompletionContext,
} from "@codemirror/autocomplete";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import {
  forceLinting,
  lintGutter,
  linter,
  type Diagnostic,
} from "@codemirror/lint";
import { indentUnit, syntaxHighlighting } from "@codemirror/language";
import { indentMore } from "@codemirror/commands";
import { basicSetup } from "codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { memo, useEffect, useRef } from "react";
import type { MacroValidation } from "../../../macro/types";
import { bmsHighlightStyle, bmsLanguage } from "../../../macro/bmsLanguage";

interface Props {
  value: string;
  errors: MacroValidation["errors"];
  editable?: boolean;
  onChange: (value: string) => void;
}

const completions: Completion[] = [
  {
    label: "target",
    apply: 'target process="" title_contains=""',
    type: "keyword",
    detail: "選擇目標視窗",
  },
  {
    label: "mode",
    apply: "mode foreground",
    type: "keyword",
    detail: "前景輸入模式",
  },
  { label: "foreground", type: "enum", detail: "使用實體輸入" },
  { label: "background", type: "enum", detail: "嚴格背景模式" },
  { label: "strict=true", type: "property", detail: "背景模式必須明確指定" },
  {
    label: "move",
    apply: "move x= y= space=screen duration=100ms",
    type: "keyword",
    detail: "移動游標",
  },
  {
    label: "click",
    apply: "click button=left count=1 radius=0",
    type: "keyword",
    detail: "點擊",
  },
  { label: "button=left", type: "property", detail: "滑鼠按鍵" },
  { label: "button=right", type: "property", detail: "滑鼠按鍵" },
  { label: "button=middle", type: "property", detail: "滑鼠按鍵" },
  { label: "space=screen", type: "property", detail: "虛擬桌面座標" },
  { label: "space=client", type: "property", detail: "視窗用戶端座標" },
  {
    label: "mouse_down",
    apply: "mouse_down button=left",
    type: "keyword",
    detail: "按住滑鼠按鍵",
  },
  {
    label: "mouse_up",
    apply: "mouse_up button=left",
    type: "keyword",
    detail: "放開滑鼠按鍵",
  },
  {
    label: "key_down",
    apply: 'key_down "CTRL"',
    type: "keyword",
    detail: "按住按鍵",
  },
  {
    label: "key_up",
    apply: 'key_up "CTRL"',
    type: "keyword",
    detail: "放開按鍵",
  },
  {
    label: "press",
    apply: 'press "CTRL+A"',
    type: "keyword",
    detail: "送出快捷鍵",
  },
  { label: "type", apply: 'type "文字"', type: "keyword", detail: "輸入文字" },
  {
    label: "scroll",
    apply: "scroll delta=-120 x= y= space=screen",
    type: "keyword",
    detail: "捲動",
  },
  { label: "wait", apply: "wait 250ms", type: "keyword", detail: "可中斷等待" },
  { label: "let", apply: "let count = 0", type: "keyword", detail: "建立變數" },
  {
    label: "set",
    apply: "set count = count + 1",
    type: "keyword",
    detail: "更新變數",
  },
  {
    label: "repeat",
    apply: "repeat 3 {\n  \n}",
    type: "keyword",
    detail: "重複執行",
  },
  {
    label: "while",
    apply: "while ready == true {\n  \n}",
    type: "keyword",
    detail: "條件迴圈",
  },
  {
    label: "if",
    apply: "if ready == true {\n  \n} else {\n  \n}",
    type: "keyword",
    detail: "條件分支",
  },
  {
    label: "window_exists",
    apply: 'window_exists(process="app.exe")',
    type: "keyword",
    detail: "檢查視窗是否存在",
  },
  {
    label: "log",
    apply: 'log "完成"',
    type: "keyword",
    detail: "新增執行記錄",
  },
];

function bmsCompletions(context: CompletionContext) {
  const word = context.matchBefore(/[\w=.-]*/);
  if ((!word || word.from === word.to) && !context.explicit) return null;
  return {
    from: word?.from ?? context.pos,
    options: completions,
    validFor: /[\w=.-]*/,
  };
}

function toDiagnostics(
  view: EditorView,
  errors: Props["errors"],
): Diagnostic[] {
  return errors.map((error) => {
    const lineNumber = Math.max(1, Math.min(error.line, view.state.doc.lines));
    const line = view.state.doc.line(lineNumber);
    const codePointColumn = Math.max(0, error.column - 1);
    const utf16Column = Array.from(line.text)
      .slice(0, codePointColumn)
      .join("").length;
    const from = Math.min(line.from + utf16Column, line.to);
    return {
      from,
      to: Math.min(from + 1, line.to),
      severity: "error",
      message: `Line ${error.line}, column ${error.column}: ${error.message}`,
    };
  });
}

const MacroCodeEditor = memo(function MacroCodeEditor({
  value,
  errors,
  editable = true,
  onChange,
}: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const lastEmittedDocumentRef = useRef<string | null>(null);
  const initialValueRef = useRef(value);
  const initialEditableRef = useRef(editable);
  const onChangeRef = useRef(onChange);
  const errorsRef = useRef(errors);
  const editableCompartmentRef = useRef<Compartment | null>(null);
  if (editableCompartmentRef.current === null) {
    editableCompartmentRef.current = new Compartment();
  }

  useEffect(() => {
    if (!parentRef.current) return;
    const view = new EditorView({
      parent: parentRef.current,
      state: EditorState.create({
        doc: initialValueRef.current,
        extensions: [
          Prec.highest(
            keymap.of([
              {
                key: "Tab",
                run: (editor) => acceptCompletion(editor) || indentMore(editor),
              },
              { key: "Enter", run: acceptCompletion },
            ]),
          ),
          basicSetup,
          editableCompartmentRef.current!.of([
            EditorView.editable.of(initialEditableRef.current),
            EditorState.readOnly.of(!initialEditableRef.current),
          ]),
          bmsLanguage,
          syntaxHighlighting(bmsHighlightStyle),
          bmsLanguage.data.of({ autocomplete: bmsCompletions }),
          indentUnit.of("  "),
          lintGutter(),
          linter((editor) => toDiagnostics(editor, errorsRef.current)),
          EditorState.tabSize.of(2),
          EditorView.contentAttributes.of({
            "aria-label": "Blur Macro Script source",
            spellcheck: "false",
          }),
          EditorView.theme({
            "&": {
              height: "100%",
              backgroundColor: "transparent",
              color: "var(--text-primary)",
              fontSize: "0.8rem",
            },
            ".cm-scroller": {
              overflow: "auto",
              fontFamily: '"Cascadia Mono", Consolas, monospace',
              lineHeight: "1.5",
            },
            ".cm-content": {
              minHeight: "100%",
              caretColor: "var(--text-primary)",
            },
            ".cm-gutters": {
              backgroundColor: "var(--bg-elevated)",
              color: "var(--text-dim)",
              borderRight: "1px solid var(--border-subtle)",
            },
            ".cm-activeLineGutter": {
              backgroundColor:
                "color-mix(in srgb, var(--accent) 12%, var(--bg-elevated))",
            },
            ".cm-activeLine": {
              backgroundColor:
                "color-mix(in srgb, var(--accent) 7%, transparent)",
            },
            ".cm-cursor, .cm-dropCursor": {
              borderLeftColor: "var(--text-primary)",
            },
            "&.cm-focused": { outline: "none" },
            ".cm-tooltip": {
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius-md)",
              backgroundColor: "var(--bg-elevated)",
              color: "var(--text-primary)",
            },
            ".cm-tooltip-autocomplete ul li[aria-selected]": {
              backgroundColor: "var(--bg-input)",
              color: "var(--text-primary)",
            },
            ".cm-diagnostic-error": { borderLeftColor: "var(--danger)" },
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              const document = update.state.doc.toString();
              lastEmittedDocumentRef.current = document;
              onChangeRef.current(document);
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: editableCompartmentRef.current!.reconfigure([
        EditorView.editable.of(editable),
        EditorState.readOnly.of(!editable),
      ]),
    });
  }, [editable]);

  useEffect(() => {
    onChangeRef.current = onChange;
    const view = viewRef.current;
    if (!view) return;
    const lastEmittedDocument = lastEmittedDocumentRef.current;
    lastEmittedDocumentRef.current = null;
    if (lastEmittedDocument === value) {
      return;
    }
    if (view.state.doc.toString() === value) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    });
  }, [onChange, value]);

  useEffect(() => {
    errorsRef.current = errors;
    if (viewRef.current) forceLinting(viewRef.current);
  }, [errors]);

  return (
    <div
      className="macro-editor-codemirror"
      ref={parentRef}
      aria-disabled={!editable}
      title={editable ? undefined : "Editor locked while recording."}
    />
  );
});

export default MacroCodeEditor;
