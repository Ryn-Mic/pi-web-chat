/** Shared ownership rules for Workbox selection and production build gates. */
export type FrontendChunk = {
  file: string;
  facadeModuleId: string | null;
  moduleIds: string[];
  imports: string[];
  dynamicImports: string[];
  assets?: string[];
};

export const MAX_CHAT_STATIC_BYTES = 2 * 1024 * 1024;
export const MAX_APP_PRECACHE_BYTES = 6 * 1024 * 1024;

export function assertAppPrecacheBudget(entries: { url: string; size?: number }[]): number {
  const bytes = entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
  if (bytes > MAX_APP_PRECACHE_BYTES) throw new Error(`app precache size ${bytes} exceeds ${MAX_APP_PRECACHE_BYTES}`);
  return bytes;
}

export function isHeavyViewerModule(id: string): boolean {
  return /\/node_modules\/@file-viewer\/(?:react-full|preset-all|renderer-[^/]+)\//.test(id.replaceAll("\\", "/")) ||
    id === "\0pi-web-chat:packaged-ppt-fallback" || id.includes("/node_modules/rtf.js/");
}

export function frontendBuildGraph(chunks: FrontendChunk[]) {
  const byFile = new Map(chunks.map((chunk) => [chunk.file, chunk]));
  const chatEntries = chunks.filter((chunk) => chunk.facadeModuleId?.replaceAll("\\", "/").endsWith("/index.html"));
  if (chatEntries.length !== 1) throw new Error("expected exactly one chat index.html chunk");
  function collect(starts: string[], dynamic: boolean, found = new Set<string>()): Set<string> {
    for (const file of starts) {
      if (found.has(file)) continue;
      const chunk = byFile.get(file);
      if (!chunk) continue; // imports can also name emitted CSS or other assets
      found.add(file);
      collect([...chunk.imports, ...(dynamic ? chunk.dynamicImports : [])], dynamic, found);
    }
    return found;
  }
  const chatStatic = collect([chatEntries[0].file], false);
  const heavyStatic = chunks.filter((chunk) => chatStatic.has(chunk.file) && chunk.moduleIds.some(isHeavyViewerModule));
  if (heavyStatic.length > 0) throw new Error(`heavy File Viewer modules leaked into chat static graph: ${heavyStatic.map((chunk) => chunk.file).join(", ")}`);
  const viewerGraph = collect(chunks.filter((chunk) => chunk.moduleIds.some(isHeavyViewerModule)).map((chunk) => chunk.file), true);
  const assetsFor = (graph: Set<string>) => [...graph].flatMap((file) => byFile.get(file)?.assets ?? []);
  const chatRequired = new Set([...chatStatic, ...assetsFor(chatStatic)]);
  const viewerOnly = new Set([...viewerGraph, ...assetsFor(viewerGraph)].filter((file) => !chatRequired.has(file)));
  return { chatStatic, viewerOnly };
}

export function selectAppPrecache<T extends { url: string }>(entries: T[], chunks: FrontendChunk[]): T[] {
  const { viewerOnly } = frontendBuildGraph(chunks);
  return entries.filter((entry) => !entry.url.startsWith("file-viewer/") && !viewerOnly.has(entry.url));
}
