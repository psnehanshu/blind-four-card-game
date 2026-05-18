import { useEffect, useRef, type ReactNode } from "react";

interface Props {
  open: boolean;
  children: ReactNode;
  /** If true, Escape and backdrop-click close the dialog. Default: false (must resolve via button). */
  dismissable?: boolean;
}

/**
 * Thin wrapper around the native HTML <dialog> element. Driven imperatively
 * via showModal()/close() in an effect so callers can use plain boolean props.
 * Non-dismissable by default — players must explicitly resolve the action
 * (e.g., USE_POWER) rather than escaping out of it.
 */
export function Dialog({ open, children, dismissable = false }: Props) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="app-dialog"
      onCancel={(e) => {
        if (!dismissable) e.preventDefault();
      }}
    >
      {children}
    </dialog>
  );
}
