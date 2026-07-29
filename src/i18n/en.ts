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

  emptyPrompt: "How can I help?",
  attachedImage: "Attached image",
  imagePlaceholder: "[image]",
  toolRunning: "Running {name}…",
};
