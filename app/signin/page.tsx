"use client";
import { api } from "../../lib/pramaan/client";
import { Form } from "../parts";
export default function Signin() {
  const send = (action: string) => async (f: FormData) => {
    await api(`/api/account/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: f.get("email"), password: f.get("password") }),
    });
    if (action === "signup")
      await api("/api/memberships", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "profile", name: f.get("name"), phone: f.get("phone") }),
      });
    location.assign("/membership");
  };
  return (
    <main className="workspace">
      <p className="eyebrow">WELCOME TO COMMON GROUND</p>
      <h1>Come on in.</h1>
      <div className="cards">
        <section>
          <h2>Sign in</h2>
          <Form label="Sign in" submit={send("signin")}>
            <label>
              Email
              <input required type="email" name="email" autoComplete="email" />
            </label>
            <label>
              Password
              <input required type="password" name="password" autoComplete="current-password" />
            </label>
          </Form>
        </section>
        <section>
          <h2>Become a member</h2>
          <p>
            Create an account, then choose your plan. Access begins after billing confirms your
            membership.
          </p>
          <Form label="Create account" submit={send("signup")}>
            <label>
              Phone number
              <input name="phone" type="tel" required pattern="[0-9]{10,12}" autoComplete="tel" />
            </label>
            <label>
              Your name
              <input name="name" required maxLength={120} autoComplete="name" />
            </label>
            <label>
              Email
              <input required type="email" name="email" autoComplete="email" />
            </label>
            <label>
              Password
              <input
                required
                minLength={12}
                type="password"
                name="password"
                autoComplete="new-password"
              />
            </label>
          </Form>
        </section>
      </div>
    </main>
  );
}
