import { useLayoutEffect, useRef, type RefObject } from "react";
import { animateScene } from "./motion.js";

/** Navigation keys only. Streaming, preference changes and rerenders never replay it. */
export function useSceneMotion(ref: RefObject<HTMLElement | null>, key: string | boolean, active: boolean, direction = 1, selector?: string): void {
  const previous = useRef({ key, active });
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = { key, active };
    if (!active || !before.active || before.key === key) return;
    const root = ref.current;
    return animateScene(selector ? root?.querySelector<HTMLElement>(selector) ?? null : root, direction);
  }, [ref, key, active, direction, selector]);
}
