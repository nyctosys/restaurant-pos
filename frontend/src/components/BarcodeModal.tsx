import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import JsBarcode from 'jsbarcode';
import { X, Printer } from 'lucide-react';

interface BarcodeModalProps {
  sku: string;
  title: string;
  onClose: () => void;
}

function buildPrintHtml(
  sku: string,
  title: string,
  svgHtml: string,
  opts: { autoPrint?: boolean } = {}
): string {
  const { autoPrint = false } = opts;
  const esc = (s: string) => s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Barcode Label — ${esc(sku)}</title>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        min-height: 100vh;
        font-family: monospace;
        background: #fff;
        padding: 8mm;
      }
      .product-name {
        font-size: 11px;
        font-weight: 700;
        color: #1a1a1a;
        margin-bottom: 4mm;
        text-align: center;
        max-width: 100%;
        word-break: break-word;
      }
      .barcode-wrap {
        padding: 3mm 5mm;
        min-width: 0;
        flex-shrink: 0;
      }
      .barcode-wrap svg {
        display: block;
        width: 100%;
        max-width: 48mm;
        height: auto;
        margin: 0 auto;
        shape-rendering: crispEdges;
      }
      @page { size: 58mm 35mm; margin: 2mm; }
      @media print {
        body { padding: 2mm; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        .barcode-wrap { padding: 2mm 5mm; }
        .barcode-wrap svg {
          width: 48mm !important;
          max-width: 48mm;
          height: auto !important;
          shape-rendering: crispEdges;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
      }
    </style>
  </head>
  <body>
    <p class="product-name">${esc(title)}</p>
    <div class="barcode-wrap">${svgHtml}</div>
    ${autoPrint ? '<script>window.onload = function() { window.print(); }</script>' : ''}
  </body>
</html>`;
}

export default function BarcodeModal({ sku, title, onClose }: BarcodeModalProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);
  const isTauri = typeof import.meta.env.TAURI_ENV_PLATFORM !== 'undefined';

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    if (svgRef.current && sku) {
      try {
        JsBarcode(svgRef.current, sku, {
          format: 'CODE128',
          lineColor: '#000000',
          width: 3,
          height: 70,
          displayValue: true,
          font: 'monospace',
          fontSize: 12,
          margin: 24,
          background: '#ffffff',
        });
      } catch (e) {
        console.error('Barcode generation failed:', e);
      }
    }
  }, [sku]);

  const handlePrint = async () => {
    setPrintError(null);
    if (!svgRef.current) return;
    const svgHTML = svgRef.current.outerHTML;

    const runIframePrint = () => {
      const html = buildPrintHtml(sku, title, svgHTML, { autoPrint: false });
      const iframe = document.createElement('iframe');
      iframe.setAttribute('title', 'Barcode label print');
      iframe.setAttribute(
        'style',
        'position:fixed;left:-9999px;top:0;width:220px;height:140px;border:0;'
      );
      document.body.appendChild(iframe);
      const doc = iframe.contentWindow?.document;
      if (!doc) {
        document.body.removeChild(iframe);
        setPrintError('Print not available');
        return;
      }
      doc.open();
      doc.write(html);
      doc.close();
      iframe.onload = () => {
        const win = iframe.contentWindow;
        if (!win) return;
        const doPrint = () => {
          win.print();
          setTimeout(() => {
            if (iframe.parentNode) {
              document.body.removeChild(iframe);
            }
          }, 500);
        };
        requestAnimationFrame(() => setTimeout(doPrint, 150));
      };
    };

    if (isTauri) {
      setPrinting(true);
      try {
        const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
        const html = buildPrintHtml(sku, title, svgHTML, { autoPrint: true });
        const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
        const label = 'barcode-print-' + Date.now();
        const printWindow = new WebviewWindow(label, {
          url: dataUrl,
          title: 'Barcode Label',
          width: 400,
          height: 380,
        });
        printWindow.once('tauri://error', () => {
          setPrinting(false);
          runIframePrint();
        });
        printWindow.once('tauri://created', () => {
          setPrinting(false);
        });
      } catch {
        setPrinting(false);
        runIframePrint();
      }
      return;
    }

    runIframePrint();
  };

  const modal = (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="barcode-modal-title"
      className="fixed inset-0 z-[110] flex items-center justify-center glass-overlay p-4 lg:p-6"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="glass-floating w-full max-w-md mx-auto overflow-hidden max-h-[min(90vh,640px)] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/30 bg-white/25 shrink-0">
          <h3 id="barcode-modal-title" className="text-base font-bold text-neutral-900">
            Barcode Label
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-[8px] bg-white/50 text-neutral-700 hover:bg-white/80 border border-neutral-300/80 transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Barcode — SKU is rendered by JsBarcode (displayValue); no duplicate line below */}
        <div className="p-6 flex flex-col items-center gap-4">
          <p className="text-sm font-semibold text-neutral-800 text-center px-1">{title}</p>
          <div className="border border-white/40 rounded-[11px] p-4 bg-white/50 w-full max-w-sm flex justify-center">
            <svg ref={svgRef} className="max-w-full h-auto" />
          </div>
        </div>

        {/* Actions */}
        <div className="px-6 pb-6 flex flex-col gap-3 border-t border-white/20 bg-white/10">
          {printError && (
            <p className="text-sm text-red-600 text-center">{printError}</p>
          )}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={printing}
              className="flex-1 min-h-[44px] px-4 py-2.5 rounded-[8px] text-sm font-semibold border-2 border-neutral-700/25 text-neutral-800 bg-white/70 hover:bg-white hover:border-neutral-700/40 transition-colors disabled:opacity-50"
            >
              Close
            </button>
            <button
              type="button"
              onClick={handlePrint}
              disabled={printing}
              className="flex-1 flex items-center justify-center gap-2 min-h-[44px] px-4 py-2.5 bg-brand-700 text-white rounded-[8px] text-sm font-semibold hover:bg-brand-600 transition-colors disabled:opacity-50"
            >
              <Printer className="w-4 h-4 shrink-0" />
              {printing ? 'Printing…' : 'Print Label'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
