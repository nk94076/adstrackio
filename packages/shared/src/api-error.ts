/**
 * Consistent API error shape returned by apps/api for every error response.
 * Keeping this in a shared package lets the dashboard consume it with the
 * same type it was constructed from.
 */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export type ApiErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: ApiErrorCode, statusCode: number, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }

  toBody(): ApiErrorBody {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }

  static validation(message: string, details?: unknown): ApiError {
    return new ApiError("VALIDATION_ERROR", 400, message, details);
  }

  static unauthenticated(message = "Authentication is required"): ApiError {
    return new ApiError("UNAUTHENTICATED", 401, message);
  }

  static forbidden(message = "You do not have permission to perform this action"): ApiError {
    return new ApiError("FORBIDDEN", 403, message);
  }

  static notFound(message = "Resource not found"): ApiError {
    return new ApiError("NOT_FOUND", 404, message);
  }

  static conflict(message: string): ApiError {
    return new ApiError("CONFLICT", 409, message);
  }

  static rateLimited(message = "Too many requests"): ApiError {
    return new ApiError("RATE_LIMITED", 429, message);
  }

  static internal(message = "An unexpected error occurred"): ApiError {
    return new ApiError("INTERNAL_ERROR", 500, message);
  }
}
