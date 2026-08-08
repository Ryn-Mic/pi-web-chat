import type { UIImageAttachment } from "../../shared/protocol";

export interface ComposerDraftImage extends UIImageAttachment {
  previewUrl: string;
}

export interface ComposerDraft {
  text: string;
  images: ComposerDraftImage[];
}

const drafts = new Map<string, ComposerDraft>();

export function getComposerDraft(key: string): ComposerDraft {
  const draft = drafts.get(key);
  return draft
    ? { text: draft.text, images: [...draft.images] }
    : { text: "", images: [] };
}

export function setComposerDraft(key: string, draft: ComposerDraft) {
  if (!draft.text && draft.images.length === 0) {
    drafts.delete(key);
    return;
  }
  drafts.set(key, { text: draft.text, images: [...draft.images] });
}
