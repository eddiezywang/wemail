import { z } from "zod";
import type { DirectoryContactSummary, DirectoryDepartment, DirectorySyncStatus } from "./directory.js";

const accountId = z.string().min(1).max(500);
const contact = z.object({
  id: z.string().min(1), name: z.string(), email: z.string().min(1),
  aliases: z.array(z.string()), departmentId: z.string().optional(),
  departmentPath: z.string().optional(), title: z.string().optional(),
  fullPinyin: z.string().optional(), pinyinInitials: z.string().optional(),
  pinyinIndexVersion: z.number().int().nonnegative().optional(),
  mobile: z.string().optional(), companyPhone: z.string().optional(),
  searchTerms: z.array(z.string()).optional(),
}).strict();
const department = z.object({
  id: z.string().min(1), parentId: z.string().optional(), name: z.string(),
  path: z.string(), childCount: z.number().int().nonnegative(),
}).strict();
const status = z.object({
  accountId, state: z.enum(["idle", "running", "completed", "failed"]),
  phase: z.enum(["login", "departments", "contacts", "commit"]).optional(),
  processedDepartments: z.number().int().nonnegative(),
  processedContacts: z.number().int().nonnegative(),
  lastSuccessfulAt: z.string().datetime().optional(), updatedAt: z.string().datetime(),
  errorCode: z.string().optional(), errorMessage: z.string().optional(),
}).strict();
const snapshotId = z.string().uuid();

export const DirectoryWriteParamsSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("replaceSnapshot"), accountId,
    departments: z.array(department), contacts: z.array(contact) }).strict(),
  z.object({ operation: z.literal("upsertContacts"), accountId,
    contacts: z.array(contact).max(500) }).strict(),
  z.object({ operation: z.literal("indexPinyinBatch"), accountId }).strict(),
  z.object({ operation: z.literal("setStatus"), status }).strict(),
  z.object({ operation: z.literal("beginSnapshot"), accountId, snapshotId,
    departmentCount: z.number().int().nonnegative(), contactCount: z.number().int().nonnegative() }).strict(),
  z.object({ operation: z.literal("appendSnapshot"), accountId, snapshotId,
    sequence: z.number().int().nonnegative(),
    departments: z.array(department).max(100), contacts: z.array(contact).max(100) }).strict(),
  z.object({ operation: z.literal("commitSnapshot"), accountId, snapshotId }).strict(),
  z.object({ operation: z.literal("abortSnapshot"), accountId, snapshotId }).strict(),
  z.object({ operation: z.literal("cleanupSnapshots") }).strict(),
]);

export type DirectoryContactInput = z.infer<typeof contact>;
export type DirectoryWriteParams = z.infer<typeof DirectoryWriteParamsSchema>;

export const DirectoryReadParamsSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("getStatus"), accountId }).strict(),
  z.object({ operation: z.literal("listDepartments"), accountId, parentId: z.string().optional() }).strict(),
  z.object({ operation: z.literal("getContact"), accountId, idOrEmail: z.string().min(1) }).strict(),
  z.object({ operation: z.literal("searchContacts"), accountId, query: z.string(),
    options: z.object({ departmentId: z.string().optional(), includeDescendants: z.boolean().optional(),
      limit: z.number().int().min(1).max(1_000).optional(),
      offset: z.number().int().nonnegative().optional() }).strict().optional() }).strict(),
]);
export type DirectoryReadParams = z.infer<typeof DirectoryReadParamsSchema>;
export interface DirectoryReadResults {
  getStatus: DirectorySyncStatus;
  listDepartments: DirectoryDepartment[];
  getContact: DirectoryContactSummary | null;
  searchContacts: { contacts: DirectoryContactSummary[]; total: number };
}
export type DirectoryReadResult<P extends DirectoryReadParams = DirectoryReadParams> = DirectoryReadResults[P["operation"]];
