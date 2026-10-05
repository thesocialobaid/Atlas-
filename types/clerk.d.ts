export {};

declare global {
  // Custom session-token claims, configured on the Clerk instance. The org name
  // rides in the token so the server can render it without asking Clerk.
  interface CustomJwtSessionClaims {
    org_name?: string | null;
  }
}
