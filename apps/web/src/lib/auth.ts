import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  baseURL: "https://api.podgest.app/api/auth",
  fetchOptions: { credentials: "include" },
});
