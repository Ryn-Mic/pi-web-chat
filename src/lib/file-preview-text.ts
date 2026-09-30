import { decodeTextBytes, MAX_TEXT_BYTES } from "../../shared/text-file";

/** Unknown extensions can use the existing text renderer without executing markup. */
export async function fallbackTextPreview(file: File): Promise<File | null> {
  if (file.size > MAX_TEXT_BYTES) return null;
  const text = decodeTextBytes(new Uint8Array(await file.arrayBuffer()));
  return text === null ? null : new File([text], `${file.name}.txt`, { type: "text/plain" });
}
