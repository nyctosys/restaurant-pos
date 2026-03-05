import { useEffect, useRef, useState } from 'react';
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
    ${autoPrint ? '<script>window.onload = function() { window.print(); }<\/script>' : ''}
  </body>
</html>`;
}

export default function BarcodeModal({ sku, title, onClose }: BarcodeModalProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);
  const isTauri = typeof import.meta.env.TAURI_ENV_PLATFORM !== 'undefined';

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
            try {
              document.body.removeChild(iframe);
            } catch (_) {}
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
      } catch (e) {
        setPrinting(false);
        runIframePrint();
      }
      return;
    }

    runIframePrint();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-200 bg-neutral-50">
          <h3 className="text-base font-bold text-neutral-900">Barcode Label</h3>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-neutral-200 transition-colors"
          >
            <X className="w-4 h-4 text-neutral-500" />
          </button>
        </div>

        {/* Barcode */}
        <div className="p-6 flex flex-col items-center gap-3">
          <p className="text-sm font-semibold text-neutral-700 text-center">{title}</p>
          <div className="border border-neutral-200 rounded-xl p-3 bg-white shadow-inner">
            <svg ref={svgRef} />
          </div>
          <p className="text-xs text-neutral-400 font-mono">{sku}</p>
        </div>

        {/* Actions */}
        <div className="px-6 pb-6 flex flex-col gap-3">
          {printError && (
            <p className="text-sm text-red-600 text-center">{printError}</p>
          )}
          <div className="flex gap-3">
            <button
              onClick={onClose}
              disabled={printing}
              className="flex-1 px-4 py-2.5 border border-neutral-200 rounded-lg text-sm font-medium text-neutral-600 hover:bg-neutral-50 transition-colors disabled:opacity-50"
            >
              Close
            </button>
            <button
              onClick={handlePrint}
              disabled={printing}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-brand-700 text-white rounded-lg text-sm font-medium hover:bg-brand-600 transition-colors disabled:opacity-50"
            >
              <Printer className="w-4 h-4" />
              {printing ? 'Printing…' : 'Print Label'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
