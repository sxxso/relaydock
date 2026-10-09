import { z } from "zod";

// A finite safety limit, independent of the current visible canvas bounds.
export const GROUP_COORDINATE_LIMIT = 1_000_000;
const coordinate = z.number().finite().min(-GROUP_COORDINATE_LIMIT).max(GROUP_COORDINATE_LIMIT);
export const groupPositionSchema = z
  .object({
    name: z.string().trim().min(1).max(50),
    x: coordinate,
    y: coordinate,
  })
  .strict();
export const groupPositionsSchema = z
  .array(groupPositionSchema)
  .max(5000)
  .refine(
    (positions) =>
      new Set(positions.map((p) => p.name)).size === positions.length,
    "分组位置重复",
  );
export const groupLayoutSchema = z
  .object({
    revision: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
    positions: groupPositionsSchema,
  })
  .strict();
export const groupMoveInput = z
  .object({
    name: groupPositionSchema.shape.name,
    position: z.object({ x: coordinate, y: coordinate }).strict().nullable(),
    expectedRevision: groupLayoutSchema.shape.revision,
  })
  .strict();
export const groupRenameInput = z
  .object({
    name: groupPositionSchema.shape.name,
    newName: groupPositionSchema.shape.name,
    expectedRevision: groupLayoutSchema.shape.revision,
  })
  .strict();
export type GroupPosition = z.infer<typeof groupPositionSchema>;
export type GroupLayout = z.infer<typeof groupLayoutSchema>;

/** Quantize only the saved position, never the live pointer/camera. */
export function groupDragPosition(
  point: { x: number; y: number },
  offset: { x: number; y: number },
) {
  const clamp = (v: number) =>
    Math.round(Math.min(GROUP_COORDINATE_LIMIT, Math.max(-GROUP_COORDINATE_LIMIT, v)) * 10) / 10;
  return { x: clamp(point.x + offset.x), y: clamp(point.y + offset.y) };
}
