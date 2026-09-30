import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { MAX_TEXT_BYTES } from "../../shared/text-file";
import { useInvalidateGit, useInvalidateTree } from "../lib/api";
import { FilePreviewError, isAbortError, type PreviewErrorCode } from "../lib/file-preview-api";
import { filePreviewErrorKey } from "../lib/file-preview-error";
import { requestTextFile, type TextFileSnapshot } from "../lib/file-text-api";
import {
  confirmDiscardTextFileDraft,
  discardTextFileDraft,
  editorText,
  getTextFileDraft,
  setTextFileDraft,
  sourceText,
} from "../lib/file-text-drafts";
import { useT } from "../lib/i18n";
import { LoadingIndicator } from "./LoadingIndicator";
import { PlainTextEditor } from "./PlainTextEditor";

const LazyMonacoEditor = lazy(async () => {
  try { return await import("./MonacoTextEditor"); }
  catch { return { default: PlainTextEditor }; }
});

export function FileTextEditor({ cwd, path, name, workspaceKey, mobile = false, onClose }: {
  cwd: string;
  path: string;
  name: string;
  workspaceKey: string;
  mobile?: boolean;
  onClose(): void;
}) {
  const t = useT();
  const [source, setSource] = useState<TextFileSnapshot | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<PreviewErrorCode | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [reload, setReload] = useState(0);
  const mounted = useRef(true);
  const saveRequest = useRef<AbortController | null>(null);
  const invalidateGit = useInvalidateGit();
  const invalidateTree = useInvalidateTree();
  const dirty = source !== null && text !== editorText(source.text);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      saveRequest.current?.abort();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setSource(null);
    setError(null);
    setSaved(false);
    void requestTextFile({ cwd, path, signal: controller.signal }).then((next) => {
      if (controller.signal.aborted) return;
      let draft = getTextFileDraft(cwd, path, workspaceKey);
      if (draft && sourceText(draft.text, draft.source.text) === next.text) {
        discardTextFileDraft(cwd, path, workspaceKey);
        draft = undefined;
      }
      setSource(draft?.source ?? next);
      setText(draft?.text ?? editorText(next.text));
      setConflict(!!draft && draft.source.revision !== next.revision);
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted && !isAbortError(reason)) setError(reason instanceof FilePreviewError ? reason.code : "failed");
    });
    return () => controller.abort();
  }, [cwd, path, workspaceKey, reload]);

  const updateText = useCallback((next: string) => {
    if (!source) return;
    setText(next);
    setSaved(false);
    setTextFileDraft(cwd, path, { source, text: next }, workspaceKey);
  }, [cwd, path, workspaceKey, source]);

  const save = useCallback(async () => {
    if (!source || !dirty || saving || conflict) return;
    const controller = new AbortController();
    saveRequest.current = controller;
    setSaving(true);
    setError(null);
    try {
      const next = await requestTextFile({ cwd, path, save: { text: sourceText(text, source.text), revision: source.revision }, signal: controller.signal });
      if (!mounted.current) return;
      discardTextFileDraft(cwd, path, workspaceKey);
      setSource(next);
      setText(editorText(next.text));
      setSaved(true);
      invalidateGit(cwd);
      invalidateTree(cwd);
    } catch (reason) {
      if (!mounted.current || isAbortError(reason)) return;
      if (reason instanceof FilePreviewError && reason.code === "changed") setConflict(true);
      else setError(reason instanceof FilePreviewError ? reason.code : "failed");
    } finally {
      if (mounted.current) setSaving(false);
      if (saveRequest.current === controller) saveRequest.current = null;
    }
  }, [source, text, dirty, saving, conflict, cwd, path, workspaceKey, invalidateGit, invalidateTree]);

  const close = () => {
    if (confirmDiscardTextFileDraft(cwd, path, t("fileEditDiscard"), workspaceKey)) onClose();
  };
  const reloadFile = () => {
    if (!confirmDiscardTextFileDraft(cwd, path, t("fileEditReloadConfirm"), workspaceKey)) return;
    setConflict(false);
    setReload((value) => value + 1);
  };
  const editorProps = { value: text, onChange: updateText, onSave: () => void save(), readOnly: saving, label: t("fileEditorLabel", { name }), workspaceKey, cwd, path, mobile };

  return (
    <section className="flex h-full min-h-0 flex-col bg-canvas" aria-label={t("fileEditorLabel", { name })}>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink" title={path}>{name}</span>
        <button type="button" className="rounded px-2 py-1.5 text-xs text-muted hover:bg-hover" onClick={close} disabled={saving}>{t("fileEditBack")}</button>
        <button type="button" className="rounded bg-ink px-3 py-1.5 text-xs font-medium text-canvas disabled:opacity-40" onClick={() => void save()} disabled={!dirty || saving || conflict}>{t(saving ? "fileEditSaving" : "fileEditSave")}</button>
      </div>
      {(conflict || error) && (
        <div role="alert" className="shrink-0 border-b border-line bg-hover px-3 py-2 text-sm text-ink">
          {conflict ? t("fileEditConflict") : t(error === "unsupported" || error === "too-large" ? "fileEditUnavailable" : filePreviewErrorKey(error!), { name, size: MAX_TEXT_BYTES / 1024 / 1024 })}
          <button type="button" className="ml-2 rounded px-2 py-1 font-medium underline hover:bg-card" onClick={reloadFile} disabled={saving}>{t("fileEditReload")}</button>
        </div>
      )}
      {source ? (
        mobile ? <PlainTextEditor {...editorProps} /> : <Suspense fallback={<div className="flex min-h-0 flex-1 items-center justify-center"><LoadingIndicator label={t("loading")} showLabel /></div>}><LazyMonacoEditor {...editorProps} /></Suspense>
      ) : !error ? (
        <div className="flex min-h-0 flex-1 items-center justify-center"><LoadingIndicator label={t("loading")} showLabel /></div>
      ) : <div className="flex-1" />}
      <div role="status" className="shrink-0 border-t border-line px-3 py-1.5 text-xs text-muted">
        {t(saved ? "fileEditSaved" : dirty ? "fileEditUnsaved" : "fileEditTextOnly")}
      </div>
    </section>
  );
}
