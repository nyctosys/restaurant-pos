## Learned User Preferences
- Prefer modular architecture and clear separation of responsibilities when implementing features.
- When altering a function, trace complete data flow (callers, callees, boundaries, and shared contracts) to avoid regressions.
- Keep unrelated features untouched during scoped feature work; avoid broad collateral refactors.
- Use restaurant-oriented terminology across product UI and API naming instead of clothing-store language.
- Prefer iPad landscape and tablet-first layouts as the primary baseline; treat desktop as a deliberate density variant, not a stretched tablet UI.
- Prefer liquid glass (glassmorphism) styling with contrast-safe text and readable surfaces across the app (including kitchen/KDS); keep blur and transparency performance-conscious.
- Prefer food-forward warm UI accents (terracotta, paprika, gold family) rather than generic green as the primary brand feel.
- Prefer clear focus-visible affordances and touch-sized targets on glass layouts and smaller viewports.

## Learned Workspace Facts
- The app is being evolved into a restaurant stall POS with variant/modifier-based items, while preserving existing auth/settings/printer and role flows.
- Backend and frontend API paths in this workspace use restaurant naming conventions (`/api/menu-items`, `/api/stock`, `/api/orders`).
- Stock movement reporting is part of the core requirements, including day/week/month/year/custom time filters.
- Local development expects Dockerized PostgreSQL for the backend startup path.
- Printed receipts include order type (takeaway, dine-in, or delivery) on the ticket.
- Dine-in flows use registered tables in settings, KOT generation for the kitchen, an active dine-in orders view, optional KDS kitchen display on a kitchen-only full-screen `/kitchen` route (kitchen role, not part of the POS nav), and open-tab handling before payment.
- Agents may use Axon MCP for codebase exploration and Google Stitch MCP for UI or design-system inspiration when the user requests those tools.
