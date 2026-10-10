import { defineIdentity } from "managed-deepagents";

// Who may call this agent: only Atlas's server. It signs the member in with
// Clerk, then calls here with the shared ingress secret and the member's id,
// so every conversation is owned by the person who started it. Browsers never
// reach this server and never hold the secret.
export const identity = defineIdentity({
  auth: "backend",
});
