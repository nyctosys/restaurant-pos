import { useEffect, useState } from 'react';
import { CheckCircle, XCircle, Info, X } from 'lucide-react';

export type ToastType = 'success' | 'error' | 'info';

type ToastData = {
  id: number;
  message: string;
  type: ToastType;
};

let toastId = 0;
let addToastFn: ((message: string, type: ToastType) => void) | null = null;

/** Call this from anywhere to show a toast notification */
// eslint-disable-next-line react-refresh/only-export-components
export function showToast(message: string, type: ToastType = 'info') {
  const normalized = String(message ?? '').trim() || 'Something went wrong';
  addToastFn?.(normalized, type);
}

export default function ToastContainer() {
  const [toasts, setToasts] = useState<ToastData[]>([]);

  useEffect(() => {
    addToastFn = (message: string, type: ToastType) => {
      const id = ++toastId;
      setToasts(prev => [...prev, { id, message, type }]);
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== id));
      }, 4000);
    };
    return () => { addToastFn = null; };
  }, []);

  const dismiss = (id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  const icon = (type: ToastType) => {
    switch (type) {
      case 'success': return <CheckCircle className="w-5 h-5 text-brand-500 shrink-0" />;
      case 'error': return <XCircle className="w-5 h-5 text-red-500 shrink-0" />;
      default: return <Info className="w-5 h-5 text-blue-500 shrink-0" />;
    }
  };

  const bg = (type: ToastType) => {
    switch (type) {
      case 'success': return 'bg-brand-50 border-brand-200';
      case 'error': return 'bg-red-50 border-red-200';
      default: return 'bg-blue-50 border-blue-200';
    }
  };

  return (
    <div className="fixed top-4 right-4 z-[100] flex flex-col gap-3 pointer-events-none" style={{ maxWidth: 400 }}>
      {toasts.map(t => (
        <div
          key={t.id}
          className={`pointer-events-auto flex items-start gap-3 px-4 py-3 rounded-[11px] border ${bg(t.type)} animate-slide-in`}
        >
          {icon(t.type)}
          <p className="text-sm font-medium text-soot-800 dark:text-[#1d1d1f] flex-1">{t.message}</p>
          <button onClick={() => dismiss(t.id)} className="p-0.5 rounded hover:bg-black/5 transition-colors shrink-0">
            <X className="w-4 h-4 text-soot-400" />
          </button>
        </div>
      ))}
    </div>
  );
}
