import { Menu } from "@base-ui-components/react/menu";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { getAgentPreference } from "../lib/agent";
import { chatClient } from "../lib/chat";
import { useT } from "../lib/i18n";
import { markFreshDraftRequested } from "../lib/resume";
import { FolderTreeIcon, NewSessionIcon } from "./MorphIcons";
import { projectLabel } from "./ProjectBadge";

interface NewSessionButtonProps {
  cwd?: string;
  className?: string;
}

export function NewSessionButton({ cwd, className }: NewSessionButtonProps) {
  const t = useT();
  const navigate = useNavigate();
  const [burstToken, setBurstToken] = useState(0);
  const [open, setOpen] = useState(false);

  const hasProject = Boolean(cwd && (cwd.startsWith("~") || cwd.startsWith("/")));
  const projectName = hasProject ? projectLabel(cwd) : null;

  const startSession = (inProject: boolean) => {
    setBurstToken((prev) => prev + 1);
    markFreshDraftRequested();
    chatClient.connect(null, {
      force: true,
      cwd: inProject && cwd ? cwd : undefined,
      agent: getAgentPreference() ?? undefined,
    });
    void navigate({ to: "/" });
    chatClient.requestComposerFocus();
    setOpen(false);
  };

  const triggerClass =
    className ??
    "flex size-9 shrink-0 items-center justify-center rounded-lg text-faint transition-colors hover:bg-hover hover:text-ink";

  if (!hasProject) {
    return (
      <button
        type="button"
        onClick={() => startSession(false)}
        aria-label={t("newSession")}
        title={t("newSession")}
        className={triggerClass}
      >
        <NewSessionIcon size={19} burstToken={burstToken} />
      </button>
    );
  }

  return (
    <Menu.Root open={open} onOpenChange={setOpen}>
      <Menu.Trigger
        type="button"
        aria-label={t("newSession")}
        title={t("newSession")}
        className={triggerClass}
      >
        <NewSessionIcon size={19} burstToken={burstToken} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={6}>
          <Menu.Popup className="flex min-w-56 flex-col overflow-hidden rounded-xl border border-line bg-card p-1 shadow-xl dark:border-white/[0.08] dark:shadow-2xl outline-none">
            <Menu.Item
              onClick={() => startSession(true)}
              className="flex cursor-pointer items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-xs font-medium text-ink outline-none transition-colors data-[highlighted]:bg-hover"
            >
              <div className="flex min-w-0 items-center gap-2">
                <FolderTreeIcon size={14} className="shrink-0 text-muted" />
                <span className="truncate">{t("newSessionInProject")}</span>
              </div>
              {projectName && (
                <span className="max-w-[7rem] shrink-0 truncate rounded bg-bubble px-1.5 py-0.5 font-mono text-[10px] text-muted">
                  {projectName}
                </span>
              )}
            </Menu.Item>
            <Menu.Item
              onClick={() => startSession(false)}
              className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-muted outline-none transition-colors data-[highlighted]:bg-hover data-[highlighted]:text-ink"
            >
              <NewSessionIcon size={14} className="shrink-0 text-muted" />
              <span className="truncate">{t("newSessionDefault")}</span>
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
