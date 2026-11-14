"use client";
import Link from "next/link";
import { useResource } from "../lib/pramaan/client";
import { Action, money } from "./parts";

type Plan = {
  id: string;
  name: string;
  price: number;
  currency: string;
  period: string;
  one_off: boolean;
  perks: string;
  category: string;
};
export default function Plans() {
  const { data, error } = useResource<{ plans: Plan[] }>("/api/memberships?view=plans");
  return (
    <main className="workspace">
      <p className="eyebrow">THE SPACE IS BETTER WITH YOU IN IT</p>
      <h1>
        Find your rhythm.
        <br />
        Make yourself at home.
      </h1>
      <p className="lede">
        A place to move, meet and feel part of something. Choose the membership that fits your
        everyday.
      </p>
      <div className="links">
        <Link href="/signin">Join the community ↗</Link>
        <span>Flexible plans. A warm welcome.</span>
      </div>
      <section className="cards" aria-label="Membership plans">
        {data?.plans.map((p) => (
          <article key={p.id}>
            <p className="eyebrow">
              {p.category} / {p.one_off ? "DROP IN" : "MAKE IT A HABIT"}
            </p>
            <h2>{p.name}</h2>
            <p className="price">
              {money(p.price, p.currency)}
              <small> / {p.period}</small>
            </p>
            <p>{p.perks}</p>
            <Action input={{ action: "join", planId: p.id }}>Choose {p.name}</Action>
            <p className="muted">Sign in first to join. Payments run in test mode.</p>
          </article>
        ))}
      </section>
      {error && <p role="alert">{error.message}</p>}
      <section className="banner">
        <h2>Your people. Your pace.</h2>
        <p>Already part of the club? Your membership, payments and visits are all in one place.</p>
        <Link href="/membership">Go to my membership →</Link>
      </section>
    </main>
  );
}
