"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { ArrowUpRight, CheckCircle2, Coffee, Heart, QrCode, Star } from "lucide-react";
import { useI18n } from "@/lib/i18n";

const GITHUB_REPO_URL = "https://github.com/frankluise5220/MMH";

const TIERS = [
  {
    id: "custom",
    amount: null,
    qrUrl: "/reward/alipay-custom.jpg",
    labelKey: "settings.sponsor.amount9",
  },
  {
    id: "19.90",
    amount: "19.90",
    qrUrl: "/reward/alipay-19.90.jpg",
    labelKey: "settings.sponsor.amount19",
  },
  {
    id: "29.90",
    amount: "29.90",
    qrUrl: "/reward/alipay-29.90.jpg",
    labelKey: "settings.sponsor.amount29",
  },
] as const;

export function SponsorPanel() {
  const { t } = useI18n();
  const router = useRouter();
  const [selectedTierId, setSelectedTierId] = useState<(typeof TIERS)[number]["id"]>("19.90");
  const [qrFailedById, setQrFailedById] = useState<Partial<Record<(typeof TIERS)[number]["id"], boolean>>>({});
  const [zoomedTierId, setZoomedTierId] = useState<(typeof TIERS)[number]["id"] | null>(null);

  const selectedTier = TIERS.find((tier) => tier.id === selectedTierId) ?? TIERS[1];
  const qrHint = selectedTier.id === "custom"
    ? t("settings.sponsor.qrCustomAmountHint")
    : t("settings.sponsor.qrAmountHint", { amount: selectedTier.amount ?? "" });
  const zoomedTier = TIERS.find((tier) => tier.id === zoomedTierId) ?? null;

  useEffect(() => {
    if (!zoomedTierId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setZoomedTierId(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [zoomedTierId]);

  function selectTier(id: (typeof TIERS)[number]["id"]) {
    setSelectedTierId(id);
  }

  function openSponsorFeedback() {
    const params = new URLSearchParams({
      type: "sponsor",
      time: String(Date.now()),
    });
    router.push(`/settings/feedback?${params.toString()}`);
  }

  return (
    <div className="space-y-4">
      <section className="overflow-hidden rounded-xl bg-gradient-to-br from-amber-500 via-orange-500 to-rose-500 px-5 py-5 text-white shadow-sm">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/20">
            <Coffee className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-semibold">{t("settings.sponsor.heroTitle")}</h2>
            <p className="mt-0.5 text-xs font-medium text-white/80">{t("settings.sponsor.title")}</p>
          </div>
        </div>
        <p className="mt-3 text-sm leading-6 text-white/95">{t("settings.sponsor.heroSubtitle")}</p>
        <div className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-[11px] text-white/90">
          <Heart className="h-3 w-3" />
          {t("settings.sponsor.voluntaryNote")}
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white px-4 py-4">
        <div className="flex items-start gap-2.5">
          <QrCode className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <div>
            <h3 className="text-sm font-semibold text-slate-800">{t("settings.sponsor.qrGridTitle")}</h3>
            <p className="mt-1 text-xs text-slate-500">{t("settings.sponsor.qrGridDesc")}</p>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
          {TIERS.map((tier) => {
            const active = tier.id === selectedTierId;
            const failed = Boolean(qrFailedById[tier.id]);
            const displayAmount = tier.id === "custom"
              ? t("settings.sponsor.customAmountShort")
              : `¥${tier.amount}`;
            const tierQrHint = tier.id === "custom"
              ? t("settings.sponsor.qrCustomAmountHint")
              : t("settings.sponsor.qrAmountHint", { amount: tier.amount ?? "" });

            return (
              <div
                key={tier.id}
                className={`flex min-w-0 flex-col rounded-lg border p-3 transition-colors ${
                  active
                    ? "border-amber-300 bg-amber-50/50"
                    : "border-slate-200 bg-white hover:border-amber-200"
                }`}
              >
                <button type="button" onClick={() => selectTier(tier.id)} className="w-full text-left">
                  <span className="flex items-start justify-between gap-2">
                    <span className="min-w-0">
                      <span className="block text-base font-semibold text-slate-900">{displayAmount}</span>
                      <span className="mt-0.5 block text-xs font-medium text-slate-700">{t(tier.labelKey)}</span>
                    </span>
                    {active ? (
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                        <CheckCircle2 className="h-3 w-3" />
                        {t("settings.sponsor.selected")}
                      </span>
                    ) : null}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    selectTier(tier.id);
                    if (!failed) setZoomedTierId(tier.id);
                  }}
                  title={failed ? t("settings.sponsor.qrMissing") : t("settings.sponsor.zoomHint")}
                  className="mt-3 rounded-lg border border-slate-200 bg-white p-2 transition-colors hover:border-amber-300"
                >
                  {failed ? (
                    <span className="flex aspect-square w-full flex-col items-center justify-center gap-2 rounded-md bg-slate-50 px-4 text-center">
                      <QrCode className="h-8 w-8 text-slate-300" />
                      <span className="text-sm font-medium text-slate-500">{t("settings.sponsor.qrMissing")}</span>
                      <span className="text-[11px] leading-4 text-slate-400">{t("settings.sponsor.qrMissingHint")}</span>
                    </span>
                  ) : (
                    <span className="relative block aspect-square w-full">
                      <Image
                        src={tier.qrUrl}
                        alt={tierQrHint}
                        fill
                        sizes="(max-width: 767px) 100vw, 30vw"
                        unoptimized
                        className="object-contain"
                        onError={() => setQrFailedById((current) => ({ ...current, [tier.id]: true }))}
                      />
                    </span>
                  )}
                </button>

                {tier.id === "29.90" ? (
                  <p className="mt-3 rounded-md border border-amber-200 bg-amber-50/70 px-2.5 py-2 text-center text-[11px] leading-4 text-amber-800">
                    {t("settings.sponsor.amount29Benefit")}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>

        <p className="mt-3 rounded-md border border-amber-200 bg-amber-50/70 px-3 py-2 text-center text-xs leading-5 text-amber-800">
          {t("settings.sponsor.paymentEmailNote")}{" "}
          <button
            type="button"
            onClick={openSponsorFeedback}
            className="font-medium text-blue-700 hover:text-blue-800"
          >
            {t("settings.sponsor.forgotEmail")}
          </button>
        </p>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white px-4 py-4">
        <h3 className="text-sm font-semibold text-slate-800">{t("settings.sponsor.otherWaysTitle")}</h3>
        <a
          href={GITHUB_REPO_URL}
          target="_blank"
          rel="noreferrer"
          className="mt-3 flex items-center gap-3 rounded-lg border border-slate-200 px-3 py-2.5 transition-colors hover:border-amber-200 hover:bg-amber-50/60"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600">
            <Star className="h-4 w-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-slate-800">{t("settings.sponsor.starGithub")}</span>
            <span className="mt-0.5 block truncate text-xs text-slate-500">{t("settings.sponsor.starGithubDesc")}</span>
          </span>
          <ArrowUpRight className="h-4 w-4 shrink-0 text-slate-400" />
        </a>
      </section>

      <p className="pb-2 text-center text-xs text-slate-400">
        {t("settings.sponsor.thanksFooter")}
        <Heart className="ml-1 inline h-3 w-3 text-rose-400" />
      </p>

      {zoomedTier && !qrFailedById[zoomedTier.id] ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-6 backdrop-blur-sm"
          onClick={() => setZoomedTierId(null)}
        >
          <div
            className="relative flex max-h-full w-full max-w-xs flex-col items-center rounded-2xl bg-white p-4 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <span className="relative block h-72 w-72">
              <Image src={zoomedTier.qrUrl} alt={qrHint} fill sizes="288px" unoptimized className="object-contain" />
            </span>
            <p className="mt-3 text-center text-xs text-slate-500">{qrHint}</p>
            <button
              type="button"
              onClick={() => setZoomedTierId(null)}
              className="mt-3 inline-flex h-8 items-center rounded-md border border-slate-200 px-4 text-xs text-slate-600 transition-colors hover:bg-slate-50"
            >
              {t("settings.sponsor.close")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
