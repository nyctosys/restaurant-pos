import React, { useState, useEffect } from 'react';
import { Plus, X, Loader2, Pencil } from 'lucide-react';
import { get, post, put, getUserMessage } from '../../api';
import { showToast } from '../Toast';
import { generateAutoSku } from '../../utils/sku';

type Supplier = {
  id: number;
  name: string;
  sku?: string;
  contact_person?: string;
  phone?: string;
  email?: string;
  address?: string;
  notes?: string;
};

export default function SuppliersTab() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null);

  // Form state
  const [formName, setFormName] = useState('');
  const [formSku, setFormSku] = useState('');
  const [formSkuTouched, setFormSkuTouched] = useState(false);
  const [formContact, setFormContact] = useState('');
  const [formPhone, setFormPhone] = useState('');
  const [formEmail, setFormEmail] = useState('');
  const [formAddress, setFormAddress] = useState('');
  const [formNotes, setFormNotes] = useState('');
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetchSuppliers();
  }, []);

  const fetchSuppliers = async () => {
    setLoading(true);
    try {
      const data = await get<{ suppliers: Supplier[] }>('/inventory-advanced/suppliers');
      setSuppliers(data.suppliers || []);
    } catch (e) {
      showToast(getUserMessage(e), 'error');
    } finally {
      setLoading(false);
    }
  };

  const resetForm = () => {
    setFormName('');
    setFormSku('');
    setFormSkuTouched(false);
    setFormContact('');
    setFormPhone('');
    setFormEmail('');
    setFormAddress('');
    setFormNotes('');
    setFormError('');
    setEditingSupplier(null);
  };

  const handleOpenAdd = () => {
    resetForm();
    setShowModal(true);
  };

  const handleOpenEdit = (s: Supplier) => {
    setEditingSupplier(s);
    setFormName(s.name);
    setFormSku(s.sku || '');
    setFormSkuTouched(true);
    setFormContact(s.contact_person || '');
    setFormPhone(s.phone || '');
    setFormEmail(s.email || '');
    setFormAddress(s.address || '');
    setFormNotes(s.notes || '');
    setFormError('');
    setShowModal(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formName.trim()) {
      setFormError('Supplier name is required.');
      return;
    }

    setSubmitting(true);
    setFormError('');
    try {
      const payload = {
        name: formName.trim(),
        sku: formSku.trim() || undefined,
        contact_person: formContact.trim() || undefined,
        phone: formPhone.trim() || undefined,
        email: formEmail.trim() || undefined,
        address: formAddress.trim() || undefined,
        notes: formNotes.trim() || undefined,
      };

      if (editingSupplier) {
        await put(`/inventory-advanced/suppliers/${editingSupplier.id}`, payload);
        showToast('Supplier updated successfully', 'success');
      } else {
        await post('/inventory-advanced/suppliers', payload);
        showToast('Supplier added successfully', 'success');
      }
      setShowModal(false);
      fetchSuppliers();
    } catch (error) {
       setFormError(getUserMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => {
    if (editingSupplier || formSkuTouched) {
      return;
    }
    const nextSku = formName.trim() ? generateAutoSku('SUP', formName, suppliers.map((supplier) => supplier.sku)) : '';
    setFormSku(nextSku);
  }, [editingSupplier, formName, formSkuTouched, suppliers]);



  return (
    <div className="flex flex-col h-full min-h-0 bg-transparent py-4">
      {/* Header Actions */}
      <div className="page-padding flex justify-between items-center bg-transparent shrink-0 pb-4">
        <h3 className="text-xl font-bold text-soot-900 hidden sm:block">Supplier Directory</h3>
        <button
          onClick={handleOpenAdd}
          className="flex items-center gap-2 bg-brand-700 text-white px-4 py-2 rounded-lg font-medium hover:bg-brand-600 touch-target transition-colors ml-auto"
        >
          <Plus className="w-4 h-4" />
          Add supplier
        </button>
      </div>

      {/* Content */}
      <div className="page-padding flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center py-20 text-soot-400 gap-2">
            <Loader2 className="w-5 h-5 animate-spin" /> Loading suppliers...
          </div>
        ) : suppliers.length === 0 ? (
           <div className="text-center py-20 text-soot-400">
             <p className="text-lg font-medium mb-1">No suppliers yet</p>
             <p className="text-sm">Click "Add supplier" to get started.</p>
           </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {suppliers.map(s => (
               <div key={s.id} className="glass-card p-5 relative group flex flex-col justify-between hover:bg-white/40 transition-colors">
                  <div>
                    <h4 className="text-lg font-bold text-soot-900 mb-1 leading-tight">{s.name}</h4>
                    {s.sku && <p className="text-xs font-mono text-soot-500">{s.sku}</p>}
                    {s.contact_person && <p className="text-sm font-medium text-soot-700">{s.contact_person}</p>}
                    
                    <div className="mt-3 space-y-1">
                      {s.phone && <p className="text-sm text-soot-600"><span className="text-soot-400 mr-2">Phone:</span>{s.phone}</p>}
                      {s.email && <p className="text-sm text-soot-600 flex overflow-hidden text-ellipsis"><span className="text-soot-400 mr-2">Email:</span>{s.email}</p>}
                    </div>
                  </div>
                  
                  <div className="absolute top-4 right-4 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={() => handleOpenEdit(s)} className="p-1.5 text-neutral-400 hover:text-brand-600 hover:bg-brand-50 rounded-md">
                      <Pencil className="w-4 h-4" />
                    </button>
                  </div>
               </div>
            ))}
          </div>
        )}
      </div>

      {/* Modal */}
      {showModal && (
         <div className="fixed inset-0 z-50 flex items-center justify-center p-4 glass-overlay overflow-y-auto">
           <div className="glass-floating w-full max-w-lg my-auto flex flex-col max-h-[90vh] overflow-hidden">
             {/* Header */}
             <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-200/60 bg-white/25 shrink-0">
                <h3 className="text-lg font-bold text-neutral-900">{editingSupplier ? 'Edit supplier' : 'Add supplier'}</h3>
                <button onClick={() => setShowModal(false)} className="p-1.5 rounded-lg hover:bg-neutral-200 transition-colors">
                  <X className="w-5 h-5 text-neutral-500" />
                </button>
             </div>

             <form onSubmit={handleSubmit} className="p-6 space-y-4 overflow-y-auto min-h-0 flex-1">
               {formError && (
                 <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-2 text-sm font-medium">
                   {formError}
                 </div>
               )}
               
               <div>
                  <label className="block text-sm font-medium text-neutral-700 mb-1">Company Name <span className="text-red-400">*</span></label>
                  <input type="text" value={formName} onChange={e => setFormName(e.target.value)} className="w-full px-4 py-2.5 glass-card text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none" placeholder="e.g. Sysco Foods" />
               </div>

               <div>
                 <label className="block text-sm font-medium text-neutral-700 mb-1">Supplier SKU</label>
                 <input
                   type="text"
                   value={formSku}
                   onChange={e => {
                     setFormSku(e.target.value);
                     setFormSkuTouched(true);
                   }}
                   className="w-full px-4 py-2.5 glass-card text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none"
                   placeholder="Auto-generated from supplier name"
                 />
                 <p className="text-xs text-neutral-500 mt-1">Auto-generated for new suppliers. You can still edit it.</p>
               </div>

               <div className="grid grid-cols-2 gap-4">
                 <div>
                    <label className="block text-sm font-medium text-neutral-700 mb-1">Contact Person</label>
                    <input type="text" value={formContact} onChange={e => setFormContact(e.target.value)} className="w-full px-4 py-2.5 glass-card text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none" placeholder="e.g. John Doe" />
                 </div>
                 <div>
                    <label className="block text-sm font-medium text-neutral-700 mb-1">Phone</label>
                    <input type="tel" value={formPhone} onChange={e => setFormPhone(e.target.value)} className="w-full px-4 py-2.5 glass-card text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none" placeholder="555-0192" />
                 </div>
               </div>

               <div>
                 <label className="block text-sm font-medium text-neutral-700 mb-1">Email</label>
                 <input type="email" value={formEmail} onChange={e => setFormEmail(e.target.value)} className="w-full px-4 py-2.5 glass-card text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none" placeholder="orders@sysco.com" />
               </div>

               <div>
                 <label className="block text-sm font-medium text-neutral-700 mb-1">Address</label>
                 <textarea value={formAddress} onChange={e => setFormAddress(e.target.value)} className="w-full px-4 py-2.5 glass-card text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none resize-none" rows={2} placeholder="123 Industrial Pkwy" />
               </div>

               <div>
                 <label className="block text-sm font-medium text-neutral-700 mb-1">Notes</label>
                 <textarea value={formNotes} onChange={e => setFormNotes(e.target.value)} className="w-full px-4 py-2.5 glass-card text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none resize-none" rows={2} placeholder="Delivery schedule, preferred terms..." />
               </div>

               <div className="flex gap-3 pt-4">
                 <button type="button" onClick={() => setShowModal(false)} className="flex-1 px-4 py-2.5 border border-neutral-200 rounded-lg text-sm font-medium text-neutral-600 hover:bg-neutral-50 transition-colors">Cancel</button>
                 <button type="submit" disabled={submitting} className="flex-1 px-4 py-2.5 bg-brand-700 text-white rounded-lg text-sm font-medium hover:bg-brand-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 touch-target">
                   {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                   {editingSupplier ? 'Save changes' : 'Add supplier'}
                 </button>
               </div>
             </form>
           </div>
         </div>
      )}
    </div>
  );
}
