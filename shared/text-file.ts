/** Maximum source file size supported by the remote text editor. */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;

/** Decode text without silently replacing invalid bytes or stripping a UTF-8 BOM. */
export function decodeTextBytes(bytes: Uint8Array): string | null {
  if (bytes.byteLength > MAX_TEXT_BYTES) return null;
  // Some document containers are entirely ASCII at the start. They still must
  // stay with their document renderer rather than being rewritten as source.
  if (bytes.length >= 5 && String.fromCharCode(...bytes.subarray(0, 5)) === "%PDF-") return null;
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4) return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) ? null : text;
  } catch {
    return null;
  }
}
