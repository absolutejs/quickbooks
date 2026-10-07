import { expect, test } from "bun:test";
import { billPayload, createQuickBooksClient, type BillInput } from "../src";
const bill: BillInput = {
  vendorId: "56",
  documentNumber: "SYN-001",
  date: "2026-10-07",
  note: "integration-test",
  currency: "USD",
  lines: [{ amount: "26.23", description: "Material", accountId: "7" }],
};
const response = () =>
  Response.json({
    Bill: {
      Id: "151",
      SyncToken: "0",
      TotalAmt: 26.23,
      VendorRef: { value: "56" },
      CurrencyRef: { value: "USD" },
    },
  });
function client(fn: (url: URL, init: RequestInit) => Promise<Response>) {
  return createQuickBooksClient({
    environment: "sandbox",
    realmId: "123",
    accessToken: async () => "never-print-token",
    fetch: ((url, init) => fn(new URL(String(url)), init!)) as typeof fetch,
  });
}
test("bill request binds sandbox realm, stable request ID, and exact line value", async () => {
  const c = client(async (url, init) => {
    expect(url.origin).toBe("https://sandbox-quickbooks.api.intuit.com");
    expect(url.pathname).toBe("/v3/company/123/bill");
    expect(url.searchParams.get("requestid")).toBe("operation-1");
    expect(init.redirect).toBe("error");
    expect(JSON.parse(String(init.body)).Line[0]).toMatchObject({
      Amount: 26.23,
      AccountBasedExpenseLineDetail: { AccountRef: { value: "7" } },
    });
    return response();
  });
  expect(await c.createBill(bill, "operation-1")).toMatchObject({
    id: "151",
    total: 26.23,
    currency: "USD",
  });
});
test("invalid identifiers and nonexact amount never dispatch", async () => {
  let calls = 0;
  const c = client(async () => {
    calls++;
    return response();
  });
  await expect(
    c.createBill({ ...bill, vendorId: "../other" }, "operation-1"),
  ).rejects.toMatchObject({ outcome: "rejected" });
  await expect(
    c.createBill(
      { ...bill, lines: [{ ...bill.lines[0]!, amount: "26.235" }] },
      "operation-1",
    ),
  ).rejects.toMatchObject({ outcome: "rejected" });
  expect(() => billPayload({ ...bill, date: "2026-02-30" })).toThrow();
  expect(calls).toBe(0);
});
test("lost responses and invalid success responses remain uncertain without automatic retry", async () => {
  for (const mode of ["network", "server", "invalid"] as const) {
    let calls = 0;
    const c = client(async () => {
      calls++;
      if (mode === "network") throw new Error("secret response");
      if (mode === "server")
        return new Response("private provider body", { status: 503 });
      return Response.json({ unexpected: true });
    });
    await expect(c.createBill(bill, "operation-1")).rejects.toMatchObject({
      outcome: "unknown",
    });
    expect(calls).toBe(1);
  }
});
test("rejections expose only bounded codes and status, never provider response bodies", async () => {
  const c = client(
    async () => new Response("secret provider error", { status: 400 }),
  );
  try {
    await c.createBill(bill, "operation-1");
    throw new Error("Expected failure");
  } catch (error) {
    expect(error).toMatchObject({
      code: "HTTP_400",
      outcome: "rejected",
      httpStatus: 400,
    });
    expect(JSON.stringify(error)).not.toContain("secret");
  }
});
test("catalogs page explicitly and reject untrusted entity query input", async () => {
  const c = client(async (url) => {
    expect(url.searchParams.get("query")).toBe(
      "select * from Vendor where Active = true startposition 101 maxresults 100",
    );
    return Response.json({
      QueryResponse: {
        Vendor: [{ Id: "2", DisplayName: "Supplier", Active: true }],
      },
    });
  });
  expect(await c.catalog("Vendor", 101)).toEqual({
    records: [{ id: "2", name: "Supplier", active: true }],
    next: null,
  });
  await expect(c.catalog("Vendor", 0)).rejects.toMatchObject({
    code: "INVALID_QUERY",
  });
});
test("oversized success response is uncertain and bounded", async () => {
  const c = client(async () => new Response("x".repeat(2_000_001)));
  await expect(c.createBill(bill, "operation-1")).rejects.toMatchObject({
    code: "INVALID_RESPONSE",
    outcome: "unknown",
  });
});
test("bill status is a read, preserves exact balance and payment references, and rejects absent balances", async () => {
  const state = {
    Id: "151",
    SyncToken: "1",
    TotalAmt: 26.23,
    Balance: 16.23,
    TxnDate: "2026-10-07",
    VendorRef: { value: "56" },
    Line: [
      {
        Amount: 26.23,
        Description: "Material",
        DetailType: "AccountBasedExpenseLineDetail",
        AccountBasedExpenseLineDetail: { AccountRef: { value: "7" } },
      },
    ],
    LinkedTxn: [{ TxnId: "152", TxnType: "BillPaymentCheck" }],
  };
  const c = client(async (url, init) => {
    expect(init.method).toBe("GET");
    expect(url.pathname).toEndWith("/bill/151");
    return Response.json({ Bill: state });
  });
  expect(await c.getBillState("151")).toMatchObject({
    balance: "16.23",
    lines: [{ amount: "26.23", accountId: "7" }],
    linkedTransactions: [{ id: "152", type: "BillPaymentCheck" }],
  });
  for (const balance of [undefined, -1, 1.001]) {
    const bad = client(async () =>
      Response.json({ Bill: { ...state, Balance: balance } }),
    );
    await expect(bad.getBillState("151")).rejects.toMatchObject({
      code: "INVALID_BILL_STATE",
    });
  }
});
