import { Menu } from "@base-ui-components/react/menu";
import { useEffect, useState } from "react";
import { logout } from "../lib/auth";
import {
  setBrowserNotificationsEnabled,
  useBrowserNotifications,
} from "../lib/browserNotifications";
import {
  chatFontSizePixels,
  setChatFontSize,
  useChatFontSize,
  type ChatFontSize,
} from "../lib/chatFontSize";
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
  "flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs text-ink outline-none data-[highlighted]:bg-hover";

type SegmentOption = { value: string; label: string };

function PreferenceRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-1.5">
      <span className="min-w-0 shrink text-xs font-medium text-muted">{label}</span>
      {children}
    </div>
  );
}

function SegmentedControl({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: SegmentOption[];
  onChange: (value: string) => void;
}) {
  if (options.length > 4) {
    return (
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="min-w-32 rounded-md border border-line bg-canvas px-2 py-1 text-[11px] text-ink outline-none focus:border-faint"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    );
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex min-w-0 rounded-md border border-line bg-canvas p-0.5"
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className={`min-w-0 flex-1 rounded-[3px] px-1.5 py-1 text-[11px] leading-none transition-all sm:px-2 ${
              active
                ? "bg-card font-medium text-ink shadow-sm"
                : "text-faint hover:bg-hover hover:text-muted"
            }`}
          >
            <span className="block truncate">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      onClick={onChange}
      className={`relative flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors ${
        checked ? "border-accent bg-accent" : "border-line bg-canvas"
      }`}
    >
      <span
        className={`size-3.5 rounded-full bg-card shadow-sm transition-transform ${
          checked ? "translate-x-[17px]" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

export function SettingsMenu({ openToken = 0 }: { openToken?: number }) {
  const t = useT();
  const preference = useThemePreference();
  const locale = useLocale();
  const resumeEnabled = useResumeEnabled();
  const browserNotifications = useBrowserNotifications();
  const chatFontSize = useChatFontSize();
  const [open, setOpen] = useState(false);
  const [forkOpen, setForkOpen] = useState(false);
  const [extensionsOpen, setExtensionsOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);

  useEffect(() => {
    if (openToken > 0) setOpen(true);
  }, [openToken]);

  const themeOptions: SegmentOption[] = [
    { value: "system", label: t("themeSystem") },
    { value: "light", label: t("themeLight") },
    { value: "dark", label: t("themeDark") },
  ];
  const fontSizeOptions: SegmentOption[] = [
    { value: "tiny", label: t("fontSizeTiny") },
    { value: "small", label: t("fontSizeSmall") },
    { value: "default", label: t("fontSizeDefault") },
    { value: "large", label: t("fontSizeLarge") },
  ];

  return (
    <>
      <Menu.Root open={open} onOpenChange={setOpen}>
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
            <Menu.Popup className="w-[min(94vw,37rem)] rounded-xl border border-line bg-card py-1 shadow-xl outline-none">
              <PreferenceRow label={t("theme")}>
                <SegmentedControl
                  label={t("theme")}
                  value={preference}
                  options={themeOptions}
                  onChange={(value) => {
                    if (value === "system" || value === "light" || value === "dark") {
                      setThemePreference(value as ThemePreference);
                    }
                  }}
                />
              </PreferenceRow>
              <PreferenceRow label={t("conversationFontSize", { size: chatFontSizePixels(chatFontSize) })}>
                <SegmentedControl
                  label={t("conversationFontSize", { size: chatFontSizePixels(chatFontSize) })}
                  value={chatFontSize}
                  options={fontSizeOptions}
                  onChange={(value) => {
                    if (value === "tiny" || value === "small" || value === "default" || value === "large") {
                      setChatFontSize(value as ChatFontSize);
                    }
                  }}
                />
              </PreferenceRow>
              <PreferenceRow label={t("language")}>
                <SegmentedControl
                  label={t("language")}
                  value={locale}
                  options={LOCALES.map((option) => ({ value: option.value, label: option.nativeLabel }))}
                  onChange={(value) => {
                    if (isLocale(value)) setLocale(value);
                  }}
                />
              </PreferenceRow>
              <PreferenceRow label={t("resumeSession")}>
                <Toggle
                  label={t("resumeSession")}
                  checked={resumeEnabled}
                  onChange={() => setResumeEnabled(!resumeEnabled)}
                />
              </PreferenceRow>
              <PreferenceRow label={t("browserNotifications")}>
                <Toggle
                  label={t("browserNotifications")}
                  checked={browserNotifications}
                  onChange={() => void setBrowserNotificationsEnabled(!browserNotifications)}
                />
              </PreferenceRow>

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
                  <path d="M6 7v1.3a4 4 0 0 0 4 4h4a4 4 0 0 0 4-4V7M12 12.3v4.5" strokeLinecap="round" />
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
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {t("logout")}
              </Menu.Item>
              <div className="my-1 border-t border-line" />
              <div className="px-3 pt-1 pb-2 text-[10px] text-faint">pi-web-chat v{__APP_VERSION__}</div>
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
