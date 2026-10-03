import { z } from "zod";
import { isValidTimeZone, normalizeWebsite, PROFILE_LIMITS } from "@shared/profile";

/** Single-line text: trimmed, no control characters, at most `max` characters. */
const line = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Keep this under ${max} characters`)
    .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), "Use a single line of text");

/** The profile fields of PATCH /api/me. Every field is optional; "" clears it. */
export const zProfilePatch = z.object({
  name: z.string().trim().min(1, "Enter your name").max(120).optional(),
  jobTitle: line(120).optional(),
  phone: z.string().trim().max(40).regex(/^[0-9+().\-\s/x]*$/i, "Use digits, spaces and + ( ) - only").optional(),
  pronouns: line(PROFILE_LIMITS.pronouns).optional(),
  department: line(PROFILE_LIMITS.department).optional(),
  location: line(PROFILE_LIMITS.location).optional(),
  // A short bio may wrap onto a few lines, but no other control characters.
  bio: z
    .string()
    .trim()
    .max(PROFILE_LIMITS.bio, `Keep your bio under ${PROFILE_LIMITS.bio} characters`)
    .refine((v) => !/[\u0000-\u0009\u000b-\u001f\u007f]/.test(v), "Remove special characters from your bio")
    .transform((v) => v.replace(/\n{3,}/g, "\n\n"))
    .optional(),
  timezone: z
    .string()
    .trim()
    .refine((v) => v === "" || isValidTimeZone(v), "Choose a time zone from the list")
    .optional(),
  website: z
    .string()
    .trim()
    .max(PROFILE_LIMITS.website)
    .transform((v, ctx) => {
      if (v === "") return "";
      const url = normalizeWebsite(v);
      if (!url) {
        ctx.addIssue({ code: "custom", message: "Use a secure https:// web address" });
        return z.NEVER;
      }
      return url;
    })
    .optional(),
});
export type ProfilePatch = z.infer<typeof zProfilePatch>;

/** users table columns for each profile field (snake_case where the column differs). */
export const PROFILE_COLUMNS = {
  name: "name",
  jobTitle: "job_title",
  phone: "phone",
  pronouns: "pronouns",
  department: "department",
  location: "location",
  bio: "bio",
  timezone: "timezone",
  website: "website",
} as const satisfies Record<keyof ProfilePatch, string>;
