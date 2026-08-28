import type { UIImageAttachment } from "../../shared/protocol";

export interface ComposerDraftImage extends UIImageAttachment {
  previewUrl: string;
}

export interface ComposerDraft {
  text: string;
  images: ComposerDraftImage[];
}

export interface SubmittedComposerPrompt {
  text: string;
  images: UIImageAttachment[];
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

export function clearComposerDraft(key: string) {
  drafts.delete(key);
}

export function clearComposerDraftIfMatches(key: string, submitted: SubmittedComposerPrompt) {
  const draft = drafts.get(key);
  if (!draft || draft.text.trim() !== submitted.text.trim()) return;
  if (draft.images.length !== submitted.images.length) return;
  if (
    draft.images.some(
      (image, index) =>
        image.data !== submitted.images[index]?.data ||
        image.mimeType !== submitted.images[index]?.mimeType,
    )
  ) {
    return;
  }
  drafts.delete(key);
}
