"use client";
import type { FormEvent, ReactNode } from "react";
import { useState } from "react";
import { api } from "../lib/pramaan/client";
export const money = (amount: number, currency: string) =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(amount / 100);
export function Form({
  children,
  submit,
  label = "Save",
}: {
  children: ReactNode;
  submit: (data: FormData) => Promise<unknown>;
  label?: ReactNode;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const result = (await submit(new FormData(e.currentTarget))) as {
        message?: string;
        url?: string;
      };
      setMessage(result?.message ?? "Saved.");
      if (result?.url) location.assign(result.url);
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={send}>
      {children}
      <button disabled={busy} type="submit">
        {busy ? "Working…" : label}
      </button>
      <p role="status">{message}</p>
    </form>
  );
}
export function post(input: object) {
  return api<{ message?: string; url?: string }>("/api/memberships", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}
export function Action({
  children,
  input,
  reload,
}: {
  children: ReactNode;
  input: object;
  reload?: () => void;
}) {
  return (
    <Form
      label={children}
      submit={async () => {
        const r = await post(input);
        reload?.();
        return r;
      }}
    >
      {null}
    </Form>
  );
}
