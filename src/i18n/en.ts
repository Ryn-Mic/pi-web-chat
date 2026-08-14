export type Messages = {
  // common / chrome
  connected: string;
  connecting: string;
  connectingHint: string;
  loading: string;
  connectionLost: string;
  disconnected: string;
  settings: string;
  theme: string;
  themeSystem: string;
  themeLight: string;
  themeDark: string;
  conversationFontSize: string;
  fontSizeTiny: string;
  fontSizeSmall: string;
  fontSizeDefault: string;
  fontSizeLarge: string;
  fontSizeTinyShort: string;
  fontSizeSmallShort: string;
  fontSizeDefaultShort: string;
  fontSizeLargeShort: string;
  language: string;
  browserNotifications: string;

  // sessions
  sessions: string;
  newSession: string;
  resumeSession: string;
  newSessionInProject: string;
  renameSession: string;
  deleteSession: string;
  confirmDelete: string;
  sessionNamePlaceholder: string;
  emptySession: string;
  messageCount: string;
  noSavedSessions: string;
  noProject: string;
  sessionList: string;
  pinSidebar: string;
  unpinSidebar: string;
  closeSidebar: string;
  closeSessionTab: string;
  workspace: string;

  // files
  files: string;
  openFiles: string;
  closeFiles: string;
  refreshTree: string;
  emptyDirectory: string;
  treeLoadError: string;
  treeTruncated: string;
  inaccessible: string;
  mentionNoFiles: string;
  mentionPartial: string;

  // file preview
  filePreviewLoading: string;
  filePreviewUnsupported: string;
  filePreviewMalformed: string;
  filePreviewTooLarge: string;
  filePreviewForbidden: string;
  filePreviewMissing: string;
  filePreviewChanged: string;
  filePreviewExpired: string;
  filePreviewFailed: string;
  filePreviewRetry: string;
  previewFile: string;
  referenceFile: string;
  closePreviewTab: string;
  refreshPreview: string;
  backToFiles: string;
  closePreview: string;

  // git
  git: string;
  gitDirty: string;
  gitClean: string;
  gitStaged: string;
  gitChanged: string;
  gitUntracked: string;
  gitConflicted: string;
  gitStagedFiles: string;
  gitChangedFiles: string;
  gitUntrackedFiles: string;
  gitBranches: string;
  gitRecentCommits: string;
  gitNoChanges: string;
  gitNotRepository: string;
  gitOperationFailed: string;
  gitConfirmDiscard: string;
  gitBackToLog: string;
  backToGit: string;
  closeCommit: string;
  gitNoDiff: string;

  // composer
  sendMessage: string;
  streamingPlaceholder: string;
  attachImage: string;
  removeImage: string;
  send: string;
  abort: string;

  // model
  selectModel: string;
  searchModels: string;
  clearSearch: string;
  noModelsAvailable: string;
  noSearchResults: string;

  // fork
  forkSession: string;
  forkSessionEllipsis: string;
  forkDescription: string;
  emptyMessage: string;
  noForkPoints: string;

  // extensions
  activeExtensions: string;
  activeExtensionsEllipsis: string;
  extensionsLoaded: string;
  extensionsLoading: string;
  loadFailures: string;
  noExtensionsLoaded: string;
  scopeUser: string;
  scopeProject: string;
  scopeTemporary: string;
  tools: string;
  commands: string;
  commandSourceBuiltin: string;
  commandSourceExtension: string;
  commandSourcePrompt: string;
  commandSourceSkill: string;
  noCommandsFound: string;
  flags: string;
  events: string;

  // custom models
  manageModels: string;
  manageModelsEllipsis: string;
  customModelsDescription: string;
  models: string;
  chooseModel: string;
  discoverModels: string;
  discoveringModels: string;
  noModelsFound: string;
  newModel: string;
  addProvider: string;
  addModel: string;
  removeProvider: string;
  removeModel: string;
  providerKey: string;
  apiType: string;
  baseUrl: string;
  apiKey: string;
  apiKeyHint: string;
  modelId: string;
  modelName: string;
  contextWindow: string;
  maxTokens: string;
  thinkingLevels: string;
  reasoning: string;
  imageInput: string;
  noCustomProviders: string;
  save: string;
  saving: string;
  saved: string;
  cancel: string;
  optional: string;

  // messages
  emptyPrompt: string;
  attachedImage: string;
  messageAnchors: string;
  updateAvailable: string;
  dismiss: string;
  reload: string;
  imagePlaceholder: string;
  toolRunning: string;
  askAnswerInTerminal: string;
  copyMessage: string;
  copied: string;
  reuseMessage: string;

  // auth
  login: string;
  loginFailed: string;
  loggingIn: string;
  loginHint: string;
  accessToken: string;
  accessTokenPlaceholder: string;
  twoFactorCode: string;
  logout: string;
};

export const en: Messages = {
  connected: "Connected",
  connecting: "Connecting…",
  connectingHint: "Connecting to pi…",
  loading: "Loading…",
  connectionLost: "Can't reach the server. Retrying…",
  disconnected: "Disconnected",
  settings: "Settings",
  theme: "Theme",
  themeSystem: "System",
  themeLight: "Light",
  themeDark: "Dark",
  conversationFontSize: "Conversation font ({size}px)",
  fontSizeTiny: "Tiny (12px)",
  fontSizeSmall: "Small (14px)",
  fontSizeDefault: "Default (15px)",
  fontSizeLarge: "Large (17px)",
  fontSizeTinyShort: "T",
  fontSizeSmallShort: "S",
  fontSizeDefaultShort: "D",
  fontSizeLargeShort: "L",
  language: "Language",
  browserNotifications: "Task completion notifications",

  sessions: "Sessions",
  newSession: "New session",
  resumeSession: "Resume last session",
  newSessionInProject: "New session in this project",
  renameSession: "Rename session",
  deleteSession: "Delete session",
  confirmDelete: "Confirm delete",
  sessionNamePlaceholder: "Session name…",
  emptySession: "(empty session)",
  messageCount: "{count} messages",
  noSavedSessions: "No saved sessions",
  noProject: "No project",
  sessionList: "Session list",
  pinSidebar: "Pin sidebar",
  unpinSidebar: "Unpin sidebar",
  closeSidebar: "Close sidebar",
  closeSessionTab: "Close session tab",
  workspace: "Workspace",

  files: "Files",
  openFiles: "Open files",
  closeFiles: "Close files",
  refreshTree: "Refresh",
  emptyDirectory: "Empty directory",
  treeLoadError: "Failed to load — tap to retry",
  treeTruncated: "Showing the first 1000 entries",
  inaccessible: "No access",
  mentionNoFiles: "No matching files",
  mentionPartial: "Results may be incomplete — keep typing",

  filePreviewLoading: "Loading {name}…",
  filePreviewUnsupported: "Cannot preview {name}: unsupported format",
  filePreviewMalformed: "{name} appears to be damaged or malformed",
  filePreviewTooLarge: "{name} is too large to preview",
  filePreviewForbidden: "Not allowed to open {name}",
  filePreviewMissing: "{name} not found",
  filePreviewChanged: "{name} changed while loading",
  filePreviewExpired: "{name} preview expired",
  filePreviewFailed: "Failed to load {name}",
  filePreviewRetry: "Retry",
  previewFile: "Preview {name}",
  referenceFile: "Reference {name}",
  closePreviewTab: "Close preview tab",
  refreshPreview: "Refresh preview",
  backToFiles: "Back to files",
  closePreview: "Close preview",

  git: "Git",
  gitDirty: "Changes",
  gitClean: "Clean",
  gitStaged: "staged",
  gitChanged: "changed",
  gitUntracked: "untracked",
  gitConflicted: "conflicted",
  gitStagedFiles: "Staged",
  gitChangedFiles: "Changed",
  gitUntrackedFiles: "Untracked",
  gitBranches: "Branches",
  gitRecentCommits: "Recent commits",
  gitNoChanges: "Working tree is clean.",
  gitNotRepository: "This project is not a Git repository.",
  gitOperationFailed: "Git operation failed.",
  gitConfirmDiscard: "The working tree has uncommitted changes. Switch branches anyway?",
  gitBackToLog: "Back to commits",
  backToGit: "Back to Git",
  closeCommit: "Close commit",
  gitNoDiff: "No diff available",

  sendMessage: "Send a message",
  streamingPlaceholder: "Streaming… (send to steer)",
  attachImage: "Attach image",
  removeImage: "Remove image",
  send: "Send",
  abort: "Stop",

  selectModel: "Select model",
  searchModels: "Search models…",
  clearSearch: "Clear search",
  noModelsAvailable: "No models available",
  noSearchResults: "No results",

  forkSession: "Fork session",
  forkSessionEllipsis: "Fork session…",
  forkDescription:
    "Creates a new session up to the selected message. The message text is filled back into the composer.",
  emptyMessage: "(empty message)",
  noForkPoints: "No user messages to fork from",

  activeExtensions: "Active extensions",
  activeExtensionsEllipsis: "Active extensions…",
  extensionsLoaded: "{count} extensions loaded in this session.",
  extensionsLoading: "Loading extensions for this session…",
  loadFailures: "{count} load failures",
  noExtensionsLoaded: "No extensions loaded",
  scopeUser: "User",
  scopeProject: "Project",
  scopeTemporary: "Temporary",
  tools: "Tools",
  commands: "Commands",
  commandSourceBuiltin: "Built-in",
  commandSourceExtension: "Extension",
  commandSourcePrompt: "Prompt",
  commandSourceSkill: "Skill",
  noCommandsFound: "No matching commands",
  flags: "Flags",
  events: "Events",

  manageModels: "Manage models",
  manageModelsEllipsis: "Manage models…",
  customModelsDescription: "Custom providers and models in {path}",
  models: "Models",
  chooseModel: "Choose a model",
  discoverModels: "Get models",
  discoveringModels: "Getting models…",
  noModelsFound: "No models found",
  newModel: "New model",
  addProvider: "Add provider",
  addModel: "Add model",
  removeProvider: "Remove provider",
  removeModel: "Remove model",
  providerKey: "Provider key",
  apiType: "API",
  baseUrl: "Base URL",
  apiKey: "API key",
  apiKeyHint: "Value or $ENV_VAR (local servers can use a dummy value); saved keys show only the first/last 4 chars",
  modelId: "Model ID",
  modelName: "Display name",
  contextWindow: "Context window",
  maxTokens: "Max tokens",
  thinkingLevels: "Supported thinking levels",
  reasoning: "Reasoning",
  imageInput: "Image input",
  noCustomProviders: "No custom providers yet",
  save: "Save",
  saving: "Saving…",
  saved: "Saved",
  cancel: "Cancel",
  optional: "optional",

  emptyPrompt: "How can I help?",
  messageAnchors: "Jump to message",
  updateAvailable: "A new version is available",
  reload: "Reload",
  dismiss: "Dismiss",
  attachedImage: "Attached image",
  imagePlaceholder: "[image]",
  toolRunning: "Running {name}…",
  askAnswerInTerminal: "This needs input in the pi terminal — the web UI can't answer it.",
  copyMessage: "Copy message",
  copied: "Copied",
  reuseMessage: "Reuse in composer",

  login: "Sign in",
  loginFailed: "Invalid token or 2FA code.",
  loggingIn: "Signing in…",
  loginHint: "This is a private pi agent — enter your access token to continue.",
  accessToken: "Access token",
  accessTokenPlaceholder: "Paste your access token",
  twoFactorCode: "2FA code (6 digits)",
  logout: "Sign out",
};
