process.env.NODE_ENV = "test";
// A dedicated database, distinct from apps/api's adstrackio_test: both
// suites truncate every table between tests (see db-reset.ts), and
// Turborepo runs different packages' `test` tasks concurrently — sharing
// one database caused real cross-suite interference (FK violations,
// deadlocks, and flaky assertions) when this suite ran alongside apps/api's.
process.env.DATABASE_URL =
  process.env.TRACKER_DATABASE_URL_TEST ??
  "postgresql://adstrackio:adstrackio@localhost:5432/adstrackio_tracker_test?schema=public";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.AUTH_SECRET ??= "test-only-auth-secret-not-for-real-use-000000";
process.env.APP_URL ??= "http://localhost:3000";
process.env.API_URL ??= "http://localhost:4000";
process.env.TRACKER_URL ??= "http://localhost:4100";
