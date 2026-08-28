/**
 * Small, single-viewBox (24x24) stroke paths used by Morphicons.
 * Keeping the data local avoids pulling a second icon component package into the web bundle.
 */
export const MORPH_ICON_PATHS = {
  // Remote composer actions
  send: "M12 19V5M5 12l7-7 7 7",
  pending: "M21 12a9 9 0 1 1-2.64-6.36",
  stop: "M6 6h12v12H6Z",

  // Settings & dialogs
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9c.3.6.9 1.1 1.5 1.1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z",
  close: "M18 6 6 18M6 6l12 12",

  // Sidebar / drawer
  panelLeft: "M3 3h18a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM9 3v18",
  panelLeftClose:
    "M3 3h18a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM9 3v18M15 9l-3 3 3 3",

  // File tree & folder expansion
  folderClosed:
    "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",
  folderOpen:
    "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z M2 10h20",
  chevronRight: "M9 6l6 6-6 6",
  chevronDown: "M6 9l6 6 6-6",

  // New session & action triggers
  plus: "M12 5v14M5 12h14",
  sparkle: "M12 3v3m0 12v3M3 12h3m12 0h3M6.34 6.34l2.12 2.12m7.08 7.08 2.12 2.12M6.34 17.66l2.12-2.12m7.08-7.08 2.12-2.12",

  // Refresh & reload
  refresh: "M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6",

  // Copy & feedback
  copy: "M8 17.929H6c-1.105 0-2-.912-2-2.036V5.036C4 3.91 4.895 3 6 3h8c1.105 0 2 .911 2 2.036v1.866m-6 .17h8c1.105 0 2 .91 2 2.035v10.857C20 21.09 19.105 22 18 22h-8c-1.105 0-2-.911-2-2.036V9.107c0-1.124.895-2.036 2-2.036Z",
  check: "M20 6 9 17l-5-5",
} as const;

export type MorphActionMode = keyof typeof MORPH_ICON_PATHS;
