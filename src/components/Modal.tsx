"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type ModalProps = {
  open: boolean;
  onClose: () => void;
  /** Accessible name for the dialog (sets aria-label). */
  label?: string;
  /**
   * Screen-hidden print source (pos-autoprint-receipt): when true the portaled
   * overlay carries the `print-source` class → `display:none` on screen but still
   * printable (the `@media print [data-modal-portal]{display:block}` rule wins).
   * Used by the POS auto-print receipt so it prints without ever being visible.
   */
  printSource?: boolean;
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
export function Modal({ open, onClose, label, printSource, children }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  // Stable per-instance token for the open-modal stack (stacked-escape fix).
  const stackToken = useRef<object>({});
  // SSR/hydration guard for the body portal (print-isolation fix): the overlay is
  // rendered via createPortal into document.body so it mounts as a DIRECT body
  // child — OUTSIDE the app shell — which lets `@media print` hide the tall shell
  // and print ONLY the receipt/tax-invoice paper (no blank pages, no repeats).
  // document.body does not exist during SSR, so we defer the portal until after
  // the first client commit to keep hydration deterministic (server + first
  // client render both produce null).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

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

  if (!open || !mounted) return null;

  // Portal the overlay to document.body so every modal mounts as a direct body
  // child (`body > [data-modal-portal]`), outside the collapsible app shell.
  // createPortal preserves React context + event bubbling through the component
  // tree, so consumers, backdrop-click, and stopPropagation are unaffected.
  const overlay = (
    <div
      data-modal-portal
      className={
        "fixed inset-0 z-50 flex items-center justify-center" +
        (printSource ? " print-source" : "")
      }
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

  return createPortal(overlay, document.body);
}
