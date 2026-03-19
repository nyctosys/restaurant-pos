import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { API_BASE } from '../api/errors';

interface ScannerContextType {
  lastScannedBarcode: string | null;
  clearBarcode: () => void;
  scannerStatus: 'waiting' | 'active' | 'idle';
}

const ScannerContext = createContext<ScannerContextType | undefined>(undefined);

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
    const ws = new WebSocket(`${wsBase}/scanner/ws`);

    ws.onopen = () => {
      ws.send('ping');
    };
    ws.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data) as { type?: string; barcode?: string };
        if (data?.type === 'scan_event' && data.barcode) {
          setLastScannedBarcode(data.barcode);
          markActive();
        }
      } catch {
        // Ignore malformed realtime messages.
      }
    };

    return () => {
      ws.close();
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
