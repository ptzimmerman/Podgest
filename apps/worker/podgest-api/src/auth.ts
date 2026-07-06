import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins";
import { D1Dialect } from "kysely-d1";
import type { Env } from "./index";

/**
 * Better Auth instance (replaced Supabase Auth, Jul 2026).
 *
 * - Google is the only sign-in method (matches previous setup).
 * - Sessions are cookie-based, shared across *.podgest.app subdomains so the
 *   MCP server (mcp.podgest.app) can authenticate users with the same session.
 * - The bearer plugin also accepts `Authorization: Bearer <session-token>`.
 * - Legacy Supabase users were pre-seeded into the `user`/`account` tables
 *   with their original ids, so all profile/digest FKs keep working.
 */
export function createAuth(env: Env) {
  return betterAuth({
    baseURL: "https://api.podgest.app",
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    database: {
      dialect: new D1Dialect({ database: env.DB }),
      type: "sqlite",
    },
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
      },
    },
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ["google"],
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30, // 30 days
      updateAge: 60 * 60 * 24,
    },
    trustedOrigins: [
      "https://dash.podgest.app",
      "https://podgest-web.pages.dev",
      "https://mcp.podgest.app",
      "http://localhost:5173",
    ],
    advanced: {
      crossSubDomainCookies: {
        enabled: true,
        domain: "podgest.app",
      },
      defaultCookieAttributes: {
        secure: true,
        sameSite: "none",
      },
    },
    plugins: [bearer()],
    databaseHooks: {
      user: {
        create: {
          // Mirror the old Supabase trigger: every auth user gets a profile row.
          after: async (user) => {
            await env.DB.prepare(
              `INSERT OR IGNORE INTO profiles (id, email, display_name, timezone, digest_time, digest_length_minutes, dark_mode, created_at)
               VALUES (?, ?, ?, 'America/Chicago', '06:00:00', 5, 0, ?)`
            ).bind(user.id, user.email, user.name ?? null, new Date().toISOString()).run();
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
