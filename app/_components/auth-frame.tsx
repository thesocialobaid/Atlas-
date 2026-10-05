import type { ReactNode } from "react";
import { Logo } from "./icons";

// Sign-in and sign-up wear the same mark and name as the app behind them.
export function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 px-4 py-12">
      <div className="flex items-center gap-2.5">
        <Logo />
        <span className="text-[15px] font-semibold tracking-tight">Atlas</span>
      </div>
      {children}
    </main>
  );
}
