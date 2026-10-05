import { Sidebar } from "../_components/sidebar";

// Sidebar plus a scrolling main column. Each page renders its own top bar so
// the title and breadcrumb belong to the page.
export default function WorkspaceLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex min-h-screen">
      <a
        href="#content"
        className="sr-only z-50 rounded-control bg-surface px-3 py-2 text-sm focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
      >
        Skip to content
      </a>
      <Sidebar />
      <main id="content" className="min-w-0 flex-1 px-4 py-4 sm:px-6 md:py-6 lg:px-8">
        <div className="mx-auto max-w-[1280px]">{children}</div>
      </main>
    </div>
  );
}
