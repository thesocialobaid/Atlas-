// Every variable the app can't run without. Checked once at boot from
// instrumentation.ts, so a missing value stops the server with its name rather
// than surfacing later as an anonymous client or a redirect to the wrong host.
const REQUIRED = [
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "CLERK_SECRET_KEY",
  // Without these Clerk silently falls back to its hosted pages.
  "NEXT_PUBLIC_CLERK_SIGN_IN_URL",
  "NEXT_PUBLIC_CLERK_SIGN_UP_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  // Server-only. The analysis pipeline writes with it; nothing reads with it.
  "SUPABASE_SECRET_KEY",
] as const;

type Env = Record<(typeof REQUIRED)[number], string>;

function required(name: (typeof REQUIRED)[number]): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable ${name}.`);
  return value;
}

export function readEnv(): Env {
  const missing = REQUIRED.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `Missing environment variables: ${missing.join(", ")}. Set them in .env and restart.`,
    );
  }
  return {
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: required("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"),
    CLERK_SECRET_KEY: required("CLERK_SECRET_KEY"),
    NEXT_PUBLIC_CLERK_SIGN_IN_URL: required("NEXT_PUBLIC_CLERK_SIGN_IN_URL"),
    NEXT_PUBLIC_CLERK_SIGN_UP_URL: required("NEXT_PUBLIC_CLERK_SIGN_UP_URL"),
    NEXT_PUBLIC_SUPABASE_URL: required("NEXT_PUBLIC_SUPABASE_URL"),
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: required("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
    SUPABASE_SECRET_KEY: required("SUPABASE_SECRET_KEY"),
  };
}
