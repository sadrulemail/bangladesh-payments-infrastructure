import { type FormEvent, useState } from "react";

import { Brand } from "../components/layout";
import { Button, Field, Input } from "../components/ui";
import { describeError } from "../lib/api";
import { useApi } from "../lib/hooks";
import { ROLE_LABELS, useSession } from "../lib/session";
import type { OperatorProfile } from "../lib/types";

const PILLARS = [
  ["Tokenised taka", "One unit is one poisha, issued against a reserve statement and redeemable at par."],
  [
    "One switch for every institution",
    "Banks, mobile money and merchants settle with each other in a single transaction.",
  ],
  ["Remittance corridors", "Exchange houses pay beneficiaries directly, with the cash incentive added on chain."],
  ["Books that reconcile", "Every movement posts to a double-entry ledger that is checked against the chain."],
];

export function SignInPage() {
  const { signIn } = useSession();
  // The directory exists only in private environments; without it the operator types a username.
  const profiles = useApi<OperatorProfile[]>("/v1/auth/profiles");
  const [username, setUsername] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(username.trim(), passphrase);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <section className="flex flex-col justify-between bg-brand px-10 py-10 text-white">
        <Brand inverse />
        <div>
          <h1 className="max-w-md text-3xl leading-tight font-semibold tracking-tight">
            Payments and financial infrastructure for Bangladesh
          </h1>
          <ul className="mt-8 max-w-md space-y-4">
            {PILLARS.map(([title, text]) => (
              <li key={title}>
                <div className="text-sm font-semibold">{title}</div>
                <div className="text-sm text-white/75">{text}</div>
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-white/60">Operations console</p>
      </section>

      <section className="flex items-center justify-center px-6 py-10">
        <form onSubmit={submit} className="w-full max-w-md">
          <h2 className="text-xl font-semibold tracking-tight">Sign in</h2>
          <p className="mt-1 text-sm text-ink-2">Each profile acts with its own role and signing key.</p>

          {profiles.data && profiles.data.length > 0 && (
            <div
              className="mt-5 grid max-h-72 grid-cols-2 gap-2 overflow-y-auto pr-1"
              role="radiogroup"
              aria-label="Operator profile"
            >
              {profiles.data.map((profile) => (
                <button
                  key={profile.username}
                  type="button"
                  role="radio"
                  aria-checked={profile.username === username}
                  onClick={() => setUsername(profile.username)}
                  className={`rounded-lg border px-3 py-2 text-left ${
                    profile.username === username
                      ? "border-brand bg-brand-wash"
                      : "border-line bg-surface hover:bg-sunken"
                  }`}
                >
                  <span className="block truncate text-sm font-medium">{profile.displayName}</span>
                  <span className="block truncate text-xs text-ink-3">{ROLE_LABELS[profile.role]}</span>
                </button>
              ))}
            </div>
          )}

          <div className="mt-5 space-y-4">
            <Field label="Username">
              <Input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
                required
              />
            </Field>
            <Field label="Passphrase">
              <Input
                type="password"
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
                autoComplete="current-password"
                required
              />
            </Field>
            {error && (
              <p role="alert" className="text-sm text-critical">
                {error}
              </p>
            )}
            <Button type="submit" variant="primary" className="w-full" disabled={busy || !username || !passphrase}>
              {busy ? "Signing in…" : "Sign in"}
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}
