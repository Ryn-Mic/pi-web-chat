export type PreviewFrameErrorCode =
  | "unsupported"
  | "malformed"
  | "too-large"
  | "forbidden"
  | "missing"
  | "changed"
  | "expired"
  | "failed";

export type PreviewFrameMessage =
  | { type: "file-preview-ready" }
  | { type: "file-preview-error"; code: PreviewFrameErrorCode };

export interface FramePreviewFile {
  file: File;
  theme: "light" | "dark";
  locale: "en-US" | "zh-CN" | "ja-JP";
}

const CONTENT_URL = "/api/files/preview-content";

export function createPreviewFrameSrc(contextId: string): string {
  return `/file-preview.html#context=${encodeURIComponent(contextId)}`;
}

export function consumePreviewContextFromHash(
  hash = location.hash,
  replaceState: (data: unknown, unused: string, url?: string | URL | null) => void =
    history.replaceState.bind(history),
): string | null {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const id = params.get("context")?.trim() ?? "";
  replaceState(history.state, "", `${location.pathname}${location.search}`);
  return id || null;
}

export function isPreviewFrameMessage(
  event: Pick<MessageEvent, "origin" | "source" | "data">,
  expectedWindow: Window | null,
  expectedOrigin: string,
): event is MessageEvent<PreviewFrameMessage> {
  if (event.origin !== expectedOrigin || event.source !== expectedWindow) return false;
  const data = event.data as Partial<PreviewFrameMessage> | null;
  if (!data || typeof data !== "object") return false;
  if (data.type === "file-preview-ready") return true;
  const codes: readonly PreviewFrameErrorCode[] = [
    "unsupported",
    "malformed",
    "too-large",
    "forbidden",
    "missing",
    "changed",
    "expired",
    "failed",
  ];
  return data.type === "file-preview-error" && codes.includes(data.code as PreviewFrameErrorCode);
}

function filenameFromDisposition(value: string | null): string {
  if (!value) return "file";
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(value)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded).replace(/[\\/\u0000-\u001f\u007f]/g, "") || "file";
    } catch {
      return "file";
    }
  }
  return "file";
}

function mapStatus(status: number): PreviewFrameErrorCode {
  if (status === 403) return "forbidden";
  if (status === 404) return "missing";
  if (status === 409) return "changed";
  if (status === 410) return "expired";
  if (status === 413) return "too-large";
  if (status === 415) return "unsupported";
  return "failed";
}

export class PreviewFrameError extends Error {
  constructor(readonly code: PreviewFrameErrorCode) {
    super(code);
  }
}

export async function loadFramePreviewFile(input: {
  contextId: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<FramePreviewFile> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const headers = { authorization: `Preview ${input.contextId}` };
  const head = await fetchImpl(CONTENT_URL, {
    method: "HEAD",
    headers,
    signal: input.signal,
  });
  if (!head.ok) throw new PreviewFrameError(mapStatus(head.status));

  const response = await fetchImpl(CONTENT_URL, {
    method: "GET",
    headers,
    signal: input.signal,
  });
  if (!response.ok) throw new PreviewFrameError(mapStatus(response.status));

  const blob = await response.blob();
  const type = blob.type || head.headers.get("content-type") || "application/octet-stream";
  const file = new File(
    [blob],
    filenameFromDisposition(head.headers.get("content-disposition")),
    { type },
  );
  const theme = head.headers.get("x-preview-theme") === "dark" ? "dark" : "light";
  const rawLocale = head.headers.get("x-preview-locale");
  const locale = rawLocale === "zh-CN" || rawLocale === "ja-JP" ? rawLocale : "en-US";
  return { file, theme, locale };
}
