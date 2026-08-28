import { useEffect, useState, type FormEvent } from "react";
import { login } from "../lib/auth";
import { useT } from "../lib/i18n";
import { LoadingIndicator } from "./LoadingIndicator";

export function LoginPage() {
  const t = useT();
  const [token, setToken] = useState("");
  const [totp, setTotp] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [twoFactor, setTwoFactor] = useState(true);

  // 2FA on/off (also included in 401 responses)
  useEffect(() => {
    fetch("/api/auth/status")
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as { twoFactor?: boolean };
        if (typeof body.twoFactor === "boolean") setTwoFactor(body.twoFactor);
      })
      .catch(() => {
        /* Server not up yet — keep the default */
      });
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await login(token.trim(), twoFactor ? totp.trim() : undefined);
    if (!res.ok) setError(res.error ?? t("loginFailed"));
    setBusy(false);
  };

  return (
    <div className="flex h-full items-center justify-center bg-canvas p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="text-4xl text-accent">π</div>
          <h1 className="mt-3 text-lg font-semibold text-ink">pi web chat</h1>
          <p className="mt-1 text-sm text-faint">{t("loginHint")}</p>
        </div>

        <form
          onSubmit={submit}
          className="rounded-2xl border border-line bg-card p-5 shadow-[0_2px_12px_rgba(0,0,0,0.05)]"
        >
          <label className="block text-xs font-medium text-muted">
            {t("accessToken")}
            <input
              type="password"
              autoComplete="current-password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={t("accessTokenPlaceholder")}
              className="mt-1.5 w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-ink outline-none placeholder:text-faint focus:border-faint"
            />
          </label>

          {twoFactor && (
            <label className="mt-4 block text-xs font-medium text-muted">
              {t("twoFactorCode")}
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={totp}
                onChange={(e) => setTotp(e.target.value)}
                placeholder="••••••"
                maxLength={6}
                className="mt-1.5 w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm tracking-[0.3em] text-ink outline-none placeholder:text-faint focus:border-faint"
              />
            </label>
          )}

          {error && <p className="mt-3 text-sm text-red-500">{error}</p>}

          <button
            type="submit"
            disabled={busy || !token.trim() || (twoFactor && totp.trim().length !== 6)}
            className="mt-5 w-full rounded-lg bg-accent py-2 text-sm font-medium text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {busy ? <LoadingIndicator label={t("loggingIn")} size="sm" showLabel className="justify-center text-accent-ink" /> : t("login")}
          </button>
        </form>
      </div>
    </div>
  );
}
