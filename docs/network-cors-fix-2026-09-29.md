# iOS business API connection failure — 1.1.1

The deployed API permits Authorization, Content-Type, Idempotency-Key,
If-Match and X-Warehouse-Device. Its preflight response does not permit
X-Request-Id or If-None-Match, even though the local backend source does.
The hot-update workflow publishes web assets, not backend/server.js.

Using real WebKit cross-origin requests against the deployed API:
- Guest session creation succeeds.
- GET /api/stats with Authorization and X-Request-Id fails with Load failed.
- The same GET with Authorization alone succeeds with HTTP 200.
- Adding If-None-Match reproduces Load failed.

Repair: do not add the optional diagnostic request header in fetchApi;
poll /api/sync without conditional ETag headers and compare JSON revisions.
Keep authorization, write idempotency and revision conflict protections.
No production business records were created, edited or deleted for verification.

Validation:
- verify:fast passed: backend 106 passed, 2 existing skips; artifacts 66 passed.
- H5 build passed (existing bundle-size warnings).
- Chromium and WebKit navigation smoke passed.
- Stock form failure/retry regression passed.
- tests/live-api-cors-browser.cjs passed in WebKit and Chromium without API mocks:
  health/guest, stats, products, suppliers, delivery notes, customers, transactions,
  and at least two successful sync polls. No failed business requests.

This proves deployed API compatibility in real browser engines, not a direct
observation of the user's iPhone. Confirm the applied web bundle on the device
before closing any remaining device-specific report.
