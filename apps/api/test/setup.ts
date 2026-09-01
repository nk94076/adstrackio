process.env.NODE_ENV = "test";
process.env.DATABASE_URL =
  process.env.DATABASE_URL_TEST ??
  "postgresql://adstrackio:adstrackio@localhost:5432/adstrackio_test?schema=public";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.AUTH_SECRET ??= "test-only-auth-secret-not-for-real-use-000000";
process.env.APP_URL ??= "http://localhost:3000";
process.env.API_URL ??= "http://localhost:4000";
process.env.TRACKER_URL ??= "http://localhost:4100";
