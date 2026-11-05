import { z } from "zod";
import { idSchema } from "./index.js";

/** Literal substring search; bounds are milliseconds since the Unix epoch. */
const fields = {
  q: z.string().max(256).refine((value) => !value.includes("\0"), "NUL is not searchable").default(""),
  botId: idSchema.optional(), conversationId: idSchema.optional(), from: z.coerce.number().int().safe().optional(), to: z.coerce.number().int().safe().optional(),
  hasFile: z.enum(["true", "false"]).optional().transform((value) => value === "true"),
};
const validDates = (value: { from?: number; to?: number }) => value.from === undefined || value.to === undefined || value.from <= value.to;
export const searchQuerySchema = z.object(fields).strict().refine(validDates, "Invalid date range");
export const searchCursorSchema = z.string().min(1).max(1024).regex(/^[A-Za-z0-9_-]+$/);
export const searchPageQuerySchema = z.object({ ...fields, cursor: searchCursorSchema.optional() }).strict().refine(validDates, "Invalid date range");
export type SearchFilters = { botId?: string; conversationId?: string; from?: number; to?: number; hasFile?: boolean };
export const SEARCH_PAGE_SIZE = 50;
export const SEARCH_EXCERPT_CHARS = 320;
export const searchHitSchema = z.object({
  id: idSchema, conversationId: idSchema, createdAt: z.number().int().safe(),
  // SQLite counts code points; JS strings may use two code units per character.
  excerpt: z.string().max(SEARCH_EXCERPT_CHARS * 2 + 2),
}).strict();
export const searchPageSchema = z.object({ items: z.array(searchHitSchema).max(SEARCH_PAGE_SIZE), nextCursor: searchCursorSchema.nullable() }).strict();
export type SearchHit = z.infer<typeof searchHitSchema>;
export type SearchPage = z.infer<typeof searchPageSchema>;
