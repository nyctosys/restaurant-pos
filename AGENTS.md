## Learned User Preferences
- Prefer modular architecture and clear separation of responsibilities when implementing features.
- When altering a function, trace complete data flow (callers, callees, boundaries, and shared contracts) to avoid regressions.
- Keep unrelated features untouched during scoped feature work; avoid broad collateral refactors.
- Use restaurant-oriented terminology across product UI and API naming instead of clothing-store language.

## Learned Workspace Facts
- The app is being evolved into a restaurant stall POS with variant/modifier-based items, while preserving existing auth/settings/printer and role flows.
- Backend and frontend API paths in this workspace use restaurant naming conventions (`/api/menu-items`, `/api/stock`, `/api/orders`).
- Stock movement reporting is part of the core requirements, including day/week/month/year/custom time filters.
- Local development expects Dockerized PostgreSQL for the backend startup path.
