/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { API_BASE } from '../api/errors';

interface ScannerContextType {
  lastScannedBarcode: string | null;
  clearBarcode: () => void;
  scannerStatus: 'waiting' | 'active' | 'idle';
}

const ScannerContext = createContext<ScannerContextType | undefined>(undefined);

type ScanHandler = (barcode: string) => void;

// React 18/19 StrictMode can mount/unmount components immediately in dev.
// To avoid "closed before connection is established" WebSocket noise, keep a shared socket and
// only register/unregister scan handlers per provider instance.
let sharedWs: WebSocket | null = null;
let sharedWsUrl: string | null = null;
const sharedHandlers: Set<ScanHandler> = new Set();

function ensureSharedScannerSocket(wsUrl: string): WebSocket {
  // If already open/connecting to the same URL, reuse it.
  if (
    sharedWs &&
    sharedWsUrl === wsUrl &&
    (sharedWs.readyState === WebSocket.OPEN || sharedWs.readyState === WebSocket.CONNECTING)
  ) {
    return sharedWs;
  }

  // Close the old socket if we’re switching URLs.
  if (sharedWs) {
    try {
      sharedWs.close();
    } catch {
      // ignore
    }
    sharedWs = null;
  }

  sharedWsUrl = wsUrl;

  const ws = new WebSocket(wsUrl);
  sharedWs = ws;

  ws.onopen = () => {
    ws.send('ping');
  };

  ws.onerror = () => {
  };

  ws.onclose = () => {
    // If connection drops, allow recreation on next handler registration.
    if (sharedWs === ws) {
      sharedWs = null;
      sharedWsUrl = null;
    }
  };

  ws.onmessage = (evt) => {
    try {
      const data = JSON.parse(evt.data) as { type?: string; barcode?: string };
      if (data?.type === 'scan_event' && data.barcode) {
        for (const handler of sharedHandlers) handler(data.barcode);
      }
    } catch {
      // Ignore malformed realtime messages.
    }
  };

  return ws;
}

export const ScannerProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [lastScannedBarcode, setLastScannedBarcode] = useState<string | null>(null);
  
  // Scanner status:
  //   'waiting' — no scan has been detected yet (we don't know if a scanner is plugged in)
  //   'active'  — a scan was detected recently (within last 30s)
  //   'idle'    — scanner was active before but hasn't scanned for a while
  const [scannerStatus, setScannerStatus] = useState<'waiting' | 'active' | 'idle'>('waiting');
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const bufferRef = useRef<string>('');
  const lastKeyTimeRef = useRef<number>(0);

  const markActive = () => {
    setScannerStatus('active');
    // Reset idle timer
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => {
      setScannerStatus('idle');
    }, 60000); // 60s of no scans → idle
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore events when user is typing in input/textarea/select
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      const currentTime = new Date().getTime();
      
      if (e.key === 'Enter') {
        // If we typed at least 3 chars very quickly, assume it's a barcode scan
        if (bufferRef.current.length >= 3) {
          console.log('USB Scanner detected barcode:', bufferRef.current);
          setLastScannedBarcode(bufferRef.current);
          markActive();
        }
        bufferRef.current = '';
        return;
      }
      
      // If it's a printable character
      if (e.key.length === 1) {
        // More than 50ms since last keypress means it's likely manual typing
        if (currentTime - lastKeyTimeRef.current > 50) {
          bufferRef.current = e.key;
        } else {
          bufferRef.current += e.key;
        }
        lastKeyTimeRef.current = currentTime;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const apiBase = API_BASE.startsWith('http') ? API_BASE : window.location.origin + API_BASE;
    const wsBase = apiBase.replace(/^http/i, 'ws');
    const wsUrl = `${wsBase}/scanner/ws`;

    const handler: ScanHandler = (barcode) => {
      setLastScannedBarcode(barcode);
      markActive();
    };

    // Register the current provider’s handler for scan events.
    sharedHandlers.add(handler);

    // Create (or reuse) the shared socket; it will call all registered handlers.
    ensureSharedScannerSocket(wsUrl);

    return () => {
      sharedHandlers.delete(handler);
    };
  }, []);

  const clearBarcode = () => {
    setLastScannedBarcode(null);
  };

  return (
    <ScannerContext.Provider value={{ lastScannedBarcode, clearBarcode, scannerStatus }}>
      {children}
    </ScannerContext.Provider>
  );
};

export const useScanner = () => {
  const context = useContext(ScannerContext);
  if (context === undefined) {
    throw new Error('useScanner must be used within a ScannerProvider');
  }
  return context;
};
