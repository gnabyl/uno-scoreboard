import type { ReactNode } from 'react';

export const BTN_BASE =
  'min-h-11 rounded-xl px-4 py-3 text-sm font-semibold transition duration-150 hover:enabled:-translate-y-px hover:enabled:brightness-110 active:enabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-45 sm:min-h-0 sm:px-[18px] sm:py-[11px]';
export const BTN_PRIMARY = `${BTN_BASE} bg-edge text-white`;
export const BTN_ACCENT = `${BTN_BASE} bg-gradient-to-br from-accent to-brand-violet text-white`;
export const BTN_GHOST = `${BTN_BASE} border border-edge bg-transparent text-muted`;

export const INPUT =
  'w-full rounded-xl border border-edge bg-deep px-3.5 py-3 text-base text-white outline-none transition placeholder:text-faint focus:border-accent focus:shadow-[0_0_0_3px_rgba(76,154,255,0.2)] sm:py-[11px] sm:text-sm';

export const CARD = 'rounded-2xl border border-edge bg-panel p-5 shadow-panel sm:p-6';

export function Logo() {
  return (
    <img
      src="/logo192.png"
      alt=""
      aria-hidden="true"
      width={58}
      height={58}
      className="h-11 w-11 shrink-0 rounded-xl object-contain sm:h-[58px] sm:w-[58px] sm:rounded-2xl"
    />
  );
}

export function ErrorNotice({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return (
    <p
      role="alert"
      className="m-0 rounded-xl border border-[#5a2a2a] bg-[#2a1416] px-3.5 py-2.5 text-sm text-[#ffb3b3]"
    >
      {children}
    </p>
  );
}
