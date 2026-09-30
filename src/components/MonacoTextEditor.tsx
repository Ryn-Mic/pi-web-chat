import { useEffect, useRef, useState } from "react";
import * as monaco from "monaco-editor/editor/editor.api.js";
import "monaco-editor/editor/contrib/find/browser/findController.js";
import "monaco-editor/languages/definitions/typescript/register.js";
import "monaco-editor/languages/definitions/javascript/register.js";
import "monaco-editor/languages/definitions/css/register.js";
import "monaco-editor/languages/definitions/html/register.js";
import "monaco-editor/languages/definitions/markdown/register.js";
import "monaco-editor/languages/definitions/python/register.js";
import "monaco-editor/languages/definitions/shell/register.js";
import "monaco-editor/languages/definitions/yaml/register.js";
import "monaco-editor/languages/definitions/go/register.js";
import "monaco-editor/languages/definitions/rust/register.js";
import "monaco-editor/languages/definitions/sql/register.js";
import "monaco-editor/languages/definitions/dockerfile/register.js";
import "monaco-editor/languages/definitions/ini/register.js";
import EditorWorker from "../lib/monaco-editor.worker?worker";
import { useTheme } from "../lib/theme";
import { PlainTextEditor, type SourceEditorProps } from "./PlainTextEditor";

globalThis.MonacoEnvironment = { getWorker: () => new EditorWorker() };
// Syntax coloring only: the source editor never needs an extra JSON language
// service or TypeScript worker to edit and save a project file.
monaco.languages.register({ id: "json", extensions: [".json", ".jsonc", ".jsonl"] });
monaco.languages.setMonarchTokensProvider("json", { tokenizer: { root: [
  [/"(?:[^"\\]|\\.)*"\s*(?=:)/, "string.key"],
  [/"(?:[^"\\]|\\.)*"/, "string.value"],
  [/\b(?:true|false|null)\b/, "keyword"],
  [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, "number"],
  [/\/\/.*$/, "comment"],
  [/[{}\[\],:]/, "delimiter"],
] } });

function sourceLanguage(path: string): string {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  if (name === ".env" || name.startsWith(".env.")) return "ini";
  const extension = /\.[^.]+$/.exec(name)?.[0];
  return monaco.languages.getLanguages().find((language) =>
    language.filenames?.some((filename) => filename.toLowerCase() === name) ||
    (extension && language.extensions?.includes(extension)),
  )?.id ?? "plaintext";
}

export default function MonacoTextEditor(props: SourceEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const instance = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const callbacks = useRef(props);
  callbacks.current = props;
  const theme = useTheme();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!host.current) return;
    let model: monaco.editor.ITextModel | undefined;
    let editor: monaco.editor.IStandaloneCodeEditor | undefined;
    let change: monaco.IDisposable | undefined;
    try {
      const uri = monaco.Uri.from({ scheme: "pi-web-source", authority: encodeURIComponent(props.workspaceKey), path: `/${encodeURIComponent(props.cwd)}/${encodeURIComponent(props.path)}` });
      model = monaco.editor.createModel(props.value, sourceLanguage(props.path), uri);
      editor = monaco.editor.create(host.current, {
        model,
        ariaLabel: props.label,
        accessibilitySupport: "on",
        editContext: false,
        automaticLayout: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 14,
        lineHeight: 24,
        padding: { top: 12, bottom: 12 },
        readOnly: props.readOnly,
        theme: theme === "dark" ? "vs-dark" : "vs",
        links: false,
      });
      instance.current = editor;
      change = editor.onDidChangeModelContent(() => callbacks.current.onChange(model!.getValue()));
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => callbacks.current.onSave());
    } catch {
      setFailed(true);
    }
    return () => {
      change?.dispose();
      editor?.dispose();
      model?.dispose();
      instance.current = null;
    };
    // Identity changes dispose their model; value changes keep selection/undo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.workspaceKey, props.cwd, props.path]);

  useEffect(() => {
    const editor = instance.current;
    if (!editor) return;
    editor.updateOptions({ readOnly: props.readOnly, ariaLabel: props.label });
    if (editor.getValue() !== props.value) editor.setValue(props.value);
  }, [props.value, props.readOnly, props.label]);
  useEffect(() => { monaco.editor.setTheme(theme === "dark" ? "vs-dark" : "vs"); }, [theme]);

  return failed ? <PlainTextEditor {...props} /> : <div ref={host} className="min-h-0 flex-1" />;
}
