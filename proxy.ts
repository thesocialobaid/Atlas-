import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Everything is protected except the sign-in and sign-up screens, so a
// signed-out request is redirected here before any page renders. The agent's
// lookups are the other exception: they carry a credential instead of a
// session, and the database, not this file, decides what it opens.
const isPublic = createRouteMatcher(["/sign-in(.*)", "/sign-up(.*)", "/api/agent/(.*)"]);

export default clerkMiddleware(async (auth, req) => {
  if (!isPublic(req)) await auth.protect();
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/:path*",
  ],
};
