import { useState, useEffect } from 'react';
import { Loader2, Upload } from 'lucide-react';
import { showToast } from '../Toast';
import { formatCurrency } from '../../utils/formatCurrency';
import { get, put, getUserMessage } from '../../api';
import { getTerminalBranchIdString, parseUserFromStorage } from '../../utils/branchContext';

type SettingsResponse = { config?: Record<string, unknown> };

export default function ReceiptSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [businessName, setBusinessName] = useState('My Business');
  const [businessAddress, setBusinessAddress] = useState('123 Main Street\nCity, ST 12345');
  const [businessPhone, setBusinessPhone] = useState('(555) 123-4567');
  const [logoUrl, setLogoUrl] = useState('');
  const [logoHeight, setLogoHeight] = useState(140);       // 80–250 px, full header width
  const [headerFontScale, setHeaderFontScale] = useState(1); // 1–4
  const [bodyFontScale, setBodyFontScale] = useState(1);    // 1–4
  const [totalFontScale, setTotalFontScale] = useState(1);  // 1–4
  const [footerMessage, setFooterMessage] = useState('Thank you for shopping!');
  const [footerLine1, setFooterLine1] = useState('');
  const [footerLine2, setFooterLine2] = useState('');
  const [footerLine3, setFooterLine3] = useState('');
  const [gstNumber, setGstNumber] = useState('');
  const [ntnNumber, setNtnNumber] = useState('');
  const [customId1Label, setCustomId1Label] = useState('');
  const [customId1Value, setCustomId1Value] = useState('');
  const [customId2Label, setCustomId2Label] = useState('');
  const [customId2Value, setCustomId2Value] = useState('');
  const [qrCodeContent, setQrCodeContent] = useState('');
  const [taxRate, setTaxRate] = useState(8);

  useEffect(() => {
    fetchSettings();
  }, []);

  const fetchSettings = async () => {
    try {
      setLoading(true);
      // Reset to defaults first to avoid stale data from previous branch
      setBusinessName('My Business');
      setBusinessAddress('123 Main Street\nCity, ST 12345');
      setBusinessPhone('(555) 123-4567');
      setLogoUrl('');
      setLogoHeight(140);
      setHeaderFontScale(1);
      setBodyFontScale(1);
      setTotalFontScale(1);
      setFooterMessage('Thank you for shopping!');
      setFooterLine1('');
      setFooterLine2('');
      setFooterLine3('');
      setGstNumber('');
      setNtnNumber('');
      setCustomId1Label('');
      setCustomId1Value('');
      setCustomId2Label('');
      setCustomId2Value('');
      setQrCodeContent('');
      setTaxRate(8);

      const activeBranchId = getTerminalBranchIdString(parseUserFromStorage());
      const query = activeBranchId ? `?branch_id=${activeBranchId}` : '';
      const data = await get<SettingsResponse>(`/settings/${query}`);
      const st = (data?.config?.receipt_settings ?? {}) as Record<string, string | number | undefined>;
      if (st.businessName) setBusinessName(String(st.businessName));
      if (st.businessAddress) setBusinessAddress(String(st.businessAddress));
      if (st.businessPhone) setBusinessPhone(String(st.businessPhone));
      if (st.logoUrl) setLogoUrl(String(st.logoUrl));
      if (typeof st.logoHeight === 'number' && st.logoHeight >= 80 && st.logoHeight <= 250) setLogoHeight(st.logoHeight);
      if (typeof st.headerFontScale === 'number' && st.headerFontScale >= 1 && st.headerFontScale <= 4) setHeaderFontScale(st.headerFontScale);
      if (typeof st.bodyFontScale === 'number' && st.bodyFontScale >= 1 && st.bodyFontScale <= 4) setBodyFontScale(st.bodyFontScale);
      if (typeof st.totalFontScale === 'number' && st.totalFontScale >= 1 && st.totalFontScale <= 4) setTotalFontScale(st.totalFontScale);
      if (st.footerMessage) setFooterMessage(String(st.footerMessage));
      if (st.footerLine1 != null) setFooterLine1(String(st.footerLine1 ?? ''));
      if (st.footerLine2 != null) setFooterLine2(String(st.footerLine2 ?? ''));
      if (st.footerLine3 != null) setFooterLine3(String(st.footerLine3 ?? ''));
      if (st.gstNumber != null) setGstNumber(String(st.gstNumber ?? ''));
      if (st.ntnNumber != null) setNtnNumber(String(st.ntnNumber ?? ''));
      if (st.customId1Label != null) setCustomId1Label(String(st.customId1Label ?? ''));
      if (st.customId1Value != null) setCustomId1Value(String(st.customId1Value ?? ''));
      if (st.customId2Label != null) setCustomId2Label(String(st.customId2Label ?? ''));
      if (st.customId2Value != null) setCustomId2Value(String(st.customId2Value ?? ''));
      if (st.qrCodeContent != null) setQrCodeContent(String(st.qrCodeContent ?? ''));
      if (data?.config && typeof (data.config as Record<string, unknown>).tax_rate === 'number') {
        setTaxRate((data.config as Record<string, number>).tax_rate);
      }
    } catch (e) {
      showToast(getUserMessage(e), 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      const activeBranchId = getTerminalBranchIdString(parseUserFromStorage());
      const query = activeBranchId ? `?branch_id=${activeBranchId}` : '';
      const existing = await get<SettingsResponse>(`/settings/${query}`);
      const currentConfig = (existing?.config ?? {}) as Record<string, unknown>;
      const newSettings = {
        ...currentConfig,
        receipt_settings: {
          businessName,
          businessAddress,
          businessPhone,
          logoUrl,
          logoHeight,
          headerFontScale,
          bodyFontScale,
          totalFontScale,
          footerMessage,
          footerLine1,
          footerLine2,
          footerLine3,
          gstNumber,
          ntnNumber,
          customId1Label,
          customId1Value,
          customId2Label,
          customId2Value,
          qrCodeContent,
        },
      };
      const payload: { config: Record<string, unknown>; branch_id?: string } = { config: newSettings };
      if (activeBranchId) payload.branch_id = activeBranchId;
      await put('/settings/', payload);
      showToast('Receipt settings saved!', 'success');
    } catch (e) {
      showToast(getUserMessage(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    // Check size limit (e.g. 1MB max for config payload)
    if (file.size > 1024 * 1024) {
      showToast('Logo file must be under 1MB', 'error');
      return;
    }
    
    const reader = new FileReader();
    reader.onloadend = () => {
      setLogoUrl(reader.result as string);
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="max-w-6xl grid grid-cols-1 lg:grid-cols-2 gap-8">
      {/* Settings Form */}
      <div>
        <h3 className="text-2xl font-bold text-soot-900 mb-2">Receipt Settings</h3>
        <p className="text-sm text-soot-500 mb-6">Customize how printed receipts look.</p>

        {loading ? (
          <div className="flex items-center gap-2 text-soot-400 py-6">
             <Loader2 className="w-5 h-5 animate-spin" /> Loading settings...
          </div>
        ) : (
          <div className="space-y-5 bg-soot-50 p-6 rounded-xl border border-soot-200">
            <div>
              <label className="block text-sm font-semibold text-soot-800 mb-1">Business Name (optional)</label>
              <input
                type="text"
                inputMode="text"
                value={businessName}
                onChange={(e) => setBusinessName(e.target.value)}
                className="w-full px-4 py-3 border border-soot-200 rounded-lg focus:ring-2 focus:ring-brand-500 focus:outline-none"
                placeholder="e.g. Main Street Kitchen"
              />
            </div>
            
            <div className="grid grid-cols-2 gap-4">
               <div>
                  <label className="block text-sm font-semibold text-soot-800 mb-1">Business Address</label>
                  <textarea
                    value={businessAddress}
                    onChange={(e) => setBusinessAddress(e.target.value)}
                    rows={2}
                    className="w-full px-4 py-3 border border-soot-200 rounded-lg focus:ring-2 focus:ring-brand-500 focus:outline-none text-sm"
                    placeholder="123 Main Street"
                  />
               </div>
               <div>
                  <label className="block text-sm font-semibold text-soot-800 mb-1">Phone Number</label>
                  <input
                    type="text"
                    inputMode="tel"
                    value={businessPhone}
                    onChange={(e) => setBusinessPhone(e.target.value)}
                    className="w-full px-4 py-3 border border-soot-200 rounded-lg focus:ring-2 focus:ring-brand-500 focus:outline-none text-sm"
                    placeholder="(555) 123-4567"
                  />
               </div>
            </div>

            <div>
              <label className="block text-sm font-semibold text-soot-800 mb-2">Logo Upload</label>
              <div className="flex items-center gap-4">
                 {logoUrl && (
                   <img src={logoUrl} alt="Logo Preview" className="h-12 w-12 object-contain border border-soot-200 bg-white rounded flex-shrink-0" />
                 )}
                 <div className="flex-1 relative">
                    <input 
                      type="file" 
                      accept="image/*"
                      onChange={handleLogoUpload}
                      className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    />
                    <div className="w-full px-4 py-3 border border-dashed border-soot-300 rounded-lg bg-white flex items-center justify-center gap-2 text-soot-500 hover:bg-soot-100 transition-colors pointer-events-none">
                       <Upload className="w-4 h-4" /> <span>Choose File</span>
                    </div>
                 </div>
                 {logoUrl && (
                    <button onClick={() => setLogoUrl('')} className="text-sm text-red-600 font-medium hover:underline">
                       Remove
                    </button>
                 )}
              </div>
              <p className="mt-1 text-xs text-soot-500">Only image files under 1MB. For cleanest print use a high-contrast logo (black on white, no gradients).</p>
            </div>

            <div className="rounded-lg bg-soot-100 border border-soot-200 p-3">
              <p className="text-sm font-medium text-soot-800 mb-1">Clean print tips (like reference receipts)</p>
              <p className="text-xs text-soot-600">Use a simple, high-contrast logo and keep body font at 1× for sharpest text. Header and total can be 1–2× for a clear, professional look.</p>
            </div>

            <div>
              <label className="block text-sm font-semibold text-soot-800 mb-1">Logo height (full header width)</label>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={80}
                  max={250}
                  step={10}
                  value={logoHeight}
                  onChange={(e) => setLogoHeight(Number(e.target.value))}
                  className="flex-1 h-2 bg-soot-200 rounded-lg appearance-none cursor-pointer accent-brand-600"
                />
                <span className="text-sm font-medium text-soot-700 w-10">{logoHeight}px</span>
              </div>
              <p className="mt-1 text-xs text-soot-500">Logo always uses full receipt width. Adjust height only.</p>
            </div>

            <div>
              <label className="block text-sm font-semibold text-soot-800 mb-1">Header font size (business name)</label>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={1}
                  max={4}
                  step={1}
                  value={headerFontScale}
                  onChange={(e) => setHeaderFontScale(Number(e.target.value))}
                  className="flex-1 h-2 bg-soot-200 rounded-lg appearance-none cursor-pointer accent-brand-600"
                />
                <span className="text-sm font-medium text-soot-700 w-8">{headerFontScale}x</span>
              </div>
            </div>

            <div>
              <label className="block text-sm font-semibold text-soot-800 mb-1">Body font size (address, items, subtotal)</label>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={1}
                  max={4}
                  step={1}
                  value={bodyFontScale}
                  onChange={(e) => setBodyFontScale(Number(e.target.value))}
                  className="flex-1 h-2 bg-soot-200 rounded-lg appearance-none cursor-pointer accent-brand-600"
                />
                <span className="text-sm font-medium text-soot-700 w-8">{bodyFontScale}x</span>
              </div>
            </div>

            <div>
              <label className="block text-sm font-semibold text-soot-800 mb-1">Total line font size</label>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={1}
                  max={4}
                  step={1}
                  value={totalFontScale}
                  onChange={(e) => setTotalFontScale(Number(e.target.value))}
                  className="flex-1 h-2 bg-soot-200 rounded-lg appearance-none cursor-pointer accent-brand-600"
                />
                <span className="text-sm font-medium text-soot-700 w-8">{totalFontScale}x</span>
              </div>
            </div>

            <div>
              <label className="block text-sm font-semibold text-soot-800 mb-1">Footer Message</label>
              <textarea
                value={footerMessage}
                onChange={(e) => setFooterMessage(e.target.value)}
                rows={3}
                className="w-full px-4 py-3 border border-soot-200 rounded-lg focus:ring-2 focus:ring-brand-500 focus:outline-none"
                placeholder="e.g. Thank you for shopping!"
              />
            </div>

            <div className="border-t border-soot-200 pt-5">
              <p className="text-sm font-semibold text-soot-800 mb-3">Extra footer lines</p>
              <p className="text-xs text-soot-500 mb-2">Optional lines below the main footer (e.g. website, branch code, terms).</p>
              <input type="text" inputMode="text" value={footerLine1} onChange={(e) => setFooterLine1(e.target.value)} placeholder="e.g. Visit: https://example.com" className="w-full px-4 py-2 border border-soot-200 rounded-lg text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none mb-2" />
              <input type="text" inputMode="text" value={footerLine2} onChange={(e) => setFooterLine2(e.target.value)} placeholder="e.g. Branch code: 820989" className="w-full px-4 py-2 border border-soot-200 rounded-lg text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none mb-2" />
              <input type="text" inputMode="text" value={footerLine3} onChange={(e) => setFooterLine3(e.target.value)} placeholder="e.g. Terms and conditions: Discount valid 30 days" className="w-full px-4 py-2 border border-soot-200 rounded-lg text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none" />
            </div>

            <div className="border-t border-soot-200 pt-5">
              <p className="text-sm font-semibold text-soot-800 mb-3">Tax & legal IDs</p>
              <p className="text-xs text-soot-500 mb-2">GST#, NTN#, FBR invoice, etc. Leave blank to omit.</p>
              <div className="grid grid-cols-2 gap-3 mb-3">
                <div>
                  <label className="block text-xs font-medium text-soot-600 mb-0.5">GST#</label>
                  <input type="text" inputMode="numeric" value={gstNumber} onChange={(e) => setGstNumber(e.target.value)} placeholder="e.g. 3277876276814" className="w-full px-4 py-2 border border-soot-200 rounded-lg text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-soot-600 mb-0.5">NTN#</label>
                  <input type="text" inputMode="text" value={ntnNumber} onChange={(e) => setNtnNumber(e.target.value)} placeholder="e.g. 4555916-4" className="w-full px-4 py-2 border border-soot-200 rounded-lg text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 mb-2">
                <div>
                  <label className="block text-xs font-medium text-soot-600 mb-0.5">Custom 1 label</label>
                  <input type="text" inputMode="text" value={customId1Label} onChange={(e) => setCustomId1Label(e.target.value)} placeholder="e.g. FBR Invoice" className="w-full px-4 py-2 border border-soot-200 rounded-lg text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-soot-600 mb-0.5">Custom 1 value</label>
                  <input type="text" inputMode="text" value={customId1Value} onChange={(e) => setCustomId1Value(e.target.value)} placeholder="e.g. 174747EISK5376524" className="w-full px-4 py-2 border border-soot-200 rounded-lg text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-soot-600 mb-0.5">Custom 2 label</label>
                  <input type="text" inputMode="text" value={customId2Label} onChange={(e) => setCustomId2Label(e.target.value)} placeholder="e.g. CHK" className="w-full px-4 py-2 border border-soot-200 rounded-lg text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-soot-600 mb-0.5">Custom 2 value</label>
                  <input type="text" inputMode="text" value={customId2Value} onChange={(e) => setCustomId2Value(e.target.value)} placeholder="e.g. 1935-2-20250925" className="w-full px-4 py-2 border border-soot-200 rounded-lg text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none" />
                </div>
              </div>
            </div>

            <div className="border-t border-soot-200 pt-5">
              <p className="text-sm font-semibold text-soot-800 mb-1">QR code on receipt</p>
              <p className="text-xs text-soot-500 mb-2">URL or text to encode as a QR code (e.g. invoice URL, store link). Printed below footer when set.</p>
              <input type="text" inputMode="url" value={qrCodeContent} onChange={(e) => setQrCodeContent(e.target.value)} placeholder="e.g. https://example.com/invoice" className="w-full px-4 py-3 border border-soot-200 rounded-lg focus:ring-2 focus:ring-brand-500 focus:outline-none text-sm" />
            </div>

            <button 
              onClick={handleSave}
              disabled={saving}
              className="mt-4 bg-brand-700 text-white px-6 py-3 rounded-lg font-bold hover:bg-brand-600 disabled:opacity-50 transition-colors flex items-center gap-2"
            >
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              Save Receipt Layout
            </button>
          </div>
        )}
      </div>

      {/* Live Preview */}
      <div className="flex items-start justify-center p-8 bg-soot-900 rounded-xl relative overflow-hidden">
        {/* Subtle patterned background or grid could go here */}
        
        <div className="receipt-paper w-72 shadow-2xl p-6 font-mono text-sm shadow-black/20 transform rotate-1 rounded-sm">
          {logoUrl && (
            <div className="flex justify-center mb-4 w-full">
               <img src={logoUrl} alt="Store Logo" className="w-full object-contain grayscale" style={{ maxHeight: Math.min(logoHeight, 120) }} />
            </div>
          )}
          <h1 className="text-center font-bold leading-tight uppercase mb-2" style={{ fontSize: `${0.9 + headerFontScale * 0.25}rem` }}>{businessName || 'Business Name'}</h1>
          
          <div className="text-xs text-center text-soot-500 mb-6 pb-4 border-b border-dashed border-soot-300 whitespace-pre-line">
             {businessAddress}
             {businessPhone && `\n${businessPhone}`}
          </div>
          
          <div className="text-xs text-soot-500 mb-4 flex justify-between">
              <div>
                 OP: {(() => { const u = localStorage.getItem('user'); return u ? JSON.parse(u).username : 'Operator'; })()}<br/>
                 Store: {(() => { const u = localStorage.getItem('user'); return u ? (JSON.parse(u).branch_name || 'Main Branch') : 'Branch'; })()}
              </div>
              <div className="text-right">
                 {new Date().toLocaleDateString()}<br/>
                 {new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
              </div>
          </div>

          <div className="mb-2 text-xs">
            <div className="flex justify-between mb-1 text-soot-500 font-bold border-b border-soot-200 pb-1">
              <span>Item</span><span>Total</span>
            </div>
            <div className="flex justify-between mb-1">
              <span>Classic T-Shirt x1</span><span>{formatCurrency(25.00)}</span>
            </div>
            <div className="flex justify-between mb-1">
              <span>Denim Jacket x1</span><span>{formatCurrency(85.00)}</span>
            </div>
          </div>

          <div className="border-t-2 border-soot-900 pt-2 mt-4 space-y-1">
            <div className="flex justify-between text-xs text-soot-500">
               <span>Subtotal</span><span>{formatCurrency(110.00)}</span>
            </div>
            <div className="flex justify-between text-xs text-soot-500">
               <span>Tax ({taxRate}%)</span><span>{formatCurrency(110.00 * (taxRate / 100))}</span>
            </div>
            <div className="flex justify-between font-bold text-lg mt-2">
               <span>Total</span><span>{formatCurrency(110.00 * (1 + taxRate / 100))}</span>
            </div>
          </div>

          {(gstNumber || ntnNumber || customId1Value || customId2Value) && (
            <div className="border-t border-dashed border-soot-300 pt-3 mt-3 text-center text-xs text-soot-600 space-y-0.5">
              {gstNumber && <div>GST# {gstNumber}</div>}
              {ntnNumber && <div>NTN# {ntnNumber}</div>}
              {customId1Label && customId1Value && <div>{customId1Label}: {customId1Value}</div>}
              {customId2Label && customId2Value && <div>{customId2Label}: {customId2Value}</div>}
            </div>
          )}

          <div className="border-t border-dashed border-soot-300 pt-4 mt-4 text-center text-xs whitespace-pre-line text-soot-600">
            {footerMessage || 'Thank you!'}
          </div>
          {(footerLine1 || footerLine2 || footerLine3) && (
            <div className="text-center text-xs text-soot-500 space-y-0.5 mt-2">
              {footerLine1 && <div>{footerLine1}</div>}
              {footerLine2 && <div>{footerLine2}</div>}
              {footerLine3 && <div>{footerLine3}</div>}
            </div>
          )}
          {qrCodeContent && (
            <div className="mt-3 flex justify-center">
              <div className="w-16 h-16 border-2 border-dashed border-soot-400 rounded flex items-center justify-center text-soot-400 text-[10px] text-center">QR</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
