# Frontend tests

- **api-client.test.ts** – `ApiError`, `getUserMessage`, `isApiError` (error shape and helpers).
- **api-request.test.ts** – `request`/`get`/`post`: auth header, 400/500/network errors, success JSON (bad scenarios).
- **ErrorBoundary.test.tsx** – Renders children when no error; shows error UI when child throws.

Run: `npm run test` (watch) or `npm run test:run` (single run).
