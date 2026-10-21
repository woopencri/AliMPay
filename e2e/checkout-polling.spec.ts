import { expect, test } from "@playwright/test";
import type { CheckoutData, OrderStatus } from "../src/shared/contracts";

for (const status of ["paid", "late_paid"] as const) {
  test(`checkout automatically displays ${status} while the countdown is running`, async ({ page }) => {
    const now = new Date("2026-10-21T10:00:00.000Z");
    await page.clock.install({ time: new Date(now.getTime() - 60_000) });
    await page.clock.pauseAt(now);
    let paymentStatus: OrderStatus = status === "late_paid" ? "expired" : "pending";
    let requests = 0;
    let navigations = 0;
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations += 1;
    });
    const checkout: CheckoutData = {
      trade_no: "POLLING-TRADE",
      out_trade_no: "POLLING-ORDER",
      name: "Polling regression",
      requested_money: "1.00",
      payable_money: "1.00",
      collection_mode: "business_qr",
      status: paymentStatus,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + (status === "late_paid" ? -1 : 5 * 60_000)).toISOString(),
      monitor_until: new Date(now.getTime() + 10 * 60_000).toISOString(),
      payment_poll_interval_seconds: 5,
      payment_uri: "",
      business_qr_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      checkout_support_message: "",
      return_url: null,
      return_target: null,
    };
    await page.route("**/public-api/checkout/polling-test", async (route) => {
      requests += 1;
      await route.fulfill({ json: { ...checkout, status: paymentStatus }, headers: { "cache-control": "no-store" } });
    });

    await page.goto("/checkout/polling-test");
    await expect(page.getByRole("heading", { name: "¥1.00", exact: true })).toBeVisible();
    const initialRequests = requests;
    const initialNavigations = navigations;
    await page.clock.runFor(2_000);
    if (status === "paid") {
      await expect(page.getByText("剩余 04:58", { exact: true })).toBeVisible();
    } else {
      await expect(page.getByText("已超时，等待付款确认", { exact: true })).toBeVisible();
    }
    expect(requests).toBe(initialRequests);

    paymentStatus = status;
    await page.clock.runFor(3_500);
    await expect(page.getByRole("heading", { name: "已收到 ¥1.00", exact: true })).toBeVisible({ timeout: 2_000 });
    await expect(page.getByText("支付成功", { exact: true })).toBeVisible();
    expect(requests).toBe(initialRequests + 1);
    expect(navigations).toBe(initialNavigations);

    await page.clock.runFor(15_000);
    expect(requests).toBe(initialRequests + 1);
  });
}
