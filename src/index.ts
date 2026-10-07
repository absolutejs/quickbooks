export type QuickBooksEnvironment = "sandbox" | "production";
export type CatalogEntity = "Vendor" | "Account" | "Customer";
export type CatalogRecord = {
  id: string;
  name: string;
  active: boolean;
  accountType?: string;
  currency?: string;
};
export type BillInput = {
  vendorId: string;
  documentNumber: string;
  date: string;
  dueDate?: string;
  note: string;
  currency: "USD";
  lines: {
    amount: string;
    description: string;
    accountId: string;
    customerId?: string;
  }[];
};
export type BillReceipt = {
  id: string;
  syncToken: string;
  total: number;
  currency?: string;
  documentNumber?: string;
  note?: string;
  vendorId: string;
};
export type BillState = BillReceipt & {
  balance: string;
  date: string;
  lines: BillInput["lines"];
  linkedTransactions: { id: string; type: string }[];
};
const money = (value: unknown): string => {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value >= 1e12 ||
    Number(value.toFixed(2)) !== value
  )
    throw new Error("INVALID_MONEY");
  return value.toFixed(2);
};
export class QuickBooksError extends Error {
  constructor(
    readonly code: string,
    readonly outcome: "rejected" | "unknown",
    readonly httpStatus?: number,
  ) {
    super(code);
    this.name = "QuickBooksError";
  }
}
const record = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error("INVALID_RESPONSE");
  return v as Record<string, unknown>;
};
const id = (v: string) => {
  if (!/^[0-9]{1,30}$/.test(v))
    throw new QuickBooksError("INVALID_IDENTIFIER", "rejected");
  return v;
};
const string = (v: unknown) => {
  if (typeof v !== "string") throw new Error("INVALID_RESPONSE");
  return v;
};
const date = (value: string) => {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    throw new QuickBooksError("INVALID_DATE", "rejected");
  return value;
};
export function billPayload(input: BillInput) {
  if (
    input.currency !== "USD" ||
    !input.documentNumber.trim() ||
    input.documentNumber.length > 21 ||
    input.note.length > 4000 ||
    !input.lines.length ||
    input.lines.length > 100
  )
    throw new QuickBooksError("INVALID_BILL", "rejected");
  return {
    VendorRef: { value: id(input.vendorId) },
    CurrencyRef: { value: input.currency },
    DocNumber: input.documentNumber,
    TxnDate: date(input.date),
    ...(input.dueDate ? { DueDate: date(input.dueDate) } : {}),
    PrivateNote: input.note,
    Line: input.lines.map((line) => {
      const amount = Number(line.amount);
      if (
        !/^\d{1,12}\.\d{2}$/.test(line.amount) ||
        amount <= 0 ||
        amount.toFixed(2) !== line.amount ||
        line.description.length > 4000
      )
        throw new QuickBooksError("INVALID_AMOUNT_OR_DESCRIPTION", "rejected");
      return {
        Amount: amount,
        Description: line.description,
        DetailType: "AccountBasedExpenseLineDetail",
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: id(line.accountId) },
          ...(line.customerId
            ? {
                CustomerRef: { value: id(line.customerId) },
                BillableStatus: "NotBillable",
              }
            : {}),
        },
      };
    }),
  };
}
export function createQuickBooksClient(options: {
  environment: QuickBooksEnvironment;
  realmId: string;
  accessToken: () => Promise<string>;
  fetch?: typeof globalThis.fetch;
}) {
  if (!["sandbox", "production"].includes(options.environment))
    throw new QuickBooksError("INVALID_ENVIRONMENT", "rejected");
  const base = `https://${options.environment === "sandbox" ? "sandbox-" : ""}quickbooks.api.intuit.com/v3/company/${id(options.realmId)}/`;
  const request = async (
    path: string,
    query: Record<string, string>,
    body?: unknown,
    signal?: AbortSignal,
  ) => {
    const url = new URL(path, base);
    for (const [key, value] of Object.entries(query))
      url.searchParams.set(key, value);
    const token = await options.accessToken();
    if (!token || /[\r\n]/.test(token))
      throw new QuickBooksError("CREDENTIAL_UNAVAILABLE", "rejected");
    const combined = AbortSignal.any([
      AbortSignal.timeout(20000),
      ...(signal ? [signal] : []),
    ]);
    combined.throwIfAborted();
    let response: Response;
    try {
      response = await (options.fetch ?? globalThis.fetch)(url, {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        signal: combined,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new QuickBooksError(
        "TRANSPORT_FAILED",
        body === undefined ? "rejected" : "unknown",
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new QuickBooksError(
        `HTTP_${response.status}`,
        body !== undefined &&
          (response.status >= 500 || response.status === 408)
          ? "unknown"
          : "rejected",
        response.status,
      );
    }
    try {
      const reader = response.body?.getReader();
      if (!reader) throw new Error("EMPTY_RESPONSE");
      let size = 0;
      const chunks: Uint8Array[] = [];
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 2_000_000) {
          await reader.cancel();
          throw new Error("RESPONSE_LIMIT");
        }
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return record(JSON.parse(new TextDecoder().decode(bytes)));
    } catch {
      throw new QuickBooksError(
        "INVALID_RESPONSE",
        body === undefined ? "rejected" : "unknown",
      );
    }
  };
  const receipt = (data: Record<string, unknown>): BillReceipt => {
    try {
      const b = record(data.Bill);
      if (typeof b.TotalAmt !== "number" || !Number.isFinite(b.TotalAmt))
        throw new Error();
      return {
        id: id(string(b.Id)),
        syncToken: string(b.SyncToken),
        total: b.TotalAmt,
        vendorId: id(string(record(b.VendorRef).value)),
        ...(b.CurrencyRef
          ? { currency: string(record(b.CurrencyRef).value) }
          : {}),
        ...(typeof b.DocNumber === "string"
          ? { documentNumber: b.DocNumber }
          : {}),
        ...(typeof b.PrivateNote === "string" ? { note: b.PrivateNote } : {}),
      };
    } catch {
      throw new QuickBooksError("INVALID_BILL_RESPONSE", "unknown");
    }
  };
  return {
    company: async (signal?: AbortSignal) => {
      const data = await request(
        `companyinfo/${id(options.realmId)}`,
        {},
        undefined,
        signal,
      );
      try {
        const c = record(data.CompanyInfo);
        return {
          id: id(string(c.Id)),
          name: string(c.CompanyName),
          country: string(c.Country),
        };
      } catch {
        throw new QuickBooksError("INVALID_COMPANY_RESPONSE", "rejected");
      }
    },
    catalog: async (entity: CatalogEntity, start = 1, signal?: AbortSignal) => {
      if (
        !["Vendor", "Account", "Customer"].includes(entity) ||
        !Number.isSafeInteger(start) ||
        start < 1 ||
        start > 100000
      )
        throw new QuickBooksError("INVALID_QUERY", "rejected");
      const data = await request(
        "query",
        {
          query: `select * from ${entity} where Active = true startposition ${start} maxresults 100`,
        },
        undefined,
        signal,
      );
      try {
        const values = record(data.QueryResponse)[entity] ?? [];
        if (!Array.isArray(values) || values.length > 100) throw new Error();
        const records: CatalogRecord[] = values.map((value) => {
          const r = record(value);
          return {
            id: id(string(r.Id)),
            name: string(entity === "Account" ? r.Name : r.DisplayName),
            active: r.Active === true,
            ...(typeof r.AccountType === "string"
              ? { accountType: r.AccountType }
              : {}),
            ...(r.CurrencyRef
              ? { currency: string(record(r.CurrencyRef).value) }
              : {}),
          };
        });
        return { records, next: records.length === 100 ? start + 100 : null };
      } catch {
        throw new QuickBooksError("INVALID_CATALOG_RESPONSE", "rejected");
      }
    },
    reference: async (
      entity: CatalogEntity,
      referenceId: string,
      signal?: AbortSignal,
    ): Promise<CatalogRecord> => {
      if (!["Vendor", "Account", "Customer"].includes(entity))
        throw new QuickBooksError("INVALID_QUERY", "rejected");
      const data = await request(
        `${entity.toLowerCase()}/${id(referenceId)}`,
        {},
        undefined,
        signal,
      );
      try {
        const r = record(data[entity]);
        return {
          id: id(string(r.Id)),
          name: string(entity === "Account" ? r.Name : r.DisplayName),
          active: r.Active === true,
          ...(typeof r.AccountType === "string"
            ? { accountType: r.AccountType }
            : {}),
          ...(r.CurrencyRef
            ? { currency: string(record(r.CurrencyRef).value) }
            : {}),
        };
      } catch {
        throw new QuickBooksError("INVALID_REFERENCE_RESPONSE", "rejected");
      }
    },
    createBill: async (
      input: BillInput,
      requestId: string,
      signal?: AbortSignal,
    ) => {
      if (!/^[a-zA-Z0-9-]{1,50}$/.test(requestId))
        throw new QuickBooksError("INVALID_REQUEST_ID", "rejected");
      return receipt(
        await request(
          "bill",
          { requestid: requestId },
          billPayload(input),
          signal,
        ),
      );
    },
    getBillState: async (
      billId: string,
      signal?: AbortSignal,
    ): Promise<BillState> => {
      const data = await request(`bill/${id(billId)}`, {}, undefined, signal);
      try {
        const b = record(data.Bill),
          baseReceipt = receipt(data);
        if (
          baseReceipt.id !== billId ||
          !Array.isArray(b.Line) ||
          b.Line.length > 100
        )
          throw new Error();
        const lines = b.Line.map((value) => {
          const line = record(value);
          if (line.DetailType !== "AccountBasedExpenseLineDetail")
            throw new Error();
          const detail = record(line.AccountBasedExpenseLineDetail);
          return {
            amount: money(line.Amount),
            description:
              typeof line.Description === "string" ? line.Description : "",
            accountId: id(string(record(detail.AccountRef).value)),
            ...(detail.CustomerRef
              ? { customerId: id(string(record(detail.CustomerRef).value)) }
              : {}),
          };
        });
        const linked = b.LinkedTxn ?? [];
        if (!Array.isArray(linked) || linked.length > 1000) throw new Error();
        return {
          ...baseReceipt,
          balance: money(b.Balance),
          date: date(string(b.TxnDate)),
          lines,
          linkedTransactions: linked.map((value) => {
            const link = record(value);
            const type = string(link.TxnType);
            if (type.length > 80) throw new Error();
            return { id: id(string(link.TxnId)), type };
          }),
        };
      } catch {
        throw new QuickBooksError("INVALID_BILL_STATE", "rejected");
      }
    },
    getBill: async (billId: string, signal?: AbortSignal) =>
      receipt(await request(`bill/${id(billId)}`, {}, undefined, signal)),
  };
}
