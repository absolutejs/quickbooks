# @absolutejs/quickbooks

A typed QuickBooks Online adapter for company information, paginated vendors/accounts/customers, and USD account-based vendor bills. MIT licensed; no application-specific approval or construction workflow.

```ts
import { createQuickBooksClient } from '@absolutejs/quickbooks';

const quickbooks = createQuickBooksClient({
  environment: 'sandbox',
  realmId: 'YOUR_NUMERIC_COMPANY_ID',
  accessToken: async () => obtainAccessToken(),
});
const vendors = await quickbooks.catalog('Vendor');
// Persist a stable operation ID and the intended payload before this call.
const receipt = await quickbooks.createBill({
  vendorId: '56', documentNumber: 'INV-001', date: '2026-10-07',
  currency: 'USD', note: 'Your stable export reference',
  lines: [{ amount: '26.23', description: 'Materials', accountId: '7' }],
}, 'your-stable-operation-id');
```

`company()`, `catalog(entity, start?)`, `reference(entity, id)`, `createBill(input, requestId)` and `getBill(id)` accept an optional final AbortSignal. Catalog pages contain at most 100 records and an explicit `next` offset. Tokens are supplied by the caller, allowing Citra and AbsoluteJS linked-provider grants to manage OAuth independently.

Transport uses fixed Intuit origins, refuses redirects, limits responses to 2 MB, and applies a 20-second request timeout. Errors contain bounded codes, never provider response bodies. No automatic retries occur. A `QuickBooksError` with `outcome: 'unknown'` means a write may have succeeded: persist that state and reconcile against the provider before any new write. Request IDs alone are not a replacement for a durable execution record. Read failures cannot create bills; invalid bill receipts are conservatively classified as unknown.

This initial version supports positive decimal USD expense lines (up to 100), an optional customer reference, and no tax mapping. It does not create payments, authorize users, store credentials, approve invoices, or schedule work. Those policies belong to the host application. Explicitly select sandbox or production; the adapter never infers this from NODE_ENV.

Run `bun install`, `bun run typecheck`, `bun test`, and `bun run build`. Tests use synthetic responses and require no provider credentials.

API reference: https://developer.intuit.com/app/developer/qbo/docs/develop/basic-implementations/basic-billing-implementation

`getBillState(id, signal?)` reads the current balance as a decimal string, bill date, expense lines and linked transaction IDs/types. A zero balance means the bill is settled; it is not proof of a cash payment (credits and adjustments can also settle it). The host application must compare the returned bill with its frozen export, authorize access, and retain observation history. No payment creation API is exposed.
