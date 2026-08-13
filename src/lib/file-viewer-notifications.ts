export type FileViewerNotificationEvent =
  | { type: "ready" }
  | { type: "error"; error: unknown }
  | null;

export function createFileViewerNotificationGate(): (
  source: File,
  state: { ready: boolean; error: unknown | null },
) => FileViewerNotificationEvent {
  let lastSource: File | null = null;
  let readyNotified = false;
  let errorNotified: unknown | null = null;

  return (source, state) => {
    if (lastSource !== source) {
      lastSource = source;
      readyNotified = false;
      errorNotified = null;
    }

    if (state.error) {
      readyNotified = false;
      if (errorNotified !== state.error) {
        errorNotified = state.error;
        return { type: "error", error: state.error };
      }
      return null;
    }

    errorNotified = null;

    if (state.ready) {
      if (!readyNotified) {
        readyNotified = true;
        return { type: "ready" };
      }
      return null;
    }

    readyNotified = false;
    return null;
  };
}
