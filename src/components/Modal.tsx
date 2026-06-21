"use client";

import { useEffect, useRef } from "react";

type ModalProps = {
  open: boolean;
  onClose: () => void;
  /** Accessible name for the dialog (sets aria-label). */
  label?: string;
  children: React.ReactNode;
};

/**
 * Module-level stack of currently-open Modal tokens (most-recently-opened last).
 * Each open Modal pushes its own stable token on open and removes it on
 * close/unmount; the Escape handler only fires for the token at the TOP of the
 * stack, so a single Escape closes just the front-most dialog (stacked-escape
 * fix). A unique-object token survives StrictMode double-invoke without needing
 * identity beyond `===`, and removal is by value so cleanup order is irrelevant.
 */
const modalStack: object[] = [];

function pushModal(token: object) {
  // Guard against a duplicate push (e.g. an effect re-run) so the stack never
  // holds the same token twice and removal stays unambiguous.
  if (!modalStack.includes(token)) modalStack.push(token);
}

function removeModal(token: object) {
  const i = modalStack.indexOf(token);
  if (i !== -1) modalStack.splice(i, 1);
}

function isTopModal(token: object) {
  return modalStack.length > 0 && modalStack[modalStack.length - 1] === token;
}

/**
 * Shared modal primitive.
 *
 * - Backdrop click closes; the inner panel stops click propagation so clicks
 *   inside the dialog never reach the backdrop (action-stop-propagation).
 * - Escape closes; body scroll is locked while open.
 * - role="dialog" + aria-modal="true"; focus moves into the panel on open and
 *   is restored to the previously-focused element on close; Tab is trapped
 *   within the panel.
 */
export function Modal({ open, onClose, label, children }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  // Stable per-instance token for the open-modal stack (stacked-escape fix).
  const stackToken = useRef<object>({});

  // Effect A — depends on [open] ONLY so it never re-runs (and never yanks focus
  // back to the first focusable) when a parent passes a fresh onClose closure on
  // re-render (focus-steal fix). Handles: focus capture/move into the panel,
  // body-scroll-lock, previously-focused restore, and the Tab focus-trap.
  useEffect(() => {
    if (!open) return;

    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const focusables = () =>
      Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])'
        ) ?? []
      );

    // Move focus into the dialog.
    (focusables()[0] ?? panelRef.current)?.focus();

    const onTabKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onTabKey);
    return () => {
      document.removeEventListener("keydown", onTabKey);
      document.body.style.overflow = prevOverflow;
      previouslyFocused.current?.focus?.();
    };
  }, [open]);

  // Effect B — the Escape listener lives separately with deps [open, onClose] so
  // a fresh onClose closure only re-adds/removes this lightweight listener; it
  // never re-runs the focus/scroll-lock effect above. This Modal registers on the
  // module-level stack while open and only honors Escape when it is the top-most
  // open Modal, so a single Escape over stacked modals closes just the front one
  // (stacked-escape fix). Stack membership is cleaned up on close/unmount.
  useEffect(() => {
    if (!open) return;
    const token = stackToken.current;
    pushModal(token);
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (!isTopModal(token)) return; // a lower modal must not also close
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("keydown", onEscape);
      removeModal(token);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{
        background: "rgba(8,20,15,.48)",
        backdropFilter: "blur(4px)",
      }}
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
