import { useState, useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';

export type ConfirmOptions = {
  title: string;
  message: string;
  /** Optional list of related effects to show (e.g. "3 inventory rows will be deleted") */
  relatedEffects?: string[];
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'default';
};

let showConfirmFn: ((opts: ConfirmOptions) => Promise<boolean>) | null = null;

/** Call this from anywhere to show a confirmation dialog. Returns a promise that resolves to true/false. */
export function showConfirm(opts: ConfirmOptions): Promise<boolean> {
  if (!showConfirmFn) return Promise.resolve(false);
  return showConfirmFn(opts);
}

export default function ConfirmDialogProvider() {
  const [open, setOpen] = useState(false);
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const [resolver, setResolver] = useState<((val: boolean) => void) | null>(null);

  useEffect(() => {
    showConfirmFn = (options: ConfirmOptions) => {
      return new Promise<boolean>((resolve) => {
        setOpts(options);
        setResolver(() => resolve);
        setOpen(true);
      });
    };
    return () => { showConfirmFn = null; };
  }, []);

  const handleConfirm = () => {
    resolver?.(true);
    setOpen(false);
  };

  const handleCancel = () => {
    resolver?.(false);
    setOpen(false);
  };

  if (!open || !opts) return null;

  const isDanger = opts.variant === 'danger';

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center glass-overlay p-4 lg:p-6" onClick={handleCancel}>
      <div
        className="glass-floating w-full max-w-md lg:max-w-lg mx-auto animate-scale-in max-h-[min(88vh,720px)] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="p-5 lg:p-6">
          <div className="flex items-start gap-4">
            <div className={`p-2.5 rounded-full shrink-0 ${isDanger ? 'bg-red-100' : 'bg-amber-100'}`}>
              <AlertTriangle className={`w-5 h-5 ${isDanger ? 'text-red-600' : 'text-amber-600'}`} />
            </div>
            <div className="min-w-0">
              <h3 className="text-lg font-bold text-soot-900">{opts.title}</h3>
              <p className="text-sm text-soot-600 mt-1 leading-relaxed">{opts.message}</p>
              {opts.relatedEffects && opts.relatedEffects.length > 0 && (
                <ul className="mt-2 text-sm text-soot-600 list-disc list-inside space-y-0.5">
                  {opts.relatedEffects.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>

        <div className="px-5 lg:px-6 py-4 bg-white/20 border-t border-white/20 flex flex-col-reverse sm:flex-row justify-end gap-2 sm:gap-3">
          <button
            type="button"
            onClick={handleCancel}
            className="min-h-[44px] px-5 py-2.5 text-sm font-medium text-soot-700 bg-white border border-soot-300 rounded-lg hover:bg-soot-100 transition-colors"
          >
            {opts.cancelLabel || 'Cancel'}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            className={`min-h-[44px] px-5 py-2.5 text-sm font-medium text-white rounded-lg transition-colors ${
              isDanger
                ? 'bg-red-600 hover:bg-red-700'
                : 'bg-brand-600 hover:bg-brand-700'
            }`}
          >
            {opts.confirmLabel || 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}
