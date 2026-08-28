import { useEffect, useMemo, useRef, useState } from "react";
import {
  GROK_BODY,
  GROK_EYES,
  GROK_EYE_STATES,
  type GrokEyeState,
} from "../lib/grok-eyes";
import {
  GROK_PERSONA_SPECS,
  useCodexPersona,
  usePiPersona,
  type GrokPersona,
} from "../lib/grok-theme";

function randInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function pickExpr(pool: readonly number[], cur?: number): number {
  const others = pool.filter((i) => i !== cur);
  return others.length ? others[Math.floor(Math.random() * others.length)] : pool[0];
}

/**
 * Morphing agent bot based on the LaoA GrokBot expressions
 * (https://github.com/zhulin025/LaoA-GrokBot, MIT). The body silhouette sits
 * behind the eyes; every expression shares the same 48-point path structure so
 * the eyes smoothly morph between states via CSS `d` transitions, blink on the
 * state's cadence, and occasionally hop/tilt/scan/pulse like the original bot.
 */
export function AgentEyes({
  state = "idle",
  size = 16,
  className = "",
  animated = true,
  title,
  burst,
  agent,
  persona: explicitPersona,
}: {
  state?: GrokEyeState;
  size?: number;
  className?: string;
  /** Run cadence-driven expression morphing, blinking and motions (false = static pose). */
  animated?: boolean;
  title?: string;
  /** Fire a one-shot motion when `token` increments (e.g. a button press). */
  burst?: { token: number; kind?: string };
  /** Agent flavor ("pi" vs "codex") for persona personality derivation */
  agent?: "pi" | "codex";
  /** Explicit persona override */
  persona?: GrokPersona;
}) {
  const piPersona = usePiPersona();
  const codexPersona = useCodexPersona();

  const activePersona: GrokPersona = useMemo(() => {
    if (explicitPersona) return explicitPersona;
    if (agent === "codex") return codexPersona;
    if (agent === "pi") return piPersona;
    return "playful";
  }, [explicitPersona, agent, codexPersona, piPersona]);

  const personaSpec = GROK_PERSONA_SPECS[activePersona]?.[state];
  const spec = personaSpec ?? GROK_EYE_STATES[state];
  const [expr, setExpr] = useState(() => spec.pool[0]);
  const [blinking, setBlinking] = useState(false);
  const [motion, setMotion] = useState<string | null>(null);
  const morphTimer = useRef<number>(0);
  const blinkTimer = useRef<number>(0);
  const blinkResetTimer = useRef<number>(0);
  const motionTimer = useRef<number>(0);
  const motionResetTimer = useRef<number>(0);
  const burstResetTimer = useRef<number>(0);
  const specRef = useRef(spec);
  specRef.current = spec;
  const burstRef = useRef<number>(0);

  // On state change hop to a fresh expression from the pool.
  useEffect(() => {
    setExpr((cur) => pickExpr(spec.pool, cur));
  }, [spec.pool]);

  // One-shot motion triggered by a changing `burst.token` (button presses).
  useEffect(() => {
    if (!burst || burst.token === burstRef.current) return;
    burstRef.current = burst.token;
    const kind = burst.kind ?? specRef.current.motion ?? "pulse";
    setMotion(kind);
    window.clearTimeout(burstResetTimer.current);
    burstResetTimer.current = window.setTimeout(() => setMotion(null), 950);
  }, [burst?.kind, burst?.token]);

  // Cadence-driven morphing + blinking + occasional motions (skipped for
  // reduced motion).
  useEffect(() => {
    setBlinking(false);
    setMotion(null);
    if (!animated) return;
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    const [mMin, mMax] = spec.morphEveryMs ?? [0, 0];
    const [bMin, bMax] = spec.blink ?? [0, 0];

    const fireMotion = (): void => {
      const kind = specRef.current.motion ?? "pulse";
      setMotion(kind);
      window.clearTimeout(motionResetTimer.current);
      motionResetTimer.current = window.setTimeout(() => setMotion(null), 950);
    };

    const scheduleMorph = () => {
      morphTimer.current = window.setTimeout(() => {
        setExpr((cur) => pickExpr(spec.pool, cur));
        scheduleMorph();
      }, randInt(mMin, mMax));
    };
    const scheduleBlink = () => {
      blinkTimer.current = window.setTimeout(() => {
        setBlinking(true);
        window.clearTimeout(blinkResetTimer.current);
        blinkResetTimer.current = window.setTimeout(() => setBlinking(false), 240);
        scheduleBlink();
      }, randInt(bMin, bMax));
    };
    // An occasional hop/tilt/scan keeps the bot alive without being noisy.
    const scheduleMotion = () => {
      motionTimer.current = window.setTimeout(() => {
        fireMotion();
        scheduleMotion();
      }, randInt(4_500, 9_000));
    };

    if (mMin > 0) scheduleMorph();
    if (bMin > 0) scheduleBlink();
    scheduleMotion();
    return () => {
      window.clearTimeout(morphTimer.current);
      window.clearTimeout(blinkTimer.current);
      window.clearTimeout(blinkResetTimer.current);
      window.clearTimeout(motionTimer.current);
      window.clearTimeout(motionResetTimer.current);
    };
  }, [animated, spec]);

  useEffect(
    () => () => {
      window.clearTimeout(morphTimer.current);
      window.clearTimeout(blinkTimer.current);
      window.clearTimeout(blinkResetTimer.current);
      window.clearTimeout(motionTimer.current);
      window.clearTimeout(motionResetTimer.current);
      window.clearTimeout(burstResetTimer.current);
    },
    [],
  );

  const motionClass = motion ? ` agent-eyes--motion-${motion}` : "";
  const [left, right] = GROK_EYES[expr];
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={`agent-eyes shrink-0 ${blinking ? "agent-eyes--blink" : ""}${motionClass} ${className}`}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <path d={GROK_BODY} className="agent-eyes__body" aria-hidden />
      <path d={left} className="agent-eyes__path" />
      <path d={right} className="agent-eyes__path" />
    </svg>
  );
}
