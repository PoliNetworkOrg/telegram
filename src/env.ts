import { createEnv } from "@t3-oss/env-core"
import { z } from "zod/v4"
// coerce is needed for non-string values, because k8s supports only string env
export const env = createEnv({
  server: {
    BOT_TOKEN: z.string(),
    BACKEND_URL: z.string(),
    REDIS_HOST: z.string().min(1).optional(),
    REDIS_PORT: z.coerce.number().min(1).max(65535).default(6379),
    REDIS_USERNAME: z.string().min(1).optional(),
    REDIS_PASSWORD: z.string().min(1).optional(),
    NODE_ENV: z.enum(["development", "production"]).default("development"),
    OPENAI_API_KEY: z.string().optional(),
    INFLUXDB_TOKEN: z.string().optional(),
    INFLUXDB_URL: z.string().default("http://localhost:8086"),

    // PoliNetwork IdP (RFC v3 §10.1, §12). The bot calls the backend with its service token when
    // IDP_PUBLIC_URL, OAUTH_BACKEND_RESOURCE_URI, OAUTH_BOT_CLIENT_ID and OAUTH_BOT_PRIVATE_JWK are
    // all set. With none of them it calls anonymously, as before; anything in between is an error.
    IDP_PUBLIC_URL: z.url().optional(),
    /** In-cluster address for requests; identifiers always come from IDP_PUBLIC_URL. */
    IDP_INTERNAL_URL: z.url().optional(),
    OAUTH_BACKEND_RESOURCE_URI: z.url().optional(),
    OAUTH_BOT_CLIENT_ID: z.string().min(1).optional(),
    /** The bot client's private signing key as a JWK (JSON), with `kid` and `alg`. */
    OAUTH_BOT_PRIVATE_JWK: z.string().min(1).optional(),
    /**
     * RFC v3 §13 Phase 4: "shadow" acts on the legacy role checks and logs where the IdP decision
     * differs; "enforce" acts on the IdP decision. Ignored when the IdP is not configured.
     */
    IDP_DECISIONS: z.enum(["shadow", "enforce"]).default("shadow"),
  },

  runtimeEnv: process.env,
  /**
   * By default, this library will feed the environment variables directly to
   * the Zod validator.
   *
   * This means that if you have an empty string for a value that is supposed
   * to be a number (e.g. `PORT=` in a ".env" file), Zod will incorrectly flag
   * it as a type mismatch violation. Additionally, if you have an empty string
   * for a value that is supposed to be a string with a default value (e.g.
   * `DOMAIN=` in an ".env" file), the default value will never be applied.
   *
   * In order to solve these issues, we recommend that all new projects
   * explicitly specify this option as true.
   */
  emptyStringAsUndefined: true,
})
