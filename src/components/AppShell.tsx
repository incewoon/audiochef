// src/components/AppShell.tsx

import { Zap } from "lucide-react";
import type { ReactNode } from "react";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-screen bg-gradient-to-b from-background to-muted flex flex-col items-center px-4 py-3 sm:py-4">
      <header className="w-full max-w-md pt-1 pb-3 text-center">
        <h1 className="flex items-center justify-center text-4xl sm:text-5xl font-black tracking-tight leading-none">
          <span className="bg-gradient-to-r from-primary via-primary to-accent-foreground bg-clip-text text-transparent">
            Audio
          </span>
          <Zap
            aria-hidden="true"
            className="mx-0.5 h-8 w-8 sm:h-10 sm:w-10 text-yellow-400 fill-yellow-400 drop-shadow-[0_0_6px_rgba(250,204,21,0.5)]"
            strokeWidth={1.5}
          />
          <span className="bg-gradient-to-r from-primary via-primary to-accent-foreground bg-clip-text text-transparent">
            Fly
          </span>
        </h1>
        <p className="mt-1 text-[11px] uppercase tracking-[0.25em] text-muted-foreground">
          Offline Audio Toolkit
        </p>
      </header>

      <div className="w-full max-w-md flex-1">{children}</div>

      <footer className="w-full max-w-md pt-4 pb-1 text-center">
        <p className="text-[11px] text-muted-foreground">
          Copyright 2026. Sungyeon In All right reserved.
        </p>
      </footer>
    </main>
  );
}
