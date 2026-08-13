import type { ViewerOptions } from "@file-viewer/core/browser";
import type { Locale } from "./i18n";
import type { Theme } from "./theme";

const FILE_VIEWER_LOCALES: Record<Locale, ViewerOptions["locale"]> = {
  en: "en-US",
  ja: "ja-JP",
  zh: "zh-CN",
  ko: "en-US",
};

export function createFileViewerOptions({
  mobile,
  theme,
  locale,
}: {
  mobile: boolean;
  theme: Theme;
  locale: Locale;
}): ViewerOptions {
  return {
    theme,
    locale: FILE_VIEWER_LOCALES[locale] ?? "en-US",
    styleIsolation: "shadow",
    ui: mobile ? { density: "compact" } : undefined,
    toolbar: {
      position: "bottom-right",
      download: false,
      print: false,
      exportHtml: false,
      zoom: true,
      permissions: {
        download: false,
        print: false,
        "export-html": false,
      },
    },
    archive: { entryActions: { download: false } },
  };
}
