import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
export async function startFakeDoor({ dir, port = 3511 }) {
  mkdirSync(dir, { recursive: true });
  const token = randomBytes(16).toString("hex");
  writeFileSync(path.join(dir, "token"), token);
  const sock = path.join(dir, "modules.sock");
  rmSync(sock, { force: true });
  const state = {
    on: true,
    emailOn: true,
    mail: [],
    customers: new Map(),
    plans: new Map(),
    subscriptions: new Map(),
    checkouts: new Map(),
    keys: new Map(),
    fingerprints: new Map(),
    calls: [],
  };
  const output = (res, status, value) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };
  const socket = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    if (req.headers.authorization !== `Bearer ${token}`) return output(res, 401, {});
    const input = JSON.parse(body || "{}");
    const key = req.headers["idempotency-key"];
    if (req.url === "/v1/email") {
      if (!state.emailOn) return output(res, 404, { error: "MODULE_OFF" });
      if (!state.mail.some((m) => m.key === key)) state.mail.push({ ...input, key });
      return output(res, 202, { accepted: true });
    }
    if (!state.on) return output(res, 404, { error: "MODULE_OFF" });
    const id = decodeURIComponent(req.url.split("/").at(-1));
    state.calls.push({ id, input, key });
    const cache = String(key);
    const fingerprint = JSON.stringify({ id, input });
    if (key && state.fingerprints.has(cache) && state.fingerprints.get(cache) !== fingerprint)
      return output(res, 409, { error: "IDEMPOTENCY_KEY_REUSED" });
    if (key) state.fingerprints.set(cache, fingerprint);
    if (key && state.keys.has(cache)) return output(res, 200, state.keys.get(cache));
    let answer;
    if (id === "billing.plan.create") {
      state.plans.set(input.planId, input);
      answer = { ...input, status: "active" };
    }
    if (id === "billing.subscription.create") {
      if (!input.planId || input.customerId || !input.customerPhone || !input.authorizationAmount)
        return output(res, 400, { error: "AUTHORIZE_FORM_REQUIRED" });
      const plan = state.plans.get(input.planId);
      if (!plan) return output(res, 400, { error: "PLAN_REQUIRED" });
      answer = {
        subscriptionId: input.subscriptionId,
        customerId: `customer_${input.subscriptionId}`,
        status: "pending",
        recurringAmount: plan.recurringAmount,
        interval: plan.interval,
        intervalCount: 1,
        currentPeriodEnd: new Date(Date.now() + 30 * 86400000).toISOString(),
        authorizationUrl: `http://127.0.0.1:${port}/subscription/${input.subscriptionId}`,
      };
      state.subscriptions.set(input.subscriptionId, answer);
    }
    if (id === "billing.subscription.get") answer = state.subscriptions.get(input.subscriptionId);
    if (id === "billing.subscription.cancel") {
      const s = state.subscriptions.get(input.subscriptionId);
      s.cancelAtPeriodEnd = true;
      answer = { ...s };
    }
    if (id === "billing.subscription.update") {
      const s = state.subscriptions.get(input.subscriptionId);
      s.status = input.action === "pause" ? "paused" : "active";
      answer = { ...s };
    }
    if (id === "billing.transactions.list") {
      const s = state.subscriptions.get(input.subscriptionId);
      answer = {
        results: s?.paid
          ? [
              {
                transactionId: `txn_${s.subscriptionId}`,
                customerId: s.customerId,
                subscriptionId: s.subscriptionId,
                status: "paid",
                total: s.recurringAmount,
              },
            ]
          : [],
      };
    }
    if (id === "payments.checkout.create") {
      const ref = `ref_${randomBytes(8).toString("hex")}`;
      state.checkouts.set(ref, { input, status: "unpaid", payments: [] });
      answer = { ref, checkoutUrl: `http://127.0.0.1:${port}/checkout/${ref}` };
    }
    if (id === "payments.checkout.get") answer = state.checkouts.get(input.ref);
    if (!answer) return output(res, 404, { error: "NOT_FOUND" });
    if (key) state.keys.set(cache, structuredClone(answer));
    output(res, 200, answer);
  });
  await new Promise((r) => socket.listen(sock, r));
  const page = createServer((req, res) => {
    const [, kind, ref] = req.url.split("/");
    if (req.method === "POST") {
      if (kind === "subscription")
        for (const s of state.subscriptions.values())
          if (s.subscriptionId === ref) {
            s.status = "active";
            s.paid = true;
          }
      if (kind === "checkout") {
        const c = state.checkouts.get(ref);
        const line = c.input.lineItems[0];
        c.status = "paid";
        c.payments = [
          {
            ref: `capture_${ref}`,
            status: "captured",
            amount: { amount: line.amount, currency: line.currency.toUpperCase() },
          },
        ];
      }
      res.writeHead(303, { location: "http://127.0.0.1:3510/membership" });
      return res.end();
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      '<h1>Test payment</h1><p>No real money is charged.</p><form method="post"><button>Confirm test payment</button></form>',
    );
  });
  await new Promise((r) => page.listen(port, "127.0.0.1", r));
  state.close = async () => {
    await Promise.all([new Promise((r) => socket.close(r)), new Promise((r) => page.close(r))]);
    rmSync(sock, { force: true });
  };
  return state;
}
