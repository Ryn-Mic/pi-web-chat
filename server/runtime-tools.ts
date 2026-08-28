import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

/**
 * Keep filesystem tools bound to the runtime cwd even when a UI extension
 * overrides Pi's built-ins with tools captured from the host process cwd.
 */
export function createCwdBoundCoreTools(
  cwd: string,
  settingsManager: SettingsManager,
): ToolDefinition[] {
  return [
    createReadTool(cwd, {
      autoResizeImages: settingsManager.getImageAutoResize(),
    }),
    createBashTool(cwd, {
      commandPrefix: settingsManager.getShellCommandPrefix(),
      shellPath: settingsManager.getShellPath(),
    }),
    createEditTool(cwd),
    createWriteTool(cwd),
    createGrepTool(cwd),
    createFindTool(cwd),
    createLsTool(cwd),
  ] as ToolDefinition[];
}
