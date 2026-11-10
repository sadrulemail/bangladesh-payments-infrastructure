import { type ReactNode, createContext, useCallback, useContext, useMemo, useState } from "react";

type Tone = "good" | "critical";

interface Toast {
  id: number;
  tone: Tone;
  title: string;
  detail?: string;
}

interface ToastState {
  notify(tone: Tone, title: string, detail?: string): void;
}

const ToastContext = createContext<ToastState | null>(null);
const VISIBLE_MS = 7_000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => setToasts((items) => items.filter((item) => item.id !== id)), []);
  const notify = useCallback(
    (tone: Tone, title: string, detail?: string) => {
      const id = Date.now() + Math.random();
      setToasts((items) => [...items.slice(-3), { id, tone, title, detail }]);
      window.setTimeout(() => dismiss(id), VISIBLE_MS);
    },
    [dismiss],
  );

  const value = useMemo(() => ({ notify }), [notify]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="fixed right-4 bottom-4 z-50 flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2" aria-live="polite">
        {toasts.map((toast) => (
          <button
            key={toast.id}
            type="button"
            onClick={() => dismiss(toast.id)}
            className="rounded-lg border border-line bg-surface p-3 text-left shadow-lg"
          >
            <span className="flex items-center gap-2 text-sm font-semibold">
              <span
                aria-hidden
                className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-xs text-white ${
                  toast.tone === "good" ? "bg-good" : "bg-critical"
                }`}
              >
                {toast.tone === "good" ? "✓" : "!"}
              </span>
              {toast.title}
            </span>
            {toast.detail && <span className="mt-1 block text-xs break-words text-ink-2">{toast.detail}</span>}
          </button>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastState {
  const state = useContext(ToastContext);
  if (!state) throw new Error("useToast must be used inside ToastProvider");
  return state;
}
