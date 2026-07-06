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
            const now = new Date().toISOString();
            await env.DB.prepare(
              `INSERT OR IGNORE INTO profiles (id, email, display_name, timezone, digest_time, digest_length_minutes, dark_mode, created_at)
               VALUES (?, ?, ?, 'America/Chicago', '06:00:00', 5, 0, ?)`
            ).bind(user.id, user.email, user.name ?? null, now).run();

            // Seed the welcome episode so new users immediately see one item in
            // their Activity log and RSS feed, before any API keys are added.
            // Uses the generic static welcome audio (no user keys required).
            // digest_date 1970-01-01 is the special welcome-episode marker.
            const firstName = (user.name ?? "").split(" ")[0] || null;
            const title = firstName ? `Welcome to Podgest, ${firstName}!` : "Welcome to Podgest!";
            try {
              await env.DB.prepare(
                `INSERT INTO digests (id, user_id, digest_date, status, audio_url, topic_clusters, script_text, episodes_included, duration_seconds, completed_at, created_at)
                 SELECT ?, ?, '1970-01-01', 'completed', 'https://cdn.podgest.app/static/welcome.mp3', ?, ?, '[]', 49, ?, ?
                 WHERE NOT EXISTS (SELECT 1 FROM digests WHERE user_id = ? AND digest_date = '1970-01-01')`
              ).bind(
                crypto.randomUUID(),
                user.id,
                JSON.stringify({ title, topics: ["Introduction", "How it works", "Getting started"] }),
                "Welcome to Podgest, your personal podcast digest! Every morning, Podgest checks your subscribed podcasts for new episodes, transcribes them, and creates a personalized audio digest of the best moments. Add podcasts and API keys at dash.podgest.app to get your first digest tomorrow morning.",
                now,
                now,
                user.id
              ).run();
            } catch (e) {
              // Non-fatal: worst case the user just sees an empty activity log
              console.error(`[Auth] Failed to seed welcome episode for ${user.id}: ${e}`);
            }
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
