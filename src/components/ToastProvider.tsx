"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

type ToastContextValue = {
  showToast: (msg: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

/**
 * Toast feedback primitive (overlay-toast / state-toast-feedback).
 *
 * Fixed bottom-center dark pill. Fades + translateY(20px -> 0) over ~200ms and
 * auto-dismisses after 2200ms. Mounted once in the root layout, wrapping
 * {children}. Consume via useToast().
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((msg: string) => {
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
    if (clearTimer.current) clearTimeout(clearTimer.current);

    setMessage(msg);
    setVisible(true);

    dismissTimer.current = setTimeout(() => {
      setVisible(false);
      // Remove from the DOM after the fade-out transition completes.
      clearTimer.current = setTimeout(() => setMessage(null), 220);
    }, 2200);
  }, []);

  useEffect(() => {
    return () => {
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
      if (clearTimer.current) clearTimeout(clearTimer.current);
    };
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {/* The live region stays mounted so the FIRST toast is reliably announced —
          a region inserted into the DOM together with its text can be missed by
          screen readers. Visibility is toggled instead of mount/unmount. */}
      <div
        role="status"
        aria-live="polite"
        style={{
          position: "fixed",
          left: "50%",
          bottom: "22px",
          transform: visible
            ? "translateX(-50%) translateY(0)"
            : "translateX(-50%) translateY(20px)",
          opacity: visible ? 1 : 0,
          visibility: message !== null ? "visible" : "hidden",
          maxWidth: "calc(100vw - 32px)",
          background: "#0f172a",
          color: "#ffffff",
          borderRadius: "16px",
          padding: "12px 18px",
          fontWeight: 600,
          textAlign: "center",
          overflowWrap: "anywhere",
          boxShadow: "0 18px 40px rgba(0,0,0,.26)",
          transition: "opacity .2s, transform .2s",
          zIndex: 50,
          pointerEvents: "none",
        }}
      >
        {message}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return ctx;
}
