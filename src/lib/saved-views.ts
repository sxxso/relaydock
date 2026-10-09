import { z } from "zod";

export const savedViewFiltersSchema = z
  .object({
    search: z.string().trim().max(200).default(""),
    group: z.string().trim().max(50).default("all"),
    currency: z.string().max(512).default("all"),
    favorites: z.boolean().default(false),
    onlyLow: z.boolean().default(false),
    archive: z.enum(["active", "archived", "all"]).default("active"),
    recordAge: z.enum(["any", "older-than-7d"]).default("any"),
    sort: z.enum(["name", "recent", "favorite"]).default("name"),
  })
  .strict();

export type SavedViewFilters = z.infer<typeof savedViewFiltersSchema>;

export const DEFAULT_SAVED_VIEW_FILTERS: SavedViewFilters = {
  search: "",
  group: "all",
  currency: "all",
  favorites: false,
  onlyLow: false,
  archive: "active",
  recordAge: "any",
  sort: "name",
};

export const savedViewIdSchema = z.uuid();

export const savedViewSchema = z
  .object({
    id: z.uuid(),
    name: z.string().trim().min(1).max(40),
    filters: savedViewFiltersSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export type SavedView = z.infer<typeof savedViewSchema>;

export const savedViewInputSchema = z
  .object({
    id: z.uuid().optional(),
    name: z.string().trim().min(1, "视图名称不能为空").max(40),
    filters: savedViewFiltersSchema,
  })
  .strict();

export type SavedViewInput = z.infer<typeof savedViewInputSchema>;

export const savedViewsSchema = z.array(savedViewSchema).max(50);




