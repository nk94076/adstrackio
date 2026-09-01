import { z } from "zod";

/**
 * Canonical environment schema for backend services (api, tracker).
 * Values are validated eagerly at process startup so misconfiguration fails
 * fast instead of surfacing as a confusing runtime error later.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),

  AUTH_SECRET: z
    .string()
    .min(32, "AUTH_SECRET must be at least 32 characters long")
    .refine((value) => !/^replace-with/i.test(value), {
      message: "AUTH_SECRET still contains the placeholder value from .env.example",
    }),

  APP_URL: z.string().url("APP_URL must be a valid URL"),
  API_URL: z.string().url("API_URL must be a valid URL"),
  TRACKER_URL: z.string().url("TRACKER_URL must be a valid URL"),

  API_PORT: z.coerce.number().int().positive().default(4000),
  TRACKER_PORT: z.coerce.number().int().positive().default(4100),
});

export type Env = z.infer<typeof envSchema>;
