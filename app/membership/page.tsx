"use client";
import { useResource } from "../../lib/pramaan/client";
import { Action, money } from "../parts";
export type Detail = {
  member: { id: string; name: string; code: string; email: string };
  membership: null | {
    id: string;
    status: string;
    status_id: string;
    plan: string;
    starts_at: string;
    renews_at: string;
    cancel_at_end: boolean;
    notice_status: string;
    price: number;
    currency: string;
  };
  visits: { id: string; visited_at: string }[];
  payments?: { id: string; amount: number; currency: string; paid_at: string }[];
  notes?: { id: string; body: string; created_at: string }[];
};
function MemberDetail({ data, reload }: { data: Detail; reload: () => void }) {
  const s = data.membership;
  return (
    <>
      <h2>{data.member.name}</h2>
      <p>
        Member code <strong>{data.member.code}</strong>
      </p>
      {s ? (
        <article>
          <h2>{s.plan}</h2>
          <p>
            {s.status} · {money(s.price, s.currency)}
          </p>
          <p>
            {s.cancel_at_end ? "Access ends" : "Renews / expires"}:{" "}
            {s.renews_at
              ? new Date(s.renews_at).toLocaleDateString("en-GB")
              : "Awaiting billing confirmation"}
          </p>
          <p>
            Email notices:{" "}
            {s.notice_status === "sent" ? "sent" : "queued — email may be switched off"}
          </p>
          <div className="actions">
            {["start", "refresh", "pause", "cancel"].map((a) => (
              <Action key={a} input={{ action: a, memberId: data.member.id }} reload={reload}>
                {a === "start"
                  ? "Continue payment"
                  : a === "refresh"
                    ? "Refresh billing"
                    : a === "pause"
                      ? "Pause membership"
                      : "Cancel at period end"}
              </Action>
            ))}
          </div>
        </article>
      ) : (
        <p>
          No membership yet. <a href="/">Choose a plan</a>.
        </p>
      )}
      <h2>Payments</h2>
      {data.payments?.length ? (
        data.payments.map((p) => (
          <p key={p.id}>
            {money(p.amount, p.currency)} · {new Date(p.paid_at).toLocaleDateString("en-GB")}
          </p>
        ))
      ) : (
        <p>No confirmed payments yet.</p>
      )}
      <h2>Visit history</h2>
      {data.visits.length ? (
        data.visits.map((v) => <p key={v.id}>{new Date(v.visited_at).toLocaleString("en-GB")}</p>)
      ) : (
        <p>Your first visit is still to come.</p>
      )}
    </>
  );
}
export default function Membership() {
  const { data, error, reload } = useResource<Detail>("/api/memberships");
  return (
    <main className="workspace">
      <p className="eyebrow">YOUR LITTLE CORNER</p>
      <h1>My membership</h1>
      {error ? (
        <p role="alert">
          {error.message} <a href="/signin">Sign in</a>.
        </p>
      ) : data?.member ? (
        <MemberDetail data={data} reload={reload} />
      ) : (
        <p>
          Sign in as a member to see your membership. Staff can open{" "}
          <a href="/desk">the front desk</a>.
        </p>
      )}
    </main>
  );
}
