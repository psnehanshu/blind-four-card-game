import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Stop scaling here; switch to vertical scroll instead. Default 0.75
   *  keeps a 44px tap target above ~33px. */
  minScale?: number;
  /** Vertical budget as a fraction of viewport height. Default 0.88 leaves
   *  room for the dialog frame's own padding/shadow. */
  maxVh?: number;
}

/**
 * Wraps content (typically inside a Dialog) and shrinks it via CSS transform
 * to fit `maxVh × innerHeight`. If shrinking would push tap targets below
 * `minScale`, falls back to vertical scroll instead.
 *
 * The outer box is opaque to layout — it reserves the post-scale height so
 * surrounding flow isn't distorted by the transform.
 */
export function ScalableContent({ children, minScale = 0.75, maxVh = 0.88 }: Props) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [scroll, setScroll] = useState(false);
  const [outerHeight, setOuterHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const measure = (): void => {
      const contentH = el.scrollHeight;
      const budget = window.innerHeight * maxVh;
      if (contentH <= budget) {
        setScale(1);
        setScroll(false);
        setOuterHeight(contentH);
        return;
      }
      const ratio = budget / contentH;
      if (ratio >= minScale) {
        setScale(ratio);
        setScroll(false);
        setOuterHeight(contentH * ratio);
      } else {
        setScale(minScale);
        setScroll(true);
        setOuterHeight(budget);
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [maxVh, minScale]);

  return (
    <div
      style={{
        maxHeight: `${maxVh * 100}dvh`,
        height: outerHeight !== null ? `${outerHeight}px` : undefined,
        overflowY: scroll ? "auto" : "visible",
        overflowX: "hidden",
      }}
    >
      <div
        ref={innerRef}
        style={{
          transform: `scale(${scale})`,
          transformOrigin: "top center",
        }}
      >
        {children}
      </div>
    </div>
  );
}
