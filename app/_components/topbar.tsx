import { UserButton } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import { cookies } from "next/headers";
import { parseTheme, THEME_COOKIE } from "@/lib/theme";
import { ThemeControl } from "../theme-control";

export async function Topbar({ title }: { title: string }) {
  // Off the session token, not fetched from Clerk, so it's in the first paint.
  const { sessionClaims } = await auth();
  const orgName = sessionClaims?.org_name ?? "No organization";
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);

  return (
    <header className="flex items-end justify-between gap-4 pl-12 md:pl-0">
      <div className="min-w-0">
        <nav aria-label="Breadcrumb" className="text-xs text-fg-muted">
          <ol className="flex items-center gap-1.5">
            <li className="truncate">{orgName}</li>
            <li aria-hidden="true">/</li>
            <li aria-current="page" className="text-fg">
              {title}
            </li>
          </ol>
        </nav>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{title}</h1>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <ThemeControl initial={theme} />
        <UserButton />
      </div>
    </header>
  );
}
