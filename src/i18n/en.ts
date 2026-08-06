export type Messages = {
  // common / chrome
  connected: string;
  connecting: string;
  connectingHint: string;
  connectionLost: string;
  disconnected: string;
  settings: string;
  theme: string;
  themeSystem: string;
  themeLight: string;
  themeDark: string;
  language: string;

  // sessions
  sessions: string;
  newSession: string;
  emptySession: string;
  messageCount: string;
  noSavedSessions: string;
  noProject: string;
  sessionList: string;
  pinSidebar: string;
  unpinSidebar: string;
  closeSidebar: string;

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
  flags: string;
  events: string;

  // custom models
  manageModels: string;
  manageModelsEllipsis: string;
  customModelsDescription: string;
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
  imagePlaceholder: string;
  toolRunning: string;
};

export const en: Messages = {
  connected: "Connected",
  connecting: "Connecting…",
  connectingHint: "Connecting to pi…",
  connectionLost: "Can't reach the server. Retrying…",
  disconnected: "Disconnected",
  settings: "Settings",
  theme: "Theme",
  themeSystem: "System",
  themeLight: "Light",
  themeDark: "Dark",
  language: "Language",

  sessions: "Sessions",
  newSession: "New session",
  emptySession: "(empty session)",
  messageCount: "{count} messages",
  noSavedSessions: "No saved sessions",
  noProject: "No project",
  sessionList: "Session list",
  pinSidebar: "Pin sidebar",
  unpinSidebar: "Unpin sidebar",
  closeSidebar: "Close sidebar",

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
  flags: "Flags",
  events: "Events",

  manageModels: "Manage models",
  manageModelsEllipsis: "Manage models…",
  customModelsDescription: "Custom providers and models in {path}",
  addProvider: "Add provider",
  addModel: "Add model",
  removeProvider: "Remove provider",
  removeModel: "Remove model",
  providerKey: "Provider key",
  apiType: "API",
  baseUrl: "Base URL",
  apiKey: "API key",
  apiKeyHint: "Value or $ENV_VAR (local servers can use a dummy value)",
  modelId: "Model ID",
  modelName: "Display name",
  contextWindow: "Context window",
  maxTokens: "Max tokens",
  reasoning: "Reasoning",
  imageInput: "Image input",
  noCustomProviders: "No custom providers yet",
  save: "Save",
  saving: "Saving…",
  saved: "Saved",
  cancel: "Cancel",
  optional: "optional",

  emptyPrompt: "How can I help?",
  attachedImage: "Attached image",
  imagePlaceholder: "[image]",
  toolRunning: "Running {name}…",
};
