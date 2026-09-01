import { z } from "zod";

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const createOrganizationSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(63)
    .regex(slugPattern, "Slug must be lowercase letters, numbers and hyphens only")
    .optional(),
});
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;

export const organizationRoleSchema = z.enum(["OWNER", "ADMIN", "MEMBER", "VIEWER"]);

export const inviteMemberSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: organizationRoleSchema.default("MEMBER"),
});
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

export const updateMemberRoleSchema = z.object({
  role: organizationRoleSchema,
});
export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>;
