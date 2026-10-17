"use client";

/**
 * The system-settings toggle switch.
 *
 * Every settings switch renders through this component so the pages cannot drift
 * apart again (before this there were two hand-rolled variants: a `h-6 w-11` button
 * in `settings/desktop` and a `peer-checked` checkbox in `settings/database`).
 *
 * The look is deliberately dimensional rather than flat: the track is a recessed
 * groove (gradient + inset shadow + hairline ring) and the knob is a raised disc
 * (gradient + drop shadow), so the on/off state reads even in greyscale.
 *
 * It is a `role="switch"` button, not a checkbox: the pages own the state, and a
 * button keeps one implementation for every caller.
 */
export type SettingsSwitchProps = {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  /** Accessible name — pass the visible setting label. */
  label: string;
  disabled?: boolean;
  className?: string;
};

export default function SettingsSwitch({
  checked,
  onCheckedChange,
  label,
  disabled = false,
  className = "",
}: SettingsSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full ring-1 transition-colors duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/70 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${
        checked
          ? "bg-gradient-to-b from-blue-500 to-blue-600 ring-blue-700/40 shadow-[inset_0_1px_2px_rgba(15,23,42,0.35)]"
          : "bg-gradient-to-b from-slate-200 to-slate-300 ring-slate-400/40 shadow-[inset_0_1px_2px_rgba(15,23,42,0.18)]"
      } ${className}`}
    >
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute top-0.5 h-5 w-5 rounded-full bg-gradient-to-b from-white to-slate-100 shadow-[0_1px_3px_rgba(15,23,42,0.35),0_0_0_1px_rgba(15,23,42,0.04)] transition-transform duration-200 ease-out ${
          checked ? "translate-x-5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}
