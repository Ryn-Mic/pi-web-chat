#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const MAX_PACKED_BYTES = 150 * 1024 * 1024;
export const MAX_UNPACKED_BYTES = 500 * 1024 * 1024;
export const REQUIRED_RUNTIME_FILES = [
  "bin/pi-web-chat.mjs",
  "dist/cli.js",
  "dist/index.js",
  "extensions/agent-binaries.ts",
  "extensions/daemon-manager.ts",
  "extensions/pi-web-chat.ts",
];

export function assertPackSizeWithinLimits({ size, unpackedSize }) {
  if (size > MAX_PACKED_BYTES) {
    throw new Error(`packed size ${size} exceeds ${MAX_PACKED_BYTES}`);
  }
  if (unpackedSize > MAX_UNPACKED_BYTES) {
    throw new Error(`unpacked size ${unpackedSize} exceeds ${MAX_UNPACKED_BYTES}`);
  }
}

export function assertRequiredPackFiles(files) {
  const names = new Set((files ?? []).map((file) => file?.path).filter(Boolean));
  const missing = REQUIRED_RUNTIME_FILES.filter((file) => !names.has(file));
  if (missing.length > 0) {
    throw new Error(`npm package is missing runtime files: ${missing.join(", ")}`);
  }
}

function mib(bytes) {
  return (bytes / 1024 / 1024).toFixed(2);
}

export function main() {
  const output = execFileSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
  );
  const parsed = JSON.parse(output);
  const candidate = Array.isArray(parsed) ? parsed[0] : parsed;
  const result =
    candidate && typeof candidate.size === "number"
      ? candidate
      : candidate && typeof candidate === "object"
        ? Object.values(candidate)[0]
        : null;
  if (!result || typeof result.size !== "number" || typeof result.unpackedSize !== "number") {
    throw new Error("npm pack returned invalid size metadata");
  }
  assertPackSizeWithinLimits(result);
  assertRequiredPackFiles(result.files);
  console.log(
    `package size: ${mib(result.size)} MiB packed, ${mib(result.unpackedSize)} MiB unpacked, ${result.entryCount ?? result.files?.length ?? 0} files`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
