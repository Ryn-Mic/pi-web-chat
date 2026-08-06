import { Menu } from "@base-ui-components/react/menu";
import { useState } from "react";
import { logout } from "../lib/auth";
import { isLocale, LOCALES, setLocale, useLocale, useT } from "../lib/i18n";
import { setResumeEnabled, useResumeEnabled } from "../lib/resume";
import {
  setThemePreference,
  useThemePreference,
  type ThemePreference,
} from "../lib/theme";
import { ExtensionsDialog } from "./ExtensionsDialog";
import { ForkDialog } from "./ForkDialog";
import { ModelsDialog } from "./ModelsDialog";

const itemClass =
  "flex cursor-pointer items-center gap-2 px-3 py-2 text-sm text-ink outline-none data-[highlighted]:bg-hover";

export function SettingsMenu() {
  const t = useT();
  const preference = useThemePreference();
  const locale = useLocale();
  const resumeEnabled = useResumeEnabled();
  const [forkOpen, setForkOpen] = useState(false);
  const [extensionsOpen, setExtensionsOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);

  const themeOptions: { value: ThemePreference; label: string }[] = [
    { value: "system", label: t("themeSystem") },
    { value: "light", label: t("themeLight") },
    { value: "dark", label: t("themeDark") },
  ];

  return (
    <>
      <Menu.Root>
        <Menu.Trigger
          className="flex size-9 items-center justify-center rounded-lg text-faint transition-colors hover:bg-hover hover:text-ink"
          aria-label={t("settings")}
          title={t("settings")}
        >
          <svg viewBox="0 0 24 24" className="size-5 fill-none stroke-current stroke-2">
            <circle cx="12" cy="12" r="3" />
            <path
              d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9c.3.6.9 1.1 1.5 1.1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner sideOffset={6} align="end">
            <Menu.Popup className="w-52 rounded-xl border border-line bg-card py-1 shadow-xl outline-none">
              <Menu.Group>
                <Menu.GroupLabel className="px-3 pt-2 pb-1 text-[11px] font-medium tracking-wide text-faint uppercase">
                  {t("theme")}
                </Menu.GroupLabel>
                <Menu.RadioGroup
                  value={preference}
                  onValueChange={(value) => {
                    if (value === "system" || value === "light" || value === "dark") {
                      setThemePreference(value);
                    }
                  }}
                >
                  {themeOptions.map((opt) => (
                    <Menu.RadioItem
                      key={opt.value}
                      value={opt.value}
                      closeOnClick
                      className={itemClass}
                    >
                      <span className="flex size-3.5 items-center justify-center rounded-full border border-faint">
                        <Menu.RadioItemIndicator className="size-1.5 rounded-full bg-accent" />
                      </span>
                      <span className={preference === opt.value ? "font-medium text-accent" : undefined}>
                        {opt.label}
                      </span>
                    </Menu.RadioItem>
                  ))}
                </Menu.RadioGroup>
              </Menu.Group>

              <div className="my-1 border-t border-line" />

              <Menu.Group>
                <Menu.GroupLabel className="px-3 pt-2 pb-1 text-[11px] font-medium tracking-wide text-faint uppercase">
                  {t("language")}
                </Menu.GroupLabel>
                <Menu.RadioGroup
                  value={locale}
                  onValueChange={(value) => {
                    if (isLocale(value)) setLocale(value);
                  }}
                >
                  {LOCALES.map((opt) => (
                    <Menu.RadioItem
                      key={opt.value}
                      value={opt.value}
                      closeOnClick
                      className={itemClass}
                    >
                      <span className="flex size-3.5 items-center justify-center rounded-full border border-faint">
                        <Menu.RadioItemIndicator className="size-1.5 rounded-full bg-accent" />
                      </span>
                      <span className={locale === opt.value ? "font-medium text-accent" : undefined}>
                        {opt.nativeLabel}
                      </span>
                    </Menu.RadioItem>
                  ))}
                </Menu.RadioGroup>
              </Menu.Group>

              <div className="my-1 border-t border-line" />

              <Menu.Item
                className={itemClass}
                onClick={() => setResumeEnabled(!resumeEnabled)}
              >
                <span className="flex size-4 shrink-0 items-center justify-center">
                  {resumeEnabled && (
                    <svg viewBox="0 0 24 24" className="size-3.5 fill-none stroke-current stroke-2">
                      <path d="m5 12 4 4L19 6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </span>
                {t("resumeSession")}
              </Menu.Item>

              <div className="my-1 border-t border-line" />
              <Menu.Item className={itemClass} onClick={() => setModelsOpen(true)}>
                <svg viewBox="0 0 24 24" className="size-4 fill-none stroke-current stroke-2">
                  <path
                    d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Zm0 0v9m0 0 8-4.5M12 12l-8-4.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                {t("manageModelsEllipsis")}
              </Menu.Item>

              <Menu.Item className={itemClass} onClick={() => setForkOpen(true)}>
                <svg viewBox="0 0 24 24" className="size-4 fill-none stroke-current stroke-2">
                  <circle cx="6" cy="5" r="2" />
                  <circle cx="18" cy="5" r="2" />
                  <circle cx="12" cy="19" r="2" />
                  <path
                    d="M6 7v1.3a4 4 0 0 0 4 4h4a4 4 0 0 0 4-4V7M12 12.3v4.5"
                    strokeLinecap="round"
                  />
                </svg>
                {t("forkSessionEllipsis")}
              </Menu.Item>

              <Menu.Item className={itemClass} onClick={() => setExtensionsOpen(true)}>
                <svg viewBox="0 0 24 24" className="size-4 fill-none stroke-current stroke-2">
                  <path
                    d="M20 7h-3a2 2 0 1 0-4 0H4a2 2 0 0 0-2 2v3a2 2 0 1 1 0 4v3a2 2 0 0 0 2 2h3a2 2 0 1 1 4 0h9a2 2 0 0 0 2-2v-3a2 2 0 1 0 0-4V9a2 2 0 0 0-2-2Z"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                {t("activeExtensionsEllipsis")}
              </Menu.Item>

              <div className="my-1 border-t border-line" />
              <Menu.Item className={itemClass} onClick={() => void logout()}>
                <svg viewBox="0 0 24 24" className="size-4 fill-none stroke-current stroke-2">
                  <path
                    d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                {t("logout")}
              </Menu.Item>
              <div className="my-1 border-t border-line" />
              <div className="px-3 pt-1 pb-2 text-[11px] text-faint">
                pi-web-chat v{__APP_VERSION__}
              </div>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>

      <ModelsDialog open={modelsOpen} onOpenChange={setModelsOpen} />
      <ForkDialog open={forkOpen} onOpenChange={setForkOpen} />
      <ExtensionsDialog open={extensionsOpen} onOpenChange={setExtensionsOpen} />
    </>
  );
}
