"use client";

import { OrganizationSwitcher, SignOutButton, useClerk } from "@clerk/nextjs";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  CloseIcon,
  DashboardIcon,
  Logo,
  MenuIcon,
  SignOutIcon,
  TeamIcon,
} from "./icons";

const NAV = [{ href: "/", label: "Dashboard", Icon: DashboardIcon }];

const itemClass =
  "flex h-9 w-full items-center gap-3 rounded-control px-3 text-sm transition-[color,background-color,transform] duration-150 active:scale-[0.98]";

// Full width on desktop, an icon rail on tablet, a drawer on phones.
export function Sidebar() {
  const pathname = usePathname();
  const { openOrganizationProfile } = useClerk();
  const [open, setOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openRef = useRef<HTMLButtonElement>(null);

  // An open drawer takes focus and gives it back on close; Escape closes it.
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const opener = openRef.current;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      opener?.focus();
    };
  }, [open]);

  return (
    <>
      <button
        ref={openRef}
        type="button"
        aria-label="Open navigation"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="fixed left-3 top-4 z-30 flex size-9 items-center justify-center rounded-control border border-border bg-surface md:hidden"
      >
        <MenuIcon />
      </button>

      {/* The drawer slides from the edge it lives on and the page dims behind
          it, both only because the menu was opened. */}
      <div
        aria-hidden="true"
        onClick={() => setOpen(false)}
        className={`fixed inset-0 z-40 bg-black/30 transition-opacity duration-200 md:hidden ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />

      <nav
        aria-label="Main"
        className={`fixed inset-y-0 left-0 z-50 flex w-60 flex-col border-r border-border bg-surface px-3 py-4 transition-[transform,visibility] duration-200 ease-out md:sticky md:top-0 md:z-auto md:h-screen md:w-16 md:translate-x-0 md:transition-none lg:w-60 ${
          // Off-screen links mustn't take keyboard focus on phones.
          open ? "translate-x-0" : "-translate-x-full max-md:invisible"
        }`}
      >
        <div className="flex h-9 items-center justify-between px-2 md:justify-center lg:justify-between">
          <Link href="/" className="flex items-center gap-2.5" onClick={() => setOpen(false)}>
            <Logo />
            <span className="text-[15px] font-semibold tracking-tight md:hidden lg:inline">
              Atlas
            </span>
          </Link>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close navigation"
            onClick={() => setOpen(false)}
            className="flex size-8 items-center justify-center rounded-control text-fg-muted hover:text-fg md:hidden"
          >
            <CloseIcon />
          </button>
        </div>

        <ul className="mt-8 space-y-1">
          {NAV.map(({ href, label, Icon }) => {
            const active = pathname === href;
            return (
              <li key={href}>
                <Link
                  href={href}
                  aria-current={active ? "page" : undefined}
                  title={label}
                  onClick={() => setOpen(false)}
                  className={`${itemClass} md:justify-center lg:justify-start ${
                    active
                      ? "bg-accent-soft font-medium text-accent"
                      : "text-fg-muted hover:bg-surface-2 hover:text-fg"
                  }`}
                >
                  <Icon />
                  <span className="md:hidden lg:inline">{label}</span>
                </Link>
              </li>
            );
          })}
        </ul>

        <p className="mt-8 px-3 text-xs font-medium text-fg-muted md:hidden lg:block">
          Organization
        </p>
        <div className="mt-2 px-1 md:hidden lg:block">
          <OrganizationSwitcher
            hidePersonal
            afterSelectOrganizationUrl="/"
            afterCreateOrganizationUrl="/"
            appearance={{
              elements: {
                rootBox: "w-full",
                organizationSwitcherTrigger: "w-full justify-between px-2 py-1.5",
              },
            }}
          />
        </div>
        <ul className="mt-2 space-y-1">
          <li>
            <SignOutButton>
              <button
                type="button"
                title="Sign out"
                className={`${itemClass} text-fg-muted hover:bg-surface-2 hover:text-fg md:justify-center lg:justify-start`}
              >
                <SignOutIcon />
                <span className="md:hidden lg:inline">Sign out</span>
              </button>
            </SignOutButton>
          </li>
        </ul>

        <div className="mt-auto rounded-card border border-border bg-bg p-4 md:hidden lg:block">
          <p className="text-sm font-medium">Bring your team in</p>
          <p className="mt-1 text-xs leading-relaxed text-fg-muted">
            Analyses belong to the organization, so everyone you invite starts
            from the same maps.
          </p>
          <button
            type="button"
            onClick={() => openOrganizationProfile()}
            className="mt-3 flex h-8 items-center gap-2 rounded-control border border-border bg-surface px-3 text-xs font-medium transition-[background-color,transform] duration-150 hover:bg-surface-2 active:scale-[0.97]"
          >
            <TeamIcon width={14} height={14} />
            Invite people
          </button>
        </div>
      </nav>
    </>
  );
}
