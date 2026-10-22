import { afterEach, describe, expect, it } from "bun:test";
import { PaymentScanner, type AccountLogPage, type AccountLogProvider } from "../src/server/alipay";
import { setSetting, type AppDatabase } from "../src/server/db";
import { createOrder, getOrderById } from "../src/server/orders";
import { configuredDatabase, orderInput } from "./helpers";

class FakeProvider implements AccountLogProvider {
  calls = 0;
  constructor(public details: Array<Record<string, unknown>> = [], private delay = 0) {}
  async query(input: { pageNo: number; pageSize: number }): Promise<AccountLogPage> {
    this.calls += 1;
    if (this.delay) await new Promise((resolve) => setTimeout(resolve, this.delay));
    return { pageNo: input.pageNo, pageSize: input.pageSize, totalSize: this.details.length, traceId: "trace-test", details: this.details };
  }
}

let database: AppDatabase | undefined;
afterEach(() => database?.close());

describe("shared payment scanner", () => {
  it("makes zero upstream calls with no active order", async () => {
    ({ database } = configuredDatabase());
    const provider = new FakeProvider();
    const result = await new PaymentScanner(database, provider).scanNow();
    expect(result.status).toBe("skipped");
    expect(provider.calls).toBe(0);
  });

  it("coalesces many orders into one query and stops after they are paid", async () => {
    ({ database } = configuredDatabase());
    const first = createOrder(database, orderInput(1)).order;
    const second = createOrder(database, orderInput(2)).order;
    const provider = new FakeProvider([
      { account_log_id: "A1", trans_dt: new Date().toISOString(), direction: "收入", trans_amount: "1.00", alipay_order_no: "ALI1" },
      { account_log_id: "A2", trans_dt: new Date().toISOString(), direction: "收入", trans_amount: "1.01", alipay_order_no: "ALI2" },
    ]);
    const scanner = new PaymentScanner(database, provider);
    const result = await scanner.scanNow();
    expect(provider.calls).toBe(1);
    expect(result.matched).toBe(2);
    expect(getOrderById(database, first.id)?.status).toBe("paid");
    expect(getOrderById(database, second.id)?.status).toBe("paid");
    expect((await scanner.scanNow()).status).toBe("skipped");
    expect(provider.calls).toBe(1);
  });

  it("coalesces concurrent refresh requests into one in-flight scan", async () => {
    ({ database } = configuredDatabase());
    createOrder(database, orderInput(1));
    const provider = new FakeProvider([], 20);
    const scanner = new PaymentScanner(database, provider);
    await Promise.all([scanner.scanNow("one"), scanner.scanNow("two"), scanner.scanNow("three")]);
    expect(provider.calls).toBe(1);
  });

  it("applies polling interval changes without restarting the scanner", async () => {
    ({ database } = configuredDatabase());
    const order = createOrder(database, orderInput(1)).order;
    const provider = new FakeProvider();
    const scanner = new PaymentScanner(database, provider);
    await scanner.scanNow();
    (scanner as unknown as { lastCompletedAt: number }).lastCompletedAt = Date.now() - 2_000;

    setSetting(database, "payment_poll_interval_seconds", 3);
    await scanner.ensureFresh(order);
    expect(provider.calls).toBe(1);

    setSetting(database, "payment_poll_interval_seconds", 1);
    await scanner.ensureFresh(order);
    expect(provider.calls).toBe(2);
  });

  it("does not query after the 10-minute monitor deadline", async () => {
    ({ database } = configuredDatabase());
    const order = createOrder(database, orderInput(1)).order;
    database.query("UPDATE orders SET expires_at = ?, monitor_until = ?, status = 'expired' WHERE id = ?").run(
      new Date(Date.now() - 6 * 60_000).toISOString(), new Date(Date.now() - 1).toISOString(), order.id,
    );
    const provider = new FakeProvider();
    expect((await new PaymentScanner(database, provider).scanNow()).status).toBe("skipped");
    expect(provider.calls).toBe(0);
  });
});


function emptyPage(): AccountLogPage {
  return { pageNo: 1, pageSize: 2000, totalSize: 0, details: [], traceId: "recovery-test" };
}

function paymentPage(): AccountLogPage {
  return { ...emptyPage(), totalSize: 1, details: [{
    account_log_id: "RECOVERED-PAYMENT", trans_dt: new Date().toISOString(), direction: "收入",
    trans_amount: "1.00", alipay_order_no: "RECOVERED-ALI",
  }] };
}

describe("scan timeout recovery", () => {
  it("releases a stuck query, aborts it, and matches payment in the next scan", async () => {
    ({ database } = configuredDatabase());
    const order = createOrder(database, orderInput()).order;
    let calls = 0;
    let firstSignal: AbortSignal | undefined;
    const provider: AccountLogProvider = {
      async query(_input, signal) {
        calls += 1;
        if (calls === 1) {
          firstSignal = signal;
          return new Promise(() => {});
        }
        return paymentPage();
      },
    };
    const scanner = new PaymentScanner(database, provider, { queryTimeoutMs: 20 });
    const stuck = scanner.scanNow();
    expect(scanner.scanNow("another caller")).toBe(stuck);
    await expect(stuck).rejects.toMatchObject({ code: "ALIPAY_QUERY_TIMEOUT" });
    expect(firstSignal?.aborted).toBe(true);
    const failed = database.query("SELECT status, finished_at, error FROM scan_runs ORDER BY id DESC LIMIT 1").get() as { status: string; finished_at: string; error: string };
    expect(failed.status).toBe("error");
    expect(failed.finished_at).toBeTruthy();
    expect(failed.error).toContain("超过");
    const audit = database.query("SELECT details_json FROM audit_logs WHERE action = 'payment.scan_failed'").get() as { details_json: string };
    expect(JSON.parse(audit.details_json).code).toBe("ALIPAY_QUERY_TIMEOUT");

    expect((await scanner.scanNow()).matched).toBe(1);
    expect(calls).toBe(2);
    expect(getOrderById(database, order.id)?.status).toBe("paid");
    expect((database.query("SELECT COUNT(*) AS count FROM notification_jobs").get() as { count: number }).count).toBe(1);
  });

  it("ignores a timed-out response without matching orders or unlocking a newer scan", async () => {
    ({ database } = configuredDatabase());
    const order = createOrder(database, orderInput()).order;
    let resolveOld!: (page: AccountLogPage) => void;
    let resolveNew!: (page: AccountLogPage) => void;
    let calls = 0;
    const provider: AccountLogProvider = {
      async query() {
        calls += 1;
        if (calls === 1) return new Promise((resolve) => { resolveOld = resolve; });
        if (calls === 2) return new Promise((resolve) => { resolveNew = resolve; });
        return paymentPage();
      },
    };
    const scanner = new PaymentScanner(database, provider, { queryTimeoutMs: 50 });
    await expect(scanner.scanNow()).rejects.toMatchObject({ code: "ALIPAY_QUERY_TIMEOUT" });
    const newer = scanner.scanNow();
    await Promise.resolve();
    resolveOld(paymentPage());
    await Bun.sleep(0);
    expect(scanner.scanNow()).toBe(newer);
    expect(calls).toBe(2);
    expect(getOrderById(database, order.id)?.status).toBe("pending");
    expect((database.query("SELECT COUNT(*) AS count FROM payment_events").get() as { count: number }).count).toBe(0);
    resolveNew(emptyPage());
    expect((await newer).matched).toBe(0);
    const statuses = database.query("SELECT status FROM scan_runs ORDER BY id").all() as { status: string }[];
    expect(statuses.map((run) => run.status)).toEqual(["error", "success"]);
    expect((await scanner.scanNow()).matched).toBe(1);
  });

  it("bounds the entire paginated scan and preserves progress before a later page hangs", async () => {
    ({ database } = configuredDatabase());
    createOrder(database, orderInput());
    let calls = 0;
    let hungSignal: AbortSignal | undefined;
    const provider: AccountLogProvider = {
      async query(input, signal) {
        calls += 1;
        if (calls === 1) return {
          ...emptyPage(), pageNo: input.pageNo, totalSize: 4000,
          details: Array.from({ length: input.pageSize }, () => ({})),
        };
        if (calls === 2) {
          hungSignal = signal;
          return new Promise(() => {});
        }
        return emptyPage();
      },
    };
    const scanner = new PaymentScanner(database, provider, { queryTimeoutMs: 1000, scanTimeoutMs: 50 });
    await expect(scanner.scanNow()).rejects.toMatchObject({ code: "SCAN_TIMEOUT" });
    expect(hungSignal?.aborted).toBe(true);
    expect(database.query("SELECT status, pages, records FROM scan_runs ORDER BY id DESC LIMIT 1").get())
      .toEqual({ status: "error", pages: 1, records: 2000 });
    expect((await scanner.scanNow()).status).toBe("success");
  });

  it("clears the shared task after a synchronous provider error", async () => {
    ({ database } = configuredDatabase());
    createOrder(database, orderInput());
    let calls = 0;
    const provider: AccountLogProvider = {
      query() {
        calls += 1;
        if (calls === 1) throw new Error("connection failed");
        return Promise.resolve(emptyPage());
      },
    };
    const scanner = new PaymentScanner(database, provider);
    await expect(scanner.scanNow()).rejects.toThrow("connection failed");
    expect((await scanner.scanNow()).status).toBe("success");
  });

  it("marks old running records as interrupted on startup without altering completed records or orders", async () => {
    ({ database } = configuredDatabase());
    const order = createOrder(database, orderInput()).order;
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    database.query("INSERT INTO scan_runs(started_at, status) VALUES (?, 'running')").run(startedAt);
    database.query("INSERT INTO scan_runs(started_at, status, finished_at, matched) VALUES (?, 'success', ?, 1)").run(startedAt, startedAt);
    const scanner = new PaymentScanner(database, new FakeProvider());
    const rows = database.query("SELECT status, finished_at, error, matched FROM scan_runs ORDER BY id").all() as Array<{ status: string; finished_at: string; error: string | null; matched: number }>;
    expect(rows[0]!.status).toBe("error");
    expect(rows[0]!.finished_at).toBeTruthy();
    expect(rows[0]!.error).toContain("SCAN_INTERRUPTED");
    expect(rows[1]).toEqual({ status: "success", finished_at: startedAt, error: null, matched: 1 });
    expect(getOrderById(database, order.id)?.status).toBe("pending");
    expect((await scanner.scanNow()).status).toBe("success");
  });

  it("automatically scans again after a scheduler query hangs", async () => {
    ({ database } = configuredDatabase());
    const order = createOrder(database, orderInput()).order;
    setSetting(database, "payment_poll_interval_seconds", 1);
    let calls = 0;
    let recovered!: () => void;
    const recovery = new Promise<void>((resolve) => { recovered = resolve; });
    const provider: AccountLogProvider = {
      async query() {
        calls += 1;
        if (calls === 1) return new Promise(() => {});
        recovered();
        return paymentPage();
      },
    };
    const scanner = new PaymentScanner(database, provider, { queryTimeoutMs: 20 });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      scanner.start();
      await Promise.race([recovery, new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error("Scheduler did not recover")), 4500);
      })]);
      await Bun.sleep(0);
      expect(getOrderById(database, order.id)?.status).toBe("paid");
      expect(database.query("SELECT status FROM scan_runs ORDER BY id").all()).toEqual([{ status: "error" }, { status: "success" }]);
    } finally {
      scanner.stop();
      clearTimeout(deadline);
    }
  }, 6000);
});
