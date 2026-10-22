import { afterEach, describe, expect, it } from "bun:test";
import { createServer } from "node:http";
import { createSign, createVerify } from "node:crypto";
import type { AddressInfo, Socket } from "node:net";
import { OfficialAlipayProvider, queryAccountLogPage } from "../src/server/alipay";
import { setSetting, type AppDatabase } from "../src/server/db";
import { configuredDatabase } from "./helpers";

let database: AppDatabase | undefined;
afterEach(() => database?.close());

describe("Alipay query transport cancellation", () => {
  for (const stage of ["headers", "body"] as const) {
    it(`closes an actual SDK connection stalled at ${stage} when the deadline expires`, async () => {
      ({ database } = configuredDatabase());
      const sockets = new Set<Socket>();
      let requestReceived!: () => void;
      let connectionClosed!: () => void;
      const received = new Promise<void>((resolve) => { requestReceived = resolve; });
      const closed = new Promise<void>((resolve) => { connectionClosed = resolve; });
      const server = createServer((_request, response) => {
        if (stage === "body") {
          response.writeHead(200, { "content-type": "application/json" });
          response.write("{");
        }
        requestReceived();
      });
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => { sockets.delete(socket); connectionClosed(); });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const port = (server.address() as AddressInfo).port;
        setSetting(database, "alipay_endpoint", `http://127.0.0.1:${port}`);
        const query = queryAccountLogPage(new OfficialAlipayProvider(database), {
          startTime: "2026-10-22 10:00:00", endTime: "2026-10-22 10:05:00", pageNo: 1, pageSize: 2000,
        }, 1500);
        const failed = expect(query).rejects.toMatchObject({ code: "ALIPAY_QUERY_TIMEOUT" });
        await Promise.race([received, query]);
        await failed;
        await Promise.race([closed, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Timed-out socket remained open")), 1000);
        })]);
        expect(sockets.size).toBe(0);
      } finally {
        clearTimeout(timer);
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve, reject) => server.close((error) => error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve()));
      }
    });
  }

  for (const validSignature of [true, false]) {
    it(`${validSignature ? "accepts signed" : "rejects tampered"} responses while signing requests`, async () => {
      const configured = configuredDatabase();
      database = configured.database;
      let requestVerified = false;
      const server = createServer((request, response) => {
        const authorization = request.headers.authorization ?? "";
        const signatureStart = authorization.lastIndexOf(",sign=");
        const authString = authorization.slice("ALIPAY-SHA256withRSA ".length, signatureStart);
        const signature = authorization.slice(signatureStart + ",sign=".length);
        requestVerified = createVerify("RSA-SHA256")
          .update(`${authString}\nGET\n${request.url}\n\n`)
          .verify(configured.alipay.publicKey, signature, "base64");
        const body = JSON.stringify({ page_no: 1, page_size: 2000, total_size: 1, detail_list: [{ account_log_id: "SIGNED-PAYMENT" }] });
        const timestamp = String(Date.now());
        const nonce = "test-response-nonce";
        const signatureBody = validSignature ? body : "tampered response";
        const responseSignature = createSign("RSA-SHA256")
          .update(`${timestamp}\n${nonce}\n${signatureBody}\n`)
          .sign(configured.alipay.privateKey, "base64");
        response.writeHead(200, {
          "content-type": "application/json", "alipay-timestamp": timestamp,
          "alipay-nonce": nonce, "alipay-signature": responseSignature,
          "alipay-trace-id": "signed-response-trace",
        });
        response.end(body);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        setSetting(database, "alipay_endpoint", `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
        const query = queryAccountLogPage(new OfficialAlipayProvider(database), {
          startTime: "2026-10-22 10:00:00", endTime: "2026-10-22 10:05:00", pageNo: 1, pageSize: 2000,
        }, 1000);
        if (validSignature) {
          const page = await query;
          expect(page.traceId).toBe("signed-response-trace");
          expect(page.details).toEqual([{ account_log_id: "SIGNED-PAYMENT" }]);
        } else {
          await expect(query).rejects.toThrow("支付宝响应验签失败");
        }
        expect(requestVerified).toBe(true);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve()));
      }
    });
  }
});
