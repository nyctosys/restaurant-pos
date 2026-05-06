import { useEffect, useState } from 'react';
import { CheckCircle, XCircle, Info, X } from 'lucide-react';

export type ToastType = 'success' | 'error' | 'info';

type ToastData = {
  id: number;
  message: string;
  type: ToastType;
};

type ToastEventDetail = { message: string; type: ToastType };

let toastId = 0;
let addToastFn: ((message: string, type: ToastType) => void) | null = null;

/** Call this from anywhere to show a toast notification */
// eslint-disable-next-line react-refresh/only-export-components
export function showToast(message: string, type: ToastType = 'info') {
  const normalized = String(message ?? '').trim() || 'Something went wrong';
  // Prefer the in-memory handler when available (single instance).
  if (addToastFn) {
    addToastFn(normalized, type);
    return;
  }
  // Fallback: broadcast an event so even if the module is duplicated (different import paths),
  // the mounted ToastContainer can still receive the toast request.
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<ToastEventDetail>('app:toast', { detail: { message: normalized, type } }));
  }
}

export default function ToastContainer() {
  const [toasts, setToasts] = useState<ToastData[]>([]);

  useEffect(() => {
    const enqueue = (message: string, type: ToastType) => {
      const id = ++toastId;
      setToasts(prev => [...prev, { id, message, type }]);
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== id));
      }, 4000);
    };

    addToastFn = enqueue;

    const onToastEvent = (evt: Event) => {
      const custom = evt as CustomEvent<ToastEventDetail>;
      const detail = custom.detail;
      if (!detail?.message) return;
      enqueue(String(detail.message), detail.type ?? 'info');
    };

    window.addEventListener('app:toast', onToastEvent);
    return () => {
      window.removeEventListener('app:toast', onToastEvent);
      addToastFn = null;
    };
  }, []);

  const dismiss = (id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  const icon = (type: ToastType) => {
    switch (type) {
      case 'success': return <CheckCircle className="w-5 h-5 text-brand-600 dark:text-brand-300 shrink-0" />;
      case 'error': return <XCircle className="w-5 h-5 text-red-600 dark:text-red-300 shrink-0" />;
      default: return <Info className="w-5 h-5 text-blue-600 dark:text-blue-300 shrink-0" />;
    }
  };

  const bg = (type: ToastType) => {
    switch (type) {
      case 'success': return 'bg-white/90 border-brand-200/70 dark:bg-white/10 dark:border-white/20';
      case 'error': return 'bg-white/90 border-red-200/70 dark:bg-white/10 dark:border-white/20';
      default: return 'bg-white/90 border-blue-200/70 dark:bg-white/10 dark:border-white/20';
    }
  };

  return (
    <div className="fixed top-4 right-4 z-[200] flex flex-col gap-3 pointer-events-none" style={{ maxWidth: 420 }}>
      {toasts.map(t => (
        <div
          key={t.id}
          className={`pointer-events-auto flex items-start gap-3 px-4 py-3 rounded-[14px] border shadow-sm backdrop-blur ${bg(t.type)} animate-slide-in`}
        >
          {icon(t.type)}
          <p className="text-sm font-medium text-soot-900 dark:text-white/90 flex-1">{t.message}</p>
          <button onClick={() => dismiss(t.id)} className="p-0.5 rounded hover:bg-black/5 dark:hover:bg-white/10 transition-colors shrink-0">
            <X className="w-4 h-4 text-soot-500 dark:text-white/60" />
          </button>
        </div>
      ))}
    </div>
  );
}
