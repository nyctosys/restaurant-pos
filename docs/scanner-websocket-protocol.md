# Scanner WebSocket Protocol

Native FastAPI WebSocket endpoint:

- URL: `/api/scanner/ws`
- Direction: server -> client for scan events

## Outbound message

```json
{
  "type": "scan_event",
  "barcode": "ABC-123"
}
```

## Related HTTP webhook

- `POST /api/scanner/webhook`
- Body: `{"barcode":"ABC-123","terminal_ip":"optional"}`
- Behavior: validates payload and broadcasts to connected websocket clients.
