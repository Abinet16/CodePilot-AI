import type { CurrentUser } from "@codepilot/contracts";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { apiGet } from "@/lib/api";
import "./globals.css";
import { SignOutButton } from "./sign-out-button";

export const metadata: Metadata = {
  title: "CodePilot AI",
  description: "Repository-aware AI coding agent with controlled execution and human review.",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const me = await apiGet<CurrentUser>("/auth/me");

  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <nav>
            <Link href="/" className="brand">
              CodePilot AI
            </Link>
            {me.ok && <Link href="/repositories">Repositories</Link>}
          </nav>
          {me.ok ? (
            <div className="user">
              <span>{me.data.githubLogin}</span>
              <SignOutButton />
            </div>
          ) : (
            <a className="button" href="/api/auth/github/login">
              Sign in with GitHub
            </a>
          )}
        </header>
        <main className="page">{children}</main>
      </body>
    </html>
  );
}
