"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, ApiClientError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";

export default function LoginPage() {
  const router = useRouter();
  const { refresh } = useAuth();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (mode === "login") {
        await apiFetch("/api/v1/auth/login", {
          method: "POST",
          body: JSON.stringify({ email, password }),
        });
      } else {
        await apiFetch("/api/v1/auth/register", {
          method: "POST",
          body: JSON.stringify({
            email,
            password,
            name,
            organizationName: organizationName || undefined,
          }),
        });
      }
      await refresh();
      router.replace("/dashboard");
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(err.message);
      } else {
        setError("Something went wrong. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold text-brand-700">AdstrackIO</h1>
          <p className="mt-1 text-sm text-slate-500">Performance marketing attribution platform</p>
        </div>

        <div className="card p-6">
          <div className="mb-6 flex rounded-lg bg-slate-100 p-1 text-sm font-medium">
            <button
              type="button"
              onClick={() => setMode("login")}
              className={`flex-1 rounded-md py-1.5 transition ${
                mode === "login" ? "bg-white shadow-sm" : "text-slate-500"
              }`}
            >
              Sign in
            </button>
            <button
              type="button"
              onClick={() => setMode("register")}
              className={`flex-1 rounded-md py-1.5 transition ${
                mode === "register" ? "bg-white shadow-sm" : "text-slate-500"
              }`}
            >
              Create account
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === "register" && (
              <div>
                <label className="label" htmlFor="name">
                  Full name
                </label>
                <input
                  id="name"
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
            )}

            <div>
              <label className="label" htmlFor="email">
                Email
              </label>
              <input
                id="email"
                type="email"
                className="input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>

            <div>
              <label className="label" htmlFor="password">
                Password
              </label>
              <input
                id="password"
                type="password"
                className="input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={mode === "register" ? 10 : undefined}
              />
            </div>

            {mode === "register" && (
              <div>
                <label className="label" htmlFor="organizationName">
                  Organization name (optional)
                </label>
                <input
                  id="organizationName"
                  className="input"
                  value={organizationName}
                  onChange={(e) => setOrganizationName(e.target.value)}
                  placeholder="Acme Media"
                />
              </div>
            )}

            {error && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
            )}

            <button type="submit" className="btn-primary w-full" disabled={submitting}>
              {submitting ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
