"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui";

const noop = () => () => {};

/** Modal dialog: focus moves in and is trapped, Escape cancels, focus returns to the opener. */
export function Dialog({
  open,
  title,
  description,
  children,
  onClose,
  role = "dialog",
  variant = "dialog",
  hideTitle,
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  onClose: () => void;
  role?: "dialog" | "alertdialog";
  /** drawer: full-height panel from the left (mobile navigation). */
  variant?: "dialog" | "drawer";
  hideTitle?: boolean;
}) {
  const mounted = useSyncExternalStore(noop, () => true, () => false);
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const node = panel.current;
    const focusables = () => Array.from(node?.querySelectorAll<HTMLElement>("input, button:not([disabled]), textarea, select, [href]") ?? []);
    (node?.querySelector<HTMLElement>("[data-autofocus]") ?? focusables()[0])?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
      if (e.key !== "Tab") return;
      const f = focusables();
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, [open, onClose]);

  if (!open || !mounted) return null;
  if (variant === "drawer") {
    return createPortal(
      <div className="no-print fixed inset-0 z-50 flex bg-black/55" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div
          ref={panel}
          role={role}
          aria-modal="true"
          aria-labelledby={titleId}
          className="animate-drawer flex h-full w-[min(340px,88vw)] flex-col border-r border-line-strong bg-surface shadow-[12px_0_40px_rgba(0,0,0,0.45)]"
        >
          <h2 id={titleId} className={hideTitle ? "sr-only" : "px-4 pt-4 text-[15px] font-semibold tracking-tight text-ink"}>
            {title}
          </h2>
          {children}
        </div>
      </div>,
      document.body,
    );
  }
  return createPortal(
    <div className="no-print fixed inset-0 z-50 flex items-end justify-center bg-black/55 p-4 sm:items-center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panel}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        className="animate-enter w-full max-w-md rounded-lg border border-line-strong bg-surface p-5 shadow-[0_20px_60px_rgba(0,0,0,0.5)]"
      >
        <h2 id={titleId} className="text-[16px] font-semibold tracking-tight text-ink">
          {title}
        </h2>
        {description && (
          <div id={descId} className="mt-1.5 text-[13px] leading-5 text-muted">
            {description}
          </div>
        )}
        <div className="mt-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  tone = "danger",
  busy,
  onConfirm,
  onCancel,
  extra,
}: {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  tone?: "danger" | "primary";
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  extra?: ReactNode;
}) {
  return (
    <Dialog open={open} title={title} description={description} onClose={onCancel} role="alertdialog">
      {extra}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel} data-autofocus>
          Cancel
        </Button>
        <Button size="sm" variant={tone === "danger" ? "danger" : "primary"} onClick={onConfirm} disabled={busy}>
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}

export function PromptDialog({
  open,
  title,
  label,
  initial,
  confirmLabel,
  description,
  onSubmit,
  onCancel,
  maxLength = 120,
}: {
  open: boolean;
  title: string;
  label: string;
  initial: string;
  confirmLabel: string;
  description?: ReactNode;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  maxLength?: number;
}) {
  return (
    <Dialog open={open} title={title} description={description} onClose={onCancel}>
      {open && <PromptForm key={initial} label={label} initial={initial} confirmLabel={confirmLabel} onSubmit={onSubmit} onCancel={onCancel} maxLength={maxLength} />}
    </Dialog>
  );
}

function PromptForm({ label, initial, confirmLabel, onSubmit, onCancel, maxLength }: { label: string; initial: string; confirmLabel: string; onSubmit: (v: string) => void; onCancel: () => void; maxLength: number }) {
  const [value, setValue] = useState(initial);
  const id = useId();
  const clean = value.replace(/\s+/g, " ").trim();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (clean) onSubmit(clean);
      }}
    >
      <label htmlFor={id} className="block text-xs text-muted">
        {label}
      </label>
      <input
        id={id}
        data-autofocus
        value={value}
        maxLength={maxLength}
        onChange={(e) => setValue(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        className="mt-1 h-10 w-full rounded-md border border-line-strong bg-bg px-3 text-sm text-ink outline-none focus:border-accent"
      />
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" type="submit" disabled={!clean}>
          {confirmLabel}
        </Button>
      </div>
    </form>
  );
}
