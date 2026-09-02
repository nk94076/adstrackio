import { z } from "zod";

/** Phase 8: Rules & Routing Engine — see
 * packages/shared/src/routing-rules.ts for the evaluator these schemas
 * feed, and docs/architecture/rules-routing.md for the design. */
export const routingRuleStatusSchema = z.enum(["ACTIVE", "INACTIVE"]);
export const routingRuleActionSchema = z.enum(["TARGET", "SAFE_PAGE", "BLOCK"]);
export const routingConditionFieldSchema = z.enum([
  "BOT_CLASSIFICATION",
  "COUNTRY",
  "DEVICE_TYPE",
  "BROWSER",
  "OS",
  "REFERRER_HOST",
]);
export const routingConditionOperatorSchema = z.enum(["EQUALS", "NOT_EQUALS", "IN", "NOT_IN"]);

const MAX_CONDITION_VALUE_LENGTH = 100;
const MAX_IN_VALUES = 25;

const conditionValueSingle = z.string().trim().min(1).max(MAX_CONDITION_VALUE_LENGTH);
const conditionValueList = z.array(conditionValueSingle).min(1).max(MAX_IN_VALUES);

const VALID_BOT_CLASSIFICATIONS = new Set(["UNKNOWN", "HUMAN", "SUSPICIOUS", "BOT"]);
const VALID_DEVICE_TYPES = new Set(["UNKNOWN", "DESKTOP", "MOBILE", "TABLET", "BOT", "OTHER"]);
const VALID_COUNTRY_CODE = /^[A-Za-z]{2}$/;

/**
 * A single typed condition — the closed set of fields/operators this
 * accepts is what keeps rule evaluation bounded and eval-free (see
 * packages/shared/src/routing-rules.ts's module doc). value is a plain
 * string for EQUALS/NOT_EQUALS and a bounded string array for IN/NOT_IN —
 * enforced below, not left to the evaluator to interpret loosely.
 *
 * Per-field value shape is validated here too (BOT_CLASSIFICATION/
 * DEVICE_TYPE against their real enum values, COUNTRY against a loose
 * 2-letter-alpha shape) specifically to catch a typo at write time — a
 * condition that can never match due to a misspelled value would
 * otherwise fail silently (the rule simply never fires) rather than
 * loudly, which is a much worse failure mode for a routing rule.
 */
export const routingConditionSchema = z
  .object({
    field: routingConditionFieldSchema,
    operator: routingConditionOperatorSchema,
    value: z.union([conditionValueSingle, conditionValueList]),
  })
  .superRefine((condition, ctx) => {
    const isListOperator = condition.operator === "IN" || condition.operator === "NOT_IN";
    const isArrayValue = Array.isArray(condition.value);

    if (isListOperator !== isArrayValue) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "value must be an array of strings for IN/NOT_IN and a single string otherwise",
        path: ["value"],
      });
      return;
    }

    const values = isArrayValue ? (condition.value as string[]) : [condition.value as string];

    if (condition.field === "BOT_CLASSIFICATION") {
      for (const v of values) {
        if (!VALID_BOT_CLASSIFICATIONS.has(v.toUpperCase())) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `"${v}" is not a valid BOT_CLASSIFICATION value (expected one of ${[...VALID_BOT_CLASSIFICATIONS].join(", ")})`,
            path: ["value"],
          });
        }
      }
    }

    if (condition.field === "DEVICE_TYPE") {
      for (const v of values) {
        if (!VALID_DEVICE_TYPES.has(v.toUpperCase())) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `"${v}" is not a valid DEVICE_TYPE value (expected one of ${[...VALID_DEVICE_TYPES].join(", ")})`,
            path: ["value"],
          });
        }
      }
    }

    if (condition.field === "COUNTRY") {
      for (const v of values) {
        if (!VALID_COUNTRY_CODE.test(v)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `"${v}" is not a valid 2-letter COUNTRY code`,
            path: ["value"],
          });
        }
      }
    }
  });
export type RoutingConditionInput = z.infer<typeof routingConditionSchema>;

export const MAX_CONDITIONS_PER_RULE = 10;

export const createRoutingRuleSchema = z.object({
  name: z.string().trim().min(1).max(160),
  status: routingRuleStatusSchema.default("ACTIVE"),
  priority: z.number().int().min(1).max(1_000_000),
  conditions: z.array(routingConditionSchema).min(1).max(MAX_CONDITIONS_PER_RULE),
  action: routingRuleActionSchema,
});
export type CreateRoutingRuleInput = z.infer<typeof createRoutingRuleSchema>;

// Deliberately no `status` field: lifecycle transitions (activate/
// deactivate) only happen through the explicit POST .../activate,
// .../deactivate endpoints, never as a side effect of a general PATCH —
// the same "no generic PATCH for status" convention Campaign/TrackingLink/
// Conversion already established.
export const updateRoutingRuleSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  priority: z.number().int().min(1).max(1_000_000).optional(),
  conditions: z.array(routingConditionSchema).min(1).max(MAX_CONDITIONS_PER_RULE).optional(),
  action: routingRuleActionSchema.optional(),
});
export type UpdateRoutingRuleInput = z.infer<typeof updateRoutingRuleSchema>;
