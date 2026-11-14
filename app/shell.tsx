"use client";
import Link from "next/link";
import { type ReactNode, useEffect, useState } from "react";
import { api } from "../lib/pramaan/client";
import { siteName } from "./site";
export type User = { id: string; email: string | null; role: string };
export function Shell({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  useEffect(() => {
    api<{ user: User }>("/api/account/session").then(
      (r) => setUser(r.user),
      () => {},
    );
  }, []);
  return (
    <>
      <header>
        <nav aria-label="Main">
          <Link href="/" className="brand">
            ◒ {siteName}
          </Link>
          <Link href="/">Plans</Link>
          {user && (
            <Link href={user.role === "member" ? "/membership" : "/desk"}>
              {user.role === "member" ? "My membership" : "Front desk"}
            </Link>
          )}
          {user?.role === "owner" && (
            <>
              <Link href="/settings">Manage</Link>
              <Link href="/owner">Owner settings</Link>
            </>
          )}
          {user ? (
            <button
              type="button"
              onClick={async () => {
                await api("/api/account/signout", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: "{}",
                });
                location.assign("/");
              }}
            >
              Sign out
            </button>
          ) : (
            <Link href="/signin">Sign in</Link>
          )}
        </nav>
      </header>
      {children}
      <footer>Common Ground · A little more room to belong.</footer>
    </>
  );
}
