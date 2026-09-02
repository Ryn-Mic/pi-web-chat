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
  newSessionAgent: string;
  agentAppliesToNewSessions: string;
  agentPi: string;
  agentCodex: string;
  grokbotTheme: string;
  grokbotThemeClassic: string;
  grokbotThemeCyberpunk: string;
  grokbotThemeMatrix: string;
  grokbotThemeAmber: string;
  grokbotThemeSakura: string;
  piPersona: string;
  codexPersona: string;
  personaPlayful: string;
  personaAnalytic: string;
  personaZen: string;
  personaCyber: string;
  grokbotPreview: string;

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
  loadEarlierMessages: string;
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
  codexSteerPlaceholder: string;

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
  codexForkDescription: string;
  codexForkAction: string;
  codexForkUnavailable: string;
  codexForkNoThread: string;
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
  commandSourceCodex: string;
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
  serverRestartRequired: string;
  serverRestartRequiredHint: string;
  dismiss: string;
  reload: string;
  imagePlaceholder: string;
  toolRunning: string;
  askAnswerInTerminal: string;
  copyMessage: string;
  copied: string;
  reuseMessage: string;

  // Codex remote control
  codexApprovalTitle: string;
  codexApprovalQueue: string;
  codexCommandRequest: string;
  codexFileRequest: string;
  codexPermissionsRequest: string;
  codexInputRequest: string;
  codexMcpRequest: string;
  codexReason: string;
  codexRequestDetails: string;
  codexWorkingDirectory: string;
  codexChanges: string;
  codexPermissions: string;
  codexAcceptOnce: string;
  codexAcceptSession: string;
  codexDecline: string;
  codexCancelTurn: string;
  codexSubmit: string;
  codexSelectOptions: string;
  codexOtherAnswer: string;
  codexOpenAuthorization: string;
  codexAuthorizationDone: string;
  codexMcpFormData: string;
  codexInvalidForm: string;
  codexInteractionSendFailed: string;
  codexRequired: string;
  codexTransportShared: string;
  codexTransportStandalone: string;
  codexTransportConnecting: string;
  codexTransportUnavailable: string;
  codexSharedHint: string;
  codexStandaloneHint: string;
  codexRemoteConnected: string;
  codexObserverTitle: string;
  codexObserverHint: string;

  // new UI enhancements
  searchSessions: string;
  noMatchingSessions: string;
  searchFiles: string;
  noMatchingFiles: string;
  scrollToBottom: string;
  generatingResponse: string;
  dropFilesHere: string;
  contextDetails: string;
  contextUsed: string;
  contextWindowSize: string;
  starterTitleExplore: string;
  starterExploreCodebase: string;
  starterTitleGit: string;
  starterReviewGit: string;
  starterTitleTests: string;
  starterWriteTests: string;
  starterTitlePerf: string;
  starterOptimizePerf: string;

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
  newSessionAgent: "Agent for new sessions",
  agentAppliesToNewSessions: "new sessions only",
  agentPi: "pi",
  agentCodex: "Codex",
  grokbotTheme: "GrokBot Theme",
  grokbotThemeClassic: "Classic Azure",
  grokbotThemeCyberpunk: "Cyber Neon",
  grokbotThemeMatrix: "Matrix Green",
  grokbotThemeAmber: "Sunset Amber",
  grokbotThemeSakura: "Sakura Pink",
  piPersona: "Pi Expression Personality",
  codexPersona: "Codex Expression Personality",
  personaPlayful: "Playful & Curious",
  personaAnalytic: "Analytic & Sharp",
  personaZen: "Calm & Zen",
  personaCyber: "Cyber Hacker",
  grokbotPreview: "Live Preview",

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
  loadEarlierMessages: "Load earlier messages",
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
  codexSteerPlaceholder: "Guide Codex while it works…",

  selectModel: "Select model",
  searchModels: "Search models…",
  clearSearch: "Clear search",
  noModelsAvailable: "No models available",
  noSearchResults: "No results",

  forkSession: "Fork session",
  forkSessionEllipsis: "Fork session…",
  forkDescription:
    "Creates a new session up to the selected message. The message text is filled back into the composer.",
  codexForkDescription:
    "Creates a new native Codex thread from the current conversation and moves this tab to it. The original thread stays saved.",
  codexForkAction: "Fork current thread",
  codexForkUnavailable: "Stop the active task and resolve pending requests before forking.",
  codexForkNoThread: "Send a message first to create a Codex thread.",
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
  commandSourceCodex: "Codex",
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
  serverRestartRequired: "Web Chat server restart required",
  serverRestartRequiredHint:
    "The v{clientVersion} web assets are loaded, but the running server is still v{serverVersion}. Check its local port, then restart the managed server with that explicit port.",
  reload: "Reload",
  dismiss: "Dismiss",
  attachedImage: "Attached image",
  imagePlaceholder: "[image]",
  toolRunning: "Running {name}…",
  askAnswerInTerminal: "This needs input in the pi terminal — the web UI can't answer it.",
  copyMessage: "Copy message",
  copied: "Copied",
  reuseMessage: "Reuse in composer",

  codexApprovalTitle: "Codex is waiting for your decision. Nothing is approved automatically.",
  codexApprovalQueue: "{count} waiting",
  codexCommandRequest: "Run this command?",
  codexFileRequest: "Apply these file changes?",
  codexPermissionsRequest: "Grant additional permissions?",
  codexInputRequest: "Codex needs your input",
  codexMcpRequest: "Connected tool needs your input",
  codexReason: "Reason",
  codexRequestDetails: "Request details",
  codexWorkingDirectory: "Working directory",
  codexChanges: "Requested changes",
  codexPermissions: "Requested permissions",
  codexAcceptOnce: "Allow once",
  codexAcceptSession: "Allow for session",
  codexDecline: "Decline",
  codexCancelTurn: "Cancel task",
  codexSubmit: "Send answer",
  codexSelectOptions: "Select one option.",
  codexOtherAnswer: "Type another answer…",
  codexOpenAuthorization: "Open authorization page",
  codexAuthorizationDone: "I've finished",
  codexMcpFormData: "Form response as JSON",
  codexInvalidForm: "Enter valid JSON before sending.",
  codexInteractionSendFailed: "Reconnecting. Your decision was not sent.",
  codexRequired: "Complete all required fields.",
  codexTransportShared: "Shared daemon",
  codexTransportStandalone: "Standalone · isolated",
  codexTransportConnecting: "Connecting",
  codexTransportUnavailable: "Unavailable",
  codexSharedHint: "Connected to the shared Codex app-server daemon.",
  codexStandaloneHint: "Isolated process — it does not share the running Codex daemon.",
  codexRemoteConnected: "Remote",
  codexObserverTitle: "Read-only",
  codexObserverHint: "Another client is running this session; you can watch it and regain control automatically when it finishes.",

  // new UI enhancements
  searchSessions: "Search sessions…",
  noMatchingSessions: "No matching sessions",
  searchFiles: "Search files…",
  noMatchingFiles: "No matching files",
  scrollToBottom: "Scroll to bottom",
  generatingResponse: "Generating…",
  dropFilesHere: "Drop images or files here",
  contextDetails: "Context usage",
  contextUsed: "Used",
  contextWindowSize: "Context window",
  starterTitleExplore: "Explore Codebase",
  starterExploreCodebase: "Analyze repository architecture and key module structure",
  starterTitleGit: "Review Git Changes",
  starterReviewGit: "Check recent git changes, uncommitted diffs, and branch status",
  starterTitleTests: "Write Unit Tests",
  starterWriteTests: "Write comprehensive unit tests with edge cases for recent code",
  starterTitlePerf: "Optimize Performance",
  starterOptimizePerf: "Identify potential performance bottlenecks and memory leaks",

  login: "Sign in",
  loginFailed: "Invalid token or 2FA code.",
  loggingIn: "Signing in…",
  loginHint: "This is a private pi agent — enter your access token to continue.",
  accessToken: "Access token",
  accessTokenPlaceholder: "Paste your access token",
  twoFactorCode: "2FA code (6 digits)",
  logout: "Sign out",
};
