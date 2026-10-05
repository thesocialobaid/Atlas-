"use client";

import { useState } from "react";
import { THEME_COOKIE, type Theme } from "@/lib/theme";

const OPTIONS: Theme[] = ["system", "light", "dark"];

// Writes the attribute the CSS tokens key off and the cookie the server reads
// on the next request. "system" removes both so the media query decides.
function applyTheme(next: Theme) {
  const root = document.documentElement;
  if (next === "system") {
    delete root.dataset.theme;
    document.cookie = `${THEME_COOKIE}=; path=/; max-age=0; samesite=lax`;
  } else {
    root.dataset.theme = next;
    document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
  }
}

export function ThemeControl({ initial }: { initial: Theme }) {
  const [theme, setTheme] = useState(initial);

  function choose(next: Theme) {
    setTheme(next);
    applyTheme(next);
  }

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="flex h-8 items-center gap-0.5 rounded-control border border-border bg-surface p-0.5 text-xs"
    >
      {OPTIONS.map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={theme === option}
          onClick={() => choose(option)}
          className={`h-full rounded-[6px] px-2.5 capitalize transition-colors duration-150 ${
            theme === option
              ? "bg-surface-2 text-fg"
              : "text-fg-muted hover:text-fg"
          }`}
        >
          {option}
        </button>
      ))}
    </div>
  );
}
