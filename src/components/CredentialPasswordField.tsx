"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useI18n } from "@/lib/i18n";
import { withBasePath } from "@/lib/base-path";
import type { CredentialKind } from "@/lib/credential-kind";

export type { CredentialKind };

/**
 * Whose password the field is asking for.
 *
 * `self` — the signed-in user, which is every sensitive-operation dialog
 * (`verifySensitiveOperationPassword`). `target` — another ledger's
 * administrator, which is only the ledger-switch dialog. The two need different
 * wording: a `fnos` verdict is fixable by the owner ("go set a local password")
 * but not by someone switching into their ledger.
 */
export type CredentialSubject = "self" | "target";

// One request per (page load, subject household): every dialog on a page asks
// the same question, and the answer cannot change while the session lasts.
const credentialKindCache = new Map<string, Promise<CredentialKind>>();

function loadCredentialKind(householdId?: string): Promise<CredentialKind> {
  const key = householdId ?? "";
  const cached = credentialKindCache.get(key);
  if (cached) return cached;

  const query = householdId ? `?householdId=${encodeURIComponent(householdId)}` : "";
  const pending = fetch(`/api/v1/auth/credential-kind${query}`, { cache: "no-store" })
    .then((res) => res.json() as Promise<{ ok?: boolean; credentialKind?: CredentialKind }>)
    // On any failure fall back to the historical wording rather than block the
    // dialog: the server still performs the real verification.
    .then((data) => (data?.ok && data.credentialKind ? data.credentialKind : "local"))
    .catch((): CredentialKind => "local");
  credentialKindCache.set(key, pending);
  return pending;
}

/**
 * Drop the cached answer. Call this right after the user creates a local
 * password (the setup dialog), so later dialogs stop offering the setup notice.
 */
export function resetCredentialKindCache(householdId?: string) {
  if (householdId === undefined) credentialKindCache.clear();
  else credentialKindCache.delete(householdId);
}

export function useCredentialKind(householdId?: string): CredentialKind | null {
  const [kind, setKind] = useState<CredentialKind | null>(null);
  useEffect(() => {
    let mounted = true;
    void loadCredentialKind(householdId).then((value) => {
      if (mounted) setKind(value);
    });
    return () => {
      mounted = false;
    };
  }, [householdId]);
  return kind;
}

function CredentialSetupNotice({ subject }: { subject: CredentialSubject }) {
  const { t } = useI18n();
  // Only the account's own owner can fix a missing local password, so the
  // "go to user settings" link is offered for `self` alone.
  if (subject === "target") {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
        {t("credential.targetFnosNeedsLocalPassword")}
      </div>
    );
  }
  return (
    <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
      {t("credential.fnosNeedsLocalPassword")}{" "}
      <a href={withBasePath("/settings/users")} className="font-medium underline">
        {t("credential.goToUserSettings")}
      </a>
    </div>
  );
}

/**
 * Password field for a verification dialog, labelled for the credential the
 * account actually has. A fnOS-bound account without a local password cannot be
 * verified at all (the gateway exposes no password API), so it renders guidance
 * instead of an input; every other case renders an input, because a `none`
 * verdict can still be a legacy install verified by the deployment
 * `access_password` bridge.
 */
export function CredentialPasswordField({
  value,
  onChange,
  onEnter,
  autoFocus,
  id,
  name,
  inputClassName = "form-input",
  labelClassName = "form-label",
  labelIcon,
  hideLabel = false,
  subject = "self",
  householdId,
}: {
  value: string;
  onChange: (value: string) => void;
  onEnter?: () => void;
  autoFocus?: boolean;
  id?: string;
  name?: string;
  inputClassName?: string;
  labelClassName?: string;
  labelIcon?: ReactNode;
  hideLabel?: boolean;
  subject?: CredentialSubject;
  /** Required when `subject` is `target`: the ledger whose admin is verified. */
  householdId?: string;
}) {
  const kind = useCredentialKind(subject === "target" ? householdId : undefined);
  const { t } = useI18n();

  if (kind === "fnos") {
    return <CredentialSetupNotice subject={subject} />;
  }

  // `kind === null` (still loading) intentionally renders the local wording:
  // it is the common case and the answer arrives within the first paint.
  const isMmh = kind === "mmh";
  const isTarget = subject === "target";
  const labelKey = isTarget
    ? isMmh ? "credential.targetMmhPasswordLabel" : "credential.targetLocalPasswordLabel"
    : isMmh ? "credential.mmhPasswordLabel" : "credential.localPasswordLabel";
  const placeholderKey = isTarget
    ? isMmh ? "credential.targetMmhPasswordPlaceholder" : "credential.targetLocalPasswordPlaceholder"
    : isMmh ? "credential.mmhPasswordPlaceholder" : "credential.localPasswordPlaceholder";

  return (
    <label className="grid gap-1.5">
      {hideLabel ? null : (
        <span className={`inline-flex items-center gap-1.5 ${labelClassName}`}>
          {labelIcon}
          {t(labelKey)}
        </span>
      )}
      <input
        id={id}
        name={name}
        type="password"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") onEnter?.();
        }}
        autoFocus={autoFocus}
        autoComplete="current-password"
        className={inputClassName}
        placeholder={t(placeholderKey)}
      />
    </label>
  );
}
