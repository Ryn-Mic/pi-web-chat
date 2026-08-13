import { authHeaders, setAuthStatus } from "./auth";

export type PreviewErrorCode =
  | "unsupported"
  | "malformed"
  | "too-large"
  | "forbidden"
  | "missing"
  | "changed"
  | "expired"
  | "failed";

export class FilePreviewError extends Error {
  constructor(
    readonly code: PreviewErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function buildUrl(cwd: string, path: string): string {
  return `/api/files/content?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`;
}

function sanitizeFilename(raw: string): string | null {
  const normalized = raw.replace(/\\/g, "/");
  const segments = normalized.split("/");
  const base = segments.pop() ?? "";
  // Header values are untrusted: do not expose controls or bidi markers in UI.
  const trimmed = base
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .trim();
  if (!trimmed || trimmed === "." || trimmed === "..") return null;
  return trimmed;
}

function parseRfc5987Filename(value: string): string | null {
  // Strip optional quotes; RFC 5987 values are usually unquoted, but some
  // servers quote them anyway.
  let cleaned = value.trim();
  if (cleaned.length >= 2 && cleaned.startsWith('"') && cleaned.endsWith('"')) {
    cleaned = cleaned.slice(1, -1);
  }

  const firstQuote = cleaned.indexOf("'");
  const secondQuote = cleaned.indexOf("'", firstQuote + 1);
  if (firstQuote === -1 || secondQuote === -1) return null;

  const charset = cleaned.slice(0, firstQuote).trim().toLowerCase();
  if (charset !== "utf-8") return null;

  const encoded = cleaned.slice(secondQuote + 1);
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

function parsePlainFilename(value: string): string | null {
  let cleaned = value.trim();
  if (cleaned.length >= 2 && cleaned.startsWith('"') && cleaned.endsWith('"')) {
    cleaned = cleaned.slice(1, -1);
  }
  try {
    cleaned = decodeURIComponent(cleaned);
  } catch {
    // Keep the raw value; it may have been sent without encoding.
  }
  return cleaned || null;
}

function parseDispositionParameters(header: string): Map<string, string> {
  const parameters = new Map<string, string>();
  let index = header.indexOf(";");

  while (index !== -1 && index < header.length) {
    index += 1;
    while (index < header.length && /[ \t]/.test(header[index]!)) index += 1;

    const nameStart = index;
    while (index < header.length && header[index] !== "=" && header[index] !== ";") {
      index += 1;
    }
    const name = header.slice(nameStart, index).trim().toLowerCase();
    if (!name || header[index] !== "=") {
      index = header[index] === ";" ? index + 1 : header.indexOf(";", index + 1);
      continue;
    }

    index += 1;
    while (index < header.length && /[ \t]/.test(header[index]!)) index += 1;

    let value = "";
    if (header[index] === '"') {
      index += 1;
      while (index < header.length) {
        const current = header[index]!;
        if (current === "\\" && index + 1 < header.length) {
          value += header[index + 1];
          index += 2;
        } else if (current === '"') {
          index += 1;
          break;
        } else {
          value += current;
          index += 1;
        }
      }
      while (index < header.length && header[index] !== ";") index += 1;
    } else {
      const valueStart = index;
      while (index < header.length && header[index] !== ";") index += 1;
      value = header.slice(valueStart, index).trim();
    }

    if (!parameters.has(name)) parameters.set(name, value);
  }

  return parameters;
}

function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const parameters = parseDispositionParameters(header);

  const encoded = parameters.get("filename*");
  if (encoded) {
    const decoded = parseRfc5987Filename(encoded);
    if (decoded) {
      const safe = sanitizeFilename(decoded);
      if (safe) return safe;
    }
  }

  const plain = parameters.get("filename");
  if (plain) {
    const decoded = parsePlainFilename(plain);
    if (decoded) {
      const safe = sanitizeFilename(decoded);
      if (safe) return safe;
    }
  }

  return null;
}

function pathBasename(rel: string): string {
  const normalized = rel.replace(/\\/g, "/");
  const base = normalized.split("/").pop() ?? "";
  const trimmed = base.trim();
  return trimmed || "file";
}

function resolveFilename(inputPath: string, disposition: string | null): string {
  return filenameFromDisposition(disposition) ?? sanitizeFilename(pathBasename(inputPath)) ?? "file";
}

function mapHttpError(status: number): PreviewErrorCode {
  switch (status) {
    case 403:
      return "forbidden";
    case 404:
      return "missing";
    case 409:
      return "changed";
    case 410:
      return "expired";
    case 413:
      return "too-large";
    case 415:
      return "unsupported";
    default:
      return "failed";
  }
}

export function isAbortError(error: unknown): error is Error {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

export async function loadDesktopPreviewFile(input: {
  cwd: string;
  path: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<File> {
  const { cwd, path, signal } = input;
  const fetchImpl = input.fetchImpl ?? fetch;
  const url = buildUrl(cwd, path);

  let attempt = 0;

  while (true) {
    const headRes = await fetchImpl(url, {
      method: "HEAD",
      headers: authHeaders(),
      signal,
    });

    if (headRes.status === 401) {
      setAuthStatus("unauthenticated");
      throw new FilePreviewError("failed", "unauthorized");
    }
    if (!headRes.ok) {
      throw new FilePreviewError(
        mapHttpError(headRes.status),
        `HEAD request failed (${headRes.status})`,
      );
    }

    const etag = headRes.headers.get("etag")?.trim();
    if (!etag) {
      throw new FilePreviewError("failed", "missing ETag");
    }
    const headContentType = headRes.headers.get("content-type");
    const disposition = headRes.headers.get("content-disposition");

    const getHeaders: Record<string, string> = authHeaders();
    getHeaders["If-Match"] = etag;

    const getRes = await fetchImpl(url, {
      method: "GET",
      headers: getHeaders,
      signal,
    });

    if (getRes.status === 401) {
      setAuthStatus("unauthenticated");
      throw new FilePreviewError("failed", "unauthorized");
    }

    if (getRes.status === 409) {
      if (attempt >= 1) {
        throw new FilePreviewError("changed", "content changed");
      }
      attempt += 1;
      continue;
    }

    if (!getRes.ok) {
      throw new FilePreviewError(
        mapHttpError(getRes.status),
        `GET request failed (${getRes.status})`,
      );
    }

    const blob = await getRes.blob();
    const type = blob.type || headContentType || "application/octet-stream";
    const name = resolveFilename(path, disposition);
    return new File([blob], name, { type });
  }
}
