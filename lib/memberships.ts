import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { AccountError, hashPassword, type User } from "./accounts";
import { emailDoor } from "./email";
import { pramaan } from "./pramaan";
import { accountRuntime, database } from "./runtime";

export const fail = (status: number, message: string): never => {
  throw new AccountError(status, message);
};
export function text(v: unknown, max = 120) {
  if (typeof v !== "string" || !v.trim() || v.trim().length > max)
    return fail(400, "Check the information and try again.");
  return v.trim();
}
export function uuid(v: unknown) {
  const s = text(v);
  if (!/^[a-f0-9-]{36}$/i.test(s)) return fail(400, "Choose a record.");
  return s;
}
export function owner(u: User) {
  if (u.role !== "owner") fail(403, "Only the owner can do this.");
}
export function desk(u: User) {
  if (!["owner", "staff"].includes(u.role)) fail(403, "This is for the front desk.");
}
export async function transaction<T>(work: (c: PoolClient) => Promise<T>) {
  const c = await database().connect();
  try {
    await c.query("BEGIN");
    const r = await work(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
export async function memberFor(u: User) {
  if (u.role !== "member") return fail(403, "Sign in as a member to join.");
  // A member row the owner already holds for this email (an import) is linked only once the address is confirmed.
  const held = await database().query("SELECT 1 FROM members WHERE email=$1 AND user_id IS NULL", [
    u.email,
  ]);
  if (held.rowCount && !(await accountRuntime().verifiedEmail(u.id)))
    return fail(403, "Confirm your email address to link the membership we hold for it.");
  const r = await database().query(
    `INSERT INTO members(user_id,name,email) VALUES($1,$2,$3) ON CONFLICT(email) DO UPDATE SET user_id=EXCLUDED.user_id WHERE members.user_id IS NULL OR members.user_id=EXCLUDED.user_id RETURNING *`,
    [u.id, u.email?.split("@")[0], u.email],
  );
  return r.rows[0] ?? fail(403, "This member account cannot be linked.");
}
export async function member(u: User, id: unknown) {
  const r = await database().query(
    "SELECT id,name,email,code,phone FROM members WHERE id=$1 AND ($2::boolean OR user_id=$3)",
    [uuid(id), ["owner", "staff"].includes(u.role), u.id],
  );
  return r.rows[0] ?? fail(404, "Member not found.");
}
export async function plans() {
  return (
    await database().query(
      `SELECT p.*,c.name AS category FROM plans p JOIN plan_categories c ON c.id=p.category_id WHERE available ORDER BY price`,
    )
  ).rows;
}
export async function details(u: User, id: unknown) {
  const m = await member(u, id);
  const r = await database().query(
    `SELECT s.id,s.status_id,t.name AS status,s.starts_at,s.renews_at,s.cancel_at_end,s.notice_status,p.name AS plan,s.price,s.currency FROM memberships s JOIN plans p ON p.id=s.plan_id JOIN membership_statuses t ON t.id=s.status_id WHERE member_id=$1`,
    [m.id],
  );
  const visits = await database().query(
    "SELECT id,visited_at FROM check_ins WHERE member_id=$1 ORDER BY visited_at DESC LIMIT 500",
    [m.id],
  );
  if (u.role === "staff") return { member: m, membership: r.rows[0] ?? null, visits: visits.rows };
  const payments = await database().query(
    "SELECT p.id,p.amount,p.currency,p.paid_at FROM payments p JOIN memberships s ON s.id=p.membership_id WHERE s.member_id=$1 ORDER BY paid_at DESC LIMIT 500",
    [m.id],
  );
  const notes =
    u.role === "owner"
      ? (
          await database().query(
            "SELECT id,body,created_at FROM member_notes WHERE member_id=$1 ORDER BY created_at DESC",
            [m.id],
          )
        ).rows
      : [];
  return {
    member: m,
    membership: r.rows[0] ?? null,
    visits: visits.rows,
    payments: payments.rows,
    notes,
  };
}
export async function lookup(u: User, q: string) {
  desk(u);
  return (
    await database().query(
      `SELECT m.id,m.name,m.code,t.name AS status FROM members m LEFT JOIN memberships s ON s.member_id=m.id LEFT JOIN membership_statuses t ON t.id=s.status_id WHERE m.name ILIKE $1 OR m.code ILIKE $1 ORDER BY m.name LIMIT 100`,
      [`%${q.slice(0, 120)}%`],
    )
  ).rows;
}
export async function checkIn(u: User, id: unknown) {
  desk(u);
  const m = await member(u, id);
  return transaction(async (c) => {
    const r = await c.query("SELECT * FROM memberships WHERE member_id=$1 FOR UPDATE", [m.id]);
    const s = r.rows[0];
    if (!s || s.status_id !== "active" || !s.renews_at || new Date(s.renews_at) <= new Date())
      return fail(409, "Check-in refused: membership is not active.");
    const recent = await c.query(
      "SELECT id FROM check_ins WHERE member_id=$1 AND visited_at>now()-interval '1 minute'",
      [m.id],
    );
    if (recent.rowCount) return fail(409, "Already checked in in the last minute.");
    await c.query("INSERT INTO check_ins(member_id,staff_id) VALUES($1,$2)", [m.id, u.id]);
    return { message: "Checked in. Enjoy your visit." };
  });
}

// The platform connects a test billing account. No request parameter can enable live payments.
async function call<T>(id: string, input: Record<string, unknown>, key?: string): Promise<T> {
  if (process.env.PRAMAAN_PAYMENTS_TEST_MODE !== "true")
    return fail(503, "Test payments are not switched on. Membership access stays unchanged.");
  const r = await pramaan.call<T>(id, input, key);
  if (!r.ok)
    return fail(
      503,
      "Billing is unavailable or awaiting confirmation. Retry the same action; membership access stays unchanged.",
    );
  return r.value;
}
type Subscription = {
  authorizationUrl?: string;
  subscriptionId: string;
  customerId?: string;
  status: string;
  recurringAmount?: { amount: number; currency: string };
  interval?: string;
  intervalCount?: number;
  currentPeriodEnd?: string;
  cancelAtPeriodEnd?: boolean;
};
type Stored = {
  id: string;
  member_id: string;
  price: number;
  currency: string;
  period: string;
  one_off: boolean;
  customer_ref: string;
  billing_ref: string;
  checkout_ref: string;
  checkout_url: string;
  operation_key: string;
  operation_started_at: Date;
  action_started_at: Date;
  action_key: string;
  pending_action: string;
  status_id: string;
  renews_at: Date;
  cancel_at_end: boolean;
};
/** Billing may answer `gbp` where the plan says `GBP`. */
const sameCurrency = (value: unknown, currency: string) =>
  typeof value === "string" && value.toUpperCase() === currency.toUpperCase();
async function notify(c: PoolClient, s: Stored, event: string, subject: string) {
  const m = (await c.query("SELECT email FROM members WHERE id=$1", [s.member_id])).rows[0];
  await c.query(
    "INSERT INTO membership_emails(membership_id,event,email,subject,body) VALUES($1,$2,$3,$4,$4) ON CONFLICT DO NOTHING",
    [s.id, event, m.email, subject],
  );
}
export async function deliverEmails(membershipId?: string) {
  // Rows remain retryable when email is off; ambiguous deliveries keep the same idempotency key.
  return transaction(async (c) => {
    const rows = await c.query(
      "SELECT * FROM membership_emails WHERE status='not-sent' AND ($1::uuid IS NULL OR membership_id=$1) ORDER BY id LIMIT 20 FOR UPDATE SKIP LOCKED",
      [membershipId ?? null],
    );
    for (const r of rows.rows) {
      const sent = await emailDoor.send({ to: r.email, subject: r.subject, text: r.body }, r.id);
      await c.query("UPDATE membership_emails SET status=$2 WHERE id=$1", [r.id, sent.status]);
      await c.query("UPDATE memberships SET notice_status=$2 WHERE id=$1", [
        r.membership_id,
        sent.status,
      ]);
    }
    return { message: "Email delivery checked. Messages stay queued while email is off." };
  });
}
async function recordPayment(c: PoolClient, s: Stored, reference: string, amount: number) {
  const r = await c.query(
    "INSERT INTO payments(membership_id,reference,amount,currency) VALUES($1,$2,$3,$4) ON CONFLICT(reference) DO UPDATE SET reference=EXCLUDED.reference WHERE payments.membership_id=EXCLUDED.membership_id RETURNING id",
    [s.id, reference, amount, s.currency],
  );
  if (!r.rowCount) return fail(502, "This payment could not be matched to this membership.");
}
export async function applySubscription(c: PoolClient, s: Stored, r: Subscription) {
  if (
    r.subscriptionId !== s.billing_ref ||
    (s.customer_ref && r.customerId !== s.customer_ref) ||
    r.recurringAmount?.amount !== s.price ||
    !sameCurrency(r.recurringAmount.currency, s.currency) ||
    r.interval !== s.period ||
    (r.intervalCount ?? 1) !== 1
  )
    return fail(502, "Billing terms could not be confirmed.");
  const end = r.currentPeriodEnd ? new Date(r.currentPeriodEnd) : null;
  if (end && !Number.isFinite(end.getTime()))
    return fail(502, "Billing dates could not be confirmed.");
  const known = [
    "active",
    "paused",
    "past_due",
    "canceled",
    "expired",
    "pending",
    "failed",
    "unknown",
  ];
  let state = known.includes(r.status) ? r.status : "unknown";
  if (state === "failed") state = "past_due";
  if (state === "active" && (!end || end <= new Date())) state = "expired";
  // A confirmed period-end cancellation retains access only until its confirmed end.
  if (r.status === "canceled" && r.cancelAtPeriodEnd && end && end > new Date()) state = "active";
  await c.query("UPDATE memberships SET status_id=$2,renews_at=$3,cancel_at_end=$4 WHERE id=$1", [
    s.id,
    state,
    end,
    r.cancelAtPeriodEnd ?? false,
  ]);
  if (state === "active" && s.status_id !== "active")
    await notify(c, s, "welcome", "Welcome — your membership is active.");
  if (state === "past_due")
    await notify(
      c,
      s,
      `renewal:${end?.toISOString()}`,
      "Your membership renewal failed. Please check your billing account.",
    );
  if (r.cancelAtPeriodEnd || state === "canceled")
    await notify(
      c,
      s,
      `cancel:${end?.toISOString()}`,
      "Your membership cancellation is confirmed. Access ends with your paid period.",
    );
}
export async function join(u: User, planId: unknown) {
  const m = await memberFor(u);
  const id = uuid(planId);
  await transaction(async (c) => {
    await c.query("SELECT id FROM members WHERE id=$1 FOR UPDATE", [m.id]);
    const old = (
      await c.query("SELECT id,plan_id,one_off,renews_at FROM memberships WHERE member_id=$1", [
        m.id,
      ])
    ).rows[0];
    const ended = old?.one_off && old.renews_at && new Date(old.renews_at) <= new Date();
    if (old && !ended) {
      if (old.plan_id !== id)
        return fail(409, "You already have a membership. Manage it before choosing another plan.");
      return;
    }
    const p =
      (await c.query("SELECT * FROM plans WHERE id=$1 AND available FOR SHARE", [id])).rows[0] ??
      fail(404, "Plan not found.");
    // A one-off pass that has run out is replaced by a fresh purchase; its payments stay in the history.
    if (old)
      return c.query(
        "UPDATE memberships SET plan_id=$2,price=$3,currency=$4,period=$5,one_off=$6,status_id='pending',starts_at=now(),renews_at=NULL,cancel_at_end=false,checkout_ref=NULL,checkout_url=NULL,operation_key=gen_random_uuid(),operation_started_at=now() WHERE id=$1",
        [old.id, id, p.price, p.currency, p.period, p.one_off],
      );
    await c.query(
      "INSERT INTO memberships(member_id,plan_id,price,currency,period,one_off) VALUES($1,$2,$3,$4,$5,$6)",
      [m.id, id, p.price, p.currency, p.period, p.one_off],
    );
  });
  return billing(u, m.id, "start");
}
export async function billing(u: User, memberId: unknown, action: string) {
  if (u.role !== "member" && u.role !== "owner")
    return fail(403, "Only the member or owner can manage billing.");
  const m = await member(u, memberId);
  // Session-level advisory lock serializes money operations without rolling back durable references on an unknown result.
  const c = await database().connect();
  let locked = false;
  let deliveryId: string | undefined;
  try {
    await c.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [m.id]);
    locked = true;
    let s = (await c.query("SELECT * FROM memberships WHERE member_id=$1", [m.id]))
      .rows[0] as Stored;
    if (!s) return fail(404, "Membership not found.");
    deliveryId = s.id;
    const p = (
      await c.query(
        "SELECT name FROM plans WHERE id=(SELECT plan_id FROM memberships WHERE id=$1)",
        [s.id],
      )
    ).rows[0];
    if (action === "start" && !s.billing_ref && !s.checkout_ref) {
      if (Date.now() - new Date(s.operation_started_at).getTime() > 23 * 3600000)
        return fail(
          409,
          "This billing attempt needs reconciliation by the owner before it can be retried.",
        );
      if (s.one_off) {
        const r = await call<{ ref: string; checkoutUrl: string }>(
          "payments.checkout.create",
          {
            lineItems: [
              { name: p.name, amount: s.price, currency: s.currency.toLowerCase(), quantity: 1 },
            ],
            mode: "payment",
            customerEmail: m.email,
            successUrl: `${process.env.APP_ORIGIN}/membership`,
            cancelUrl: `${process.env.APP_ORIGIN}/membership`,
          },
          `${s.operation_key}:checkout`,
        );
        if (!r.ref) return fail(502, "Payment could not be confirmed.");

        const url = new URL(r.checkoutUrl);
        if (
          url.protocol !== "https:" &&
          !(
            url.protocol === "http:" &&
            url.hostname === "127.0.0.1" &&
            process.env.PRAMAAN_PAYMENTS_TEST_MODE === "true"
          )
        )
          return fail(502, "Payment link could not be confirmed.");
        await c.query("UPDATE memberships SET checkout_ref=$2,checkout_url=$3 WHERE id=$1", [
          s.id,
          r.ref,
          url.toString(),
        ]);
        return { url: url.toString() };
      }
      if (!m.phone || !/^[0-9]{10,12}$/.test(m.phone))
        return fail(400, "Add your phone number to authorize your membership payment.");
      const planId = `plan_${s.id.replaceAll("-", "")}`;
      await call(
        "billing.plan.create",
        {
          planId,
          name: p.name.slice(0, 40),
          type: "periodic",
          maxAmount: { amount: s.price, currency: s.currency },
          recurringAmount: { amount: s.price, currency: s.currency },
          interval: s.period,
          intervalCount: 1,
        },
        `${s.operation_key}:plan`,
      );
      const r = await call<Subscription>(
        "billing.subscription.create",
        {
          subscriptionId: `sub_${s.id.replaceAll("-", "")}`,
          planId,
          customerEmail: m.email,
          customerPhone: m.phone,
          customerName: m.name.slice(0, 100),
          authorizationAmount: { amount: s.price, currency: s.currency },
          refundAuthorization: false,
          notificationChannels: ["email"],
        },
        `${s.operation_key}:subscription`,
      );
      if (!r.subscriptionId) return fail(502, "Subscription could not be confirmed.");
      let authorizationUrl: string | null = null;
      if (r.authorizationUrl) {
        const url = new URL(r.authorizationUrl);
        if (
          url.protocol !== "https:" &&
          !(
            url.protocol === "http:" &&
            url.hostname === "127.0.0.1" &&
            process.env.PRAMAAN_PAYMENTS_TEST_MODE === "true"
          )
        )
          return fail(502, "Payment link could not be confirmed.");
        authorizationUrl = url.toString();
      }
      await c.query(
        "UPDATE memberships SET billing_ref=$2,customer_ref=$3,checkout_url=$4 WHERE id=$1",
        [s.id, r.subscriptionId, r.customerId ?? null, authorizationUrl],
      );
      s.billing_ref = r.subscriptionId;
    }
    s = (await c.query("SELECT * FROM memberships WHERE id=$1", [s.id])).rows[0];
    if (s.one_off) {
      if (action !== "refresh" && action !== "start")
        return fail(400, "A one-off pass cannot be paused or renewed.");
      const r = await call<{
        status: string;
        payments: { ref: string; status: string; amount?: { amount: number; currency: string } }[];
      }>("payments.checkout.get", { ref: s.checkout_ref });
      const captured =
        r.payments?.filter(
          (p) => p.status === "captured" && p.ref && sameCurrency(p.amount?.currency, s.currency),
        ) ?? [];
      if (
        r.status === "paid" &&
        captured.reduce((n, p) => n + (p.amount?.amount ?? 0), 0) === s.price
      ) {
        await c.query("BEGIN");
        try {
          for (const p of captured) await recordPayment(c, s, p.ref, p.amount?.amount ?? 0);
          await c.query(
            "UPDATE memberships SET status_id='active',starts_at=now(),renews_at=now() + CASE period WHEN 'day' THEN interval '1 day' WHEN 'week' THEN interval '1 week' WHEN 'month' THEN interval '1 month' ELSE interval '1 year' END WHERE id=$1 AND status_id='pending'",
            [s.id],
          );
          await notify(c, s, `welcome:${s.checkout_ref}`, "Welcome — your pass is active.");
          await c.query("COMMIT");
        } catch (e) {
          await c.query("ROLLBACK");
          throw e;
        }
      }
      if (action === "start" && s.status_id === "pending" && s.checkout_url)
        return { url: s.checkout_url };
    } else {
      if (["pause", "cancel"].includes(action)) {
        if (s.pending_action && s.pending_action !== action)
          return fail(409, "Refresh the previous billing action first.");
        if (!s.action_key || !s.pending_action) {
          s.action_key = randomUUID();
          await c.query(
            "UPDATE memberships SET action_key=$2,pending_action=$3,action_started_at=now() WHERE id=$1",
            [s.id, s.action_key, action],
          );
        }
        if (s.pending_action && Date.now() - new Date(s.action_started_at).getTime() > 23 * 3600000)
          return fail(409, "This billing change needs reconciliation before retrying.");
        await call<Subscription>(
          action === "cancel" ? "billing.subscription.cancel" : "billing.subscription.update",
          action === "cancel"
            ? { subscriptionId: s.billing_ref, when: "period_end" }
            : { subscriptionId: s.billing_ref, action: "pause" },
          s.action_key,
        );
      }
      const r = await call<Subscription>("billing.subscription.get", {
        subscriptionId: s.billing_ref,
      });
      const paid = await call<{
        results: {
          transactionId: string;
          customerId?: string;
          subscriptionId?: string;
          status: string;
          total: { amount: number; currency: string };
        }[];
      }>("billing.transactions.list", {
        ...(s.customer_ref ? { customerId: s.customer_ref } : {}),
        subscriptionId: s.billing_ref,
        limit: 50,
      });
      await c.query("BEGIN");
      try {
        await applySubscription(c, s, r);
        for (const payment of paid.results ?? [])
          if (
            (!s.customer_ref || payment.customerId === s.customer_ref) &&
            payment.subscriptionId === s.billing_ref &&
            payment.status === "paid" &&
            sameCurrency(payment.total?.currency, s.currency) &&
            payment.total.amount === s.price
          )
            await recordPayment(c, s, payment.transactionId, payment.total.amount);

        if (
          !s.pending_action ||
          (s.pending_action === "cancel" && r.cancelAtPeriodEnd) ||
          (s.pending_action === "pause" && r.status === "paused")
        )
          await c.query("UPDATE memberships SET pending_action=NULL WHERE id=$1", [s.id]);
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      }
      if (action === "start" && r.status === "pending") {
        if (!s.checkout_url)
          return fail(
            503,
            "Billing has not returned an authorization link. Your membership stays pending.",
          );
        return { url: s.checkout_url };
      }
    }
    return {
      message:
        "Billing checked. Access follows the confirmed billing result. Email notices may be queued.",
    };
  } finally {
    if (locked) await c.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [m.id]);
    c.release();
    if (deliveryId) {
      try {
        await deliverEmails(deliveryId);
      } catch {
        /* Billing is durable; unsent mail remains queued. */
      }
    }
  }
}
export async function addStaff(u: User, input: Record<string, unknown>) {
  owner(u);
  const email = text(input.email, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, "Enter an email address.");
  const password = text(input.password, 128);
  if (password.length < 12) fail(400, "Use a password of at least 12 characters.");
  const hash = await hashPassword(password);
  await database().query(
    "INSERT INTO app_users(id,email,password_hash,role) VALUES($1,$2,$3,'staff')",
    [randomUUID(), email, hash],
  );
  return { message: "Front-desk account added. Share the sign-in details privately." };
}
