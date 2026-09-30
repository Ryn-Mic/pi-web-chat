import type { Messages } from "../i18n/en";
import type { PreviewErrorCode } from "./file-preview-api";

export function filePreviewErrorKey(code: PreviewErrorCode): keyof Messages {
  switch (code) {
    case "unsupported": return "filePreviewUnsupported";
    case "malformed": return "filePreviewMalformed";
    case "too-large": return "filePreviewTooLarge";
    case "forbidden": return "filePreviewForbidden";
    case "missing": return "filePreviewMissing";
    case "changed": return "filePreviewChanged";
    case "expired": return "filePreviewExpired";
    default: return "filePreviewFailed";
  }
}
