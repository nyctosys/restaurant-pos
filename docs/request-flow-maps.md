# Request-flow maps (Sales Checkout, Auth, Settings)

Maps derived from Axon graph queries and source reads. Frontend uses `API_BASE` (e.g. `/api`) so paths below are relative to that.

---

## 1. Sales Checkout

**User action:** Checkout from Dashboard (cart + payment method + optional discount).

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ FRONTEND                                                                                 │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│ Dashboard.tsx                                                                            │
│   handleCheckout()                                                                       │
│     • Validates cart.length > 0                                                          │
│     • Maps cart → items: { product_id, variant_sku_suffix, quantity }                    │
│     • post('/orders/checkout', { payment_method, items, branch_id, discount })             │
│         ↓                                                                                │
│     api/client.ts  post() → request(path, { method: 'POST', body })                      │
│         • getToken() from localStorage.auth_token                                        │
│         • fetch(API_BASE + path) with Authorization: Bearer <token>                       │
│     • On success: clear cart, set order id, show toast, fetchData()                       │
│     • On error: showToast(getUserMessage(e))                                              │
└─────────────────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        │ POST /api/orders/checkout
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ BACKEND (Flask)                                                                           │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│ app/__init__.py   register_blueprint(sales_bp, url_prefix='/api/orders')                   │
│                                                                                          │
│ routes/sales.py   @sales_bp.route('/checkout', methods=['POST'])                          │
│                   @token_required                                                         │
│                   def checkout(current_user):                                             │
│     • Parse JSON: items, payment_method, branch_id, discount                              │
│     • Validate items (product_id, quantity > 0)                                          │
│     • Branch: non-owner locked to current_user.branch_id; owner can use body branch_id    │
│     • Setting.query (branch/global) → tax_enabled, tax_rates_by_payment_method             │
│     • In transaction:                                                                     │
│         - Sale(branch_id, user_id, payment_method)                                        │
│         - For each item: Product lookup, Inventory check/deduct, SaleItem               │
│         - Apply discount (percent/fixed) → discount_amount, discount_snapshot             │
│         - Commit                                                                          │
│     • PrinterService().print_receipt(receipt_data)  # sync; may fail after commit         │
│     • Return 201 { message, sale_id, total, print_success }                               │
│                                                                                          │
│ utils/auth_decorators.py   token_required → JWT from Authorization, sets g.current_user   │
│ errors.py                 error_response() → JSON 4xx with standard shape                │
└─────────────────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        │ (internal)
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ MODELS & SERVICES                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│ models.py        Sale, SaleItem, Product, Inventory, Setting, Branch, User                 │
│ routes/printer.py  (checkout does not call printer route; it uses service in-process)      │
│ services/printer_service.py  PrinterService.print_receipt(receipt_data)                  │
│                    • Singleton; reads global Setting for hardware (USB VID/PID)           │
│                    • ESC/POS USB; connect → print → disconnect                            │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

**Key files**

| Layer   | File |
|--------|------|
| UI     | `frontend/src/pages/Dashboard.tsx` (handleCheckout) |
| API    | `frontend/src/api/client.ts` (post), `frontend/src/api/errors.ts` (getUserMessage) |
| Route  | `backend/app/routes/sales.py` (checkout) |
| Auth   | `backend/app/utils/auth_decorators.py` (token_required) |
| Models | `backend/app/models.py` (Sale, SaleItem, Product, Inventory, Setting) |
| Print  | `backend/app/services/printer_service.py` (PrinterService.print_receipt) |

---

## 2. Auth (login, setup, guarded routes)

**Flows:** (A) First-time setup, (B) Login, (C) Protected route access (AuthGuard + token).

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ (A) FIRST-TIME SETUP                                                                     │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│ Setup.tsx   handleSubmit()                                                               │
│   → post('/auth/setup', { username, password, branch_name, branch_address?, branch_phone? }) │
│   → On success: localStorage auth_token + user, navigate('/dashboard')                   │
│                                                                                          │
│ Backend  routes/auth.py   POST /api/auth/setup  (no auth)                                 │
│   initial_setup():                                                                       │
│     • If owner exists → 400 "System is already initialized."                              │
│     • Create Branch, then User(role='owner'), commit                                       │
│     • JWT encode { user_id, role, branch_id, exp } → return { token, user }               │
└─────────────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ (B) LOGIN                                                                                │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│ Login.tsx   handleSubmit()                                                                │
│   → post('/auth/login', { username, password })                                          │
│   → On success: localStorage auth_token + user, navigate('/dashboard')                   │
│                                                                                          │
│ Backend  routes/auth.py   POST /api/auth/login  (no auth)                                 │
│   login():                                                                               │
│     • User.query.filter_by(username), check_password_hash                                 │
│     • If archived → 403                                                                   │
│     • JWT encode → return { token, user: { id, username, role, branch_id, branch_name } }│
└─────────────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ (C) PROTECTED ROUTES (AuthGuard)                                                          │
├─────────────────────────────────────────────────────────────────────────┤
│ App.tsx   <Route element={<AuthGuard />}>                                                 │
│             <Route path="/dashboard" element={<Dashboard />} />  ...                       │
│                                                                                          │
│ AuthGuard.tsx   (runs before any protected child route)                                   │
│   checkAuthStatus():                                                                     │
│     1. get('/auth/status')  [skipAuth not needed; no Bearer required]                     │
│        Backend  GET /api/auth/status  → { initialized: bool }  (owner exists?)            │
│     2. If !initialized → <Navigate to="/setup" />                                         │
│     3. If !localStorage.auth_token → <Navigate to="/login" />                             │
│     4. Else → <Outlet /> (render Dashboard / Inventory / etc.)                            │
│                                                                                          │
│ Any subsequent API call from Dashboard/Inventory/Settings/etc.:                            │
│   client.request() adds Authorization: Bearer <token>                                    │
│   Backend  token_required  decodes JWT, sets g.current_user; 401 if invalid/expired       │
│   client: on 401 clears token and redirects to /login                                      │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

**Auth endpoints**

| Path              | Method | Auth  | Handler        | Purpose |
|-------------------|--------|-------|----------------|---------|
| `/api/auth/status`| GET    | No    | check_status   | Is system initialized (owner exists)? |
| `/api/auth/setup` | POST   | No    | initial_setup  | Create first owner + branch. |
| `/api/auth/login` | POST   | No    | login          | Return JWT + user. |

**Key files**

| Layer   | File |
|--------|------|
| Guard  | `frontend/src/components/AuthGuard.tsx` |
| Setup  | `frontend/src/pages/Setup.tsx` |
| Login  | `frontend/src/pages/Login.tsx` |
| Router | `frontend/src/App.tsx` |
| API    | `frontend/src/api/client.ts` (get/post, 401 → clear token + redirect) |
| Backend| `backend/app/routes/auth.py` (check_status, initial_setup, login) |
| JWT    | `backend/app/utils/auth_decorators.py` (token_required) |

---

## 3. Settings (read/update config, test print)

**User action:** Open Settings, switch tabs (General, Receipt, Hardware, Sections, Tax & Rates, Discounts, Users, Branches, App Logs). Load/save per section; test print in Hardware.

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ FRONTEND                                                                                 │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│ Settings.tsx                                                                             │
│   • Role check: non-owner/manager redirect to /dashboard                                  │
│   • Tab-driven fetch on activeTab:                                                       │
│       sections    → fetchSections()   → get(`/settings/?branch_id=${id}`)                │
│       taxrates    → fetchTaxSettings()→ get(`/settings/?branch_id=${id}`)                │
│       hardware    → fetchHardwareSettings() → get('/settings/?global_only=1')            │
│       discounts   → fetchDiscounts() → get(`/settings/?branch_id=${id}`)                │
│   • Save handlers merge current config and PUT:                                          │
│       saveSections(updated)   → get('/settings/') then put('/settings/', { config, branch_id: null }) │
│       saveTaxSettings(...)    → put('/settings/', { config, branch_id })                  │
│       saveHardwareSettings()  → put('/settings/', { config, branch_id: null })           │
│       saveDiscounts(...)      → put('/settings/', payload)                                │
│   • handleTestPrint()       → post('/printer/test-print', {})                             │
│                                                                                          │
│ Sub-components (owner-only tabs):                                                        │
│   UsersSettings.tsx    get('/users/'), post('/users/', ...), patch, del                   │
│   BranchesSettings.tsx get('/branches/'), post('/branches/', ...), patch, del             │
│   ReceiptSettings.tsx  get('/settings/...'), put('/settings/', ...) + logo upload         │
└─────────────────────────────────────────────────────────────────────────────────────────┘
                                        │
          GET/PUT /api/settings/...      │      POST /api/printer/test-print
          GET/POST/PATCH/DELETE          │
          /api/users/, /api/branches/    │
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ BACKEND                                                                                   │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│ routes/settings.py                                                                       │
│   GET  /api/settings/?branch_id=X   @token_required  get_settings(current_user)           │
│     • global_only=1 → return global Setting (branch_id=None) only                        │
│     • Else: branch_id from query or current_user; merge global + branch config             │
│   PUT  /api/settings/               @token_required @owner_required  update_settings()     │
│     • body: { config, branch_id? }; create or update Setting row                         │
│                                                                                          │
│ routes/printer.py                                                                        │
│   POST /api/printer/test-print      @token_required  test_print(current_user)            │
│     • PrinterService().print_receipt({ minimal test payload })                            │
│                                                                                          │
│ routes/users.py      GET/POST/PATCH/DELETE  @token_required / @owner_required            │
│ routes/branches.py   GET/POST/PATCH/DELETE  @token_required / @owner_required             │
└─────────────────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ MODELS                                                                                    │
├─────────────────────────────────────────────────────────────────────────┤
│ Setting  (branch_id nullable = global; else per-branch)  config JSON                      │
│ User, Branch  (for Users/Branches tabs)                                                  │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

**Settings API summary**

| Path                    | Method | Auth           | Purpose |
|-------------------------|--------|----------------|---------|
| `/api/settings/`        | GET    | token_required| Merged config (global + branch); `global_only=1` for hardware. |
| `/api/settings/`       | PUT    | token + owner  | Update config for branch_id or global. |
| `/api/printer/test-print` | POST | token_required | Test receipt print. |

**Key files**

| Layer   | File |
|--------|------|
| Page   | `frontend/src/pages/Settings.tsx` |
| Tabs   | `frontend/src/components/settings/UsersSettings.tsx`, `BranchesSettings.tsx`, `ReceiptSettings.tsx` |
| API    | `frontend/src/api/client.ts` |
| Backend| `backend/app/routes/settings.py`, `printer.py`, `users.py`, `branches.py` |
| Model  | `backend/app/models.py` (Setting, User, Branch) |

---

## Blueprint registration (backend)

All under `backend/app/__init__.py` in `create_app()`:

- `auth_bp`     → `/api/auth`
- `products_bp` → `/api/menu-items`
- `sales_bp`    → `/api/orders`
- `scanner_bp`  → `/api/scanner`
- `settings_bp` → `/api/settings`
- `inventory_bp`→ `/api/stock`
- `users_bp`    → `/api/users`
- `branches_bp` → `/api/branches`
- `printer_bp`  → `/api/printer`

Frontend `API_BASE` must match (e.g. `/api`), so e.g. `post('/orders/checkout', ...)` becomes `POST /api/orders/checkout`.
