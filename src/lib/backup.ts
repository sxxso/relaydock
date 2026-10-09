import { z } from "zod";

export const backupStatusSchema = z
  .object({
    lastDataBackupExportAt: z.iso.datetime().nullable(),
  })
  .strict();

export type BackupStatus = z.infer<typeof backupStatusSchema>;
