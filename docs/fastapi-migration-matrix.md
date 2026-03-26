# Flask to FastAPI Route Matrix

This matrix captures the current Flask API surface and the intended FastAPI target surface.
All paths remain unchanged.

## Global

- Error envelope (target default for handled errors): `{"error": string, "message": string, "details"?: any}`
- Auth header: `Authorization: Bearer <token>`
- Request ID header: `X-Request-ID`

## Auth (`/api/auth`)

| Flask Handler | Method + Path | Auth | Current Response | FastAPI Target |
|---|---|---|---|---|
| `check_status` | `GET /status` | No | `200 {"initialized": boolean}` | Same |
| `initial_setup` | `POST /setup` | No | `201` success + token/user; `400` initialized/missing fields; `500` setup failure | Same shape/status |
| `login` | `POST /login` | No | `200` token/user; `400` missing credentials; `401` invalid credentials; `403` archived account | Same |
| `get_branches` | `GET /branches` | No | `200 {"branches":[...]}` | Same |

## Settings (`/api/settings`)

| Flask Handler | Method + Path | Auth | Current Response | FastAPI Target |
|---|---|---|---|---|
| `get_settings` | `GET /` | Token | `200 {"config": {...}}` | Same |
| `update_settings` | `POST|PUT /` | Token + Owner | `200 {"message","config"}`; `400`; `500` | Same |

## Products (`/api/menu-items`)

| Flask Handler | Method + Path | Auth | Current Response | FastAPI Target |
|---|---|---|---|---|
| `get_products` | `GET /` | Token | `200 {"products":[...]}` | Same |
| `create_product` | `POST /` | Token + Owner | `201 {"message","id"}`; `400`; `409`; `500` | Same |
| `update_product` | `PUT /{product_id}` | Token + Owner | `200 {"message"}`; `400`; `404`; `409`; `500` | Same |
| `archive_product` | `PATCH /{product_id}/archive` | Token + Owner | `200 {"message","archived_at"}`; `500` | Same |
| `unarchive_product` | `PATCH /{product_id}/unarchive` | Token + Owner | `200 {"message"}`; `500` | Same |
| `delete_product` | `DELETE /{product_id}` | Token + Owner | `200 {"message","related_deleted","related_kept"}`; `500` | Same |

## Inventory (`/api/stock`)

| Flask Handler | Method + Path | Auth | Current Response | FastAPI Target |
|---|---|---|---|---|
| `get_inventory` | `GET /` | Token | `200 {"inventory": {product_id: {variant: stock}}}` | Same |
| `update_inventory` | `POST /update` | Token | `200 {"message","stock_level"}`; `400`; `500` | Same |
| `get_stock_transactions` | `GET /transactions` | Token | `200 {"transactions":[...]}` | Same |

## Sales (`/api/orders`)

| Flask Handler | Method + Path | Auth | Current Response | FastAPI Target |
|---|---|---|---|---|
| `checkout` | `POST /checkout` | Token | `201 {"message","sale_id","total","print_success"}`; validation `400` | Same business behavior |
| `get_sales` | `GET /` | Token | `200 {"sales":[...]}` | Same |
| `get_analytics` | `GET /analytics` | Token | `200 {"total_sales","total_transactions","most_selling_product"}` | Same |
| `get_sale_details` | `GET /{sale_id}` | Token | `200 {sale details}`; `403` | Same |
| `rollback_sale` | `POST /{sale_id}/rollback` | Token | `200 {"message"}`; `400`; `403`; `500` | Same |
| `archive_sale` | `PATCH /{sale_id}/archive` | Token | `200 {"message","archived_at"}` | Same |
| `unarchive_sale` | `PATCH /{sale_id}/unarchive` | Token | `200 {"message"}` | Same |
| `delete_sale_permanent` | `DELETE /{sale_id}` | Token + Owner | `200 {"message","related_deleted"}` | Same |
| `print_sale` | `POST /{sale_id}/print` | Token | `200 {"message"}` or `503 {"message"}` | Same |

## Users (`/api/users`)

| Flask Handler | Method + Path | Auth | Current Response | FastAPI Target |
|---|---|---|---|---|
| `get_users` | `GET /` | Token + Owner | `200 [users]` | Same |
| `create_user` | `POST /` | Token + Owner | `201 {"message","user"}` | Same |
| `update_user` | `PUT /{user_id}` | Token + Owner | `200 {"message"}`; `400`; `404`; `500` | Same |
| `archive_user` | `PATCH /{user_id}/archive` | Token + Owner | `200 {"message","archived_at"}` | Same |
| `unarchive_user` | `PATCH /{user_id}/unarchive` | Token + Owner | `200 {"message"}` | Same |
| `delete_user` | `DELETE /{user_id}` | Token + Owner | `200 {"message"}`; `409` on sales | Same |

## Branches (`/api/branches`)

| Flask Handler | Method + Path | Auth | Current Response | FastAPI Target |
|---|---|---|---|---|
| `get_branches` | `GET /` | Token | `200 [branches]` | Same |
| `create_branch` | `POST /` | Token + Owner | `201 branch + message` | Same |
| `update_branch` | `PUT /{branch_id}` | Token + Owner | `200 branch + message` | Same |
| `archive_branch` | `PATCH /{branch_id}/archive` | Token + Owner | `200 {"message","archived_at"}` | Same |
| `unarchive_branch` | `PATCH /{branch_id}/unarchive` | Token + Owner | `200 {"message"}` | Same |
| `delete_branch` | `DELETE /{branch_id}` | Token + Owner | `200` or `409` depending cascade/constraints | Same |
| `get_branch_users` | `GET /{branch_id}/users` | Token + Owner | `200 [users]` | Same |

## Printer (`/api/printer`)

| Flask Handler | Method + Path | Auth | Current Response | FastAPI Target |
|---|---|---|---|---|
| `printer_status` | `GET /status` | Token | `200 {"status","message"}` | Same |
| `test_print` | `POST /test-print` | Token | `200` success, `503` unavailable, `500` exception | Same |
| `print_receipt` | `POST /print-receipt` | Token | `200`/`503`/`500` | Same |
| `print_barcode_label` | `POST /print-barcode-label` | Token | `200`/`503`/`500` | Same |

## Scanner (`/api/scanner`)

| Flask Handler | Method + Path | Auth | Current Response | FastAPI Target |
|---|---|---|---|---|
| `receive_scan` | `POST /webhook` | No | `200 {"status","barcode"}`; `400` invalid payload | Same + WS broadcast |
| `lookup_barcode` | `GET /lookup/{barcode}` | No | `200 {"found":true,"product":...}`; `404 {"found":false,...}` | Same |

## Health

| Flask Handler | Method + Path | Auth | Current Response | FastAPI Target |
|---|---|---|---|---|
| `health_check` | `GET /api/health` | No | `200 {"status":"healthy"}` | Same |
