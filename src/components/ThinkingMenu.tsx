import { Menu } from "@base-ui-components/react/menu";
import { useEffect, useState } from "react";
import type { UIThinkingLevel } from "../../shared/protocol";
import { chatClient } from "../lib/chat";

const LEVEL_BAR_COUNT: Record<UIThinkingLevel, number> = {
  off: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
  ultra: 7,
};

function ThinkingLevelIcon({ level }: { level: UIThinkingLevel }) {
  const barCount = LEVEL_BAR_COUNT[level];
  return (
    <svg viewBox="0 0 24 24" className="size-4 shrink-0 fill-current" aria-hidden>
      {Array.from({ length: 7 }, (_, index) => {
        const height = 4 + index * 2;
        return (
          <rect
            key={index}
            x={1 + index * 3.15}
            y={20 - height}
            width="2.4"
            height={height}
            rx="1"
            className={index < barCount ? "opacity-80" : "opacity-15"}
          />
        );
      })}
      {level === "off" && (
        <path d="m4 4 16 16" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
      )}
    </svg>
  );
}

export function ThinkingMenu({
  current,
  levels,
  openToken = 0,
  disabled = false,
}: {
  current: UIThinkingLevel;
  levels: UIThinkingLevel[];
  openToken?: number;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (disabled) setOpen(false);
    else if (openToken > 0) setOpen(true);
  }, [disabled, openToken]);

  // Keep the compact toolbar hidden when there is nothing to choose, but let
  // an explicit /reasoning command open the one advertised fallback level.
  if (levels.length <= 1 && !open) return null;

  return (
    <Menu.Root open={disabled ? false : open} onOpenChange={setOpen}>
      <Menu.Trigger
        disabled={disabled}
        className="max-w-[40vw] truncate rounded-lg px-2.5 py-1.5 text-[13px] text-muted transition-colors hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 sm:max-w-xs"
        title="Thinking level"
      >
        <span className="truncate">{current}</span>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={6} align="end">
          <Menu.Popup className="w-36 rounded-xl border border-line bg-card py-1 shadow-xl outline-none">
            {levels.map((level) => (
              <Menu.Item
                key={level}
                onClick={() => chatClient.send({ type: "set_thinking_level", level })}
                className={`flex cursor-pointer items-center gap-2 px-3 py-2 text-sm outline-none data-[highlighted]:bg-hover ${
                  level === current ? "font-medium text-accent" : "text-ink"
                }`}
              >
                <ThinkingLevelIcon level={level} />
                <span>{level}</span>
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
