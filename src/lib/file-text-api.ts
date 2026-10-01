import { authHeaders, authenticatedFetch } from "./auth";
import { FilePreviewError } from "./file-preview-api";
import type { UITextFileSnapshot, UITextFileSaveRequest } from "../../shared/protocol";

export type TextFileSnapshot = UITextFileSnapshot;

export async function requestTextFile(input: {
  cwd: string;
  path: string;
  save?: UITextFileSaveRequest;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<TextFileSnapshot> {
  const response = await authenticatedFetch(
    `/api/files/text?cwd=${encodeURIComponent(input.cwd)}&path=${encodeURIComponent(input.path)}`,
    {
      method: input.save ? "PUT" : "GET",
      headers: { ...authHeaders(), ...(input.save ? { "content-type": "application/json" } : {}) },
      body: input.save ? JSON.stringify(input.save) : undefined,
      signal: input.signal,
    },
    input.fetchImpl ?? fetch,
  );
  if (!response.ok) {
    const code = response.status === 409 ? "changed"
      : response.status === 413 ? "too-large"
      : response.status === 415 ? "unsupported"
      : response.status === 403 ? "forbidden"
      : response.status === 404 ? "missing" : "failed";
    throw new FilePreviewError(code, `text file request failed (${response.status})`);
  }
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || !("text" in body) || typeof body.text !== "string" ||
    !("revision" in body) || typeof body.revision !== "string" || !("name" in body) || typeof body.name !== "string") {
    throw new FilePreviewError("failed", "invalid text file response");
  }
  return body as TextFileSnapshot;
}
