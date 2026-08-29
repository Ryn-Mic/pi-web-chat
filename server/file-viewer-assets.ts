import { existsSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const FILE_VIEWER_URL_PREFIX = "/file-viewer/";
export const FILE_VIEWER_URL_ROOT = FILE_VIEWER_URL_PREFIX.slice(0, -1);

const require = createRequire(import.meta.url);

export class FileViewerAssetPathEscapeError extends Error {
  constructor(pathname: string) {
    super(`File Viewer asset path escapes its package root: ${pathname}`);
    this.name = "FileViewerAssetPathEscapeError";
  }
}

export function resolveFileViewerAssetRoot(
  resolvePackageJson: (specifier: string) => string = (specifier) => require.resolve(specifier),
): string {
  const packageJson = resolvePackageJson("file-viewer-copy-assets/package.json");
  const assetRoot = join(dirname(packageJson), "viewer");
  if (!statSync(assetRoot).isDirectory()) {
    throw new Error(`File Viewer asset root is not a directory: ${assetRoot}`);
  }
  return assetRoot;
}

export const FILE_VIEWER_ASSET_ROOT = resolveFileViewerAssetRoot();

export function resolveFileViewerAssetPath(
  pathname: string,
  assetRoot = FILE_VIEWER_ASSET_ROOT,
): string | null {
  if (!pathname.startsWith(FILE_VIEWER_URL_PREFIX)) return null;

  const root = realpathSync(resolve(assetRoot));
  const candidate = resolve(root, pathname.slice(FILE_VIEWER_URL_PREFIX.length));
  assertPathInsideAssetRoot(root, candidate, pathname);
  if (existsSync(candidate)) {
    assertPathInsideAssetRoot(root, realpathSync(candidate), pathname);
  }
  return candidate;
}

function assertPathInsideAssetRoot(root: string, candidate: string, pathname: string): void {
  const relativePath = relative(root, candidate);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new FileViewerAssetPathEscapeError(pathname);
  }
}
