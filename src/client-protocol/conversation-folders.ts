import { z } from 'zod';
import { idSchema } from './index.js';

export const FOLDER_PIN_CAPABILITY = 'conversation-folders.pin.v1';
export const folderNameSchema = z.string().trim().min(1).max(48);
export const conversationFoldersSchema = z.object({
  revision: z.number().int().nonnegative().safe(),
  folders: z.array(z.object({ id: idSchema, name: folderNameSchema })).max(64),
  assignments: z.array(z.object({ conversationId: idSchema, folderId: idSchema })).max(2048),
  // Missing on older hosts: Unfiled follows all custom folders.
  unfiledIndex: z.number().int().min(0).max(64).optional(),
  pinnedFolderIds: z.array(idSchema.nullable()).max(65).optional(),
});
const revision = z.number().int().nonnegative().safe();
export const folderCreateSchema = z.object({ type: z.literal('create'), revision, id: idSchema, name: folderNameSchema, conversationId: idSchema.optional() }).strict();
export const folderMoveSchema = z.object({ type: z.literal('move'), revision, conversationId: idSchema, folderId: idSchema.nullable() }).strict();
export const folderChangeSchema = z.discriminatedUnion('type', [
  folderCreateSchema,
  z.object({ type: z.literal('rename'), revision, id: idSchema, name: folderNameSchema }).strict(),
  z.object({ type: z.literal('delete'), revision, id: idSchema }).strict(),
  folderMoveSchema,
  z.object({ type: z.literal('reorder'), revision, folderIds: z.array(idSchema.nullable()).min(1).max(65) }).strict(),
  z.object({ type: z.literal('pin'), revision, id: idSchema.nullable(), pinned: z.boolean() }).strict(),
]);
export type ConversationFoldersState = z.infer<typeof conversationFoldersSchema>;
export type FolderChange = z.infer<typeof folderChangeSchema>;
export type FolderEdit = FolderChange extends infer C ? C extends FolderChange ? Omit<C, 'revision'> : never : never;
export const emptyConversationFolders = (): ConversationFoldersState => ({ revision: 0, folders: [], assignments: [] });

export function isFolderPinned(state: ConversationFoldersState, id: string | null): boolean {
  return state.pinnedFolderIds?.includes(id) ?? false;
}
/** Keep the relative order inside each section, including unsaved manager moves. */
export function pinnedFolderOrder(state: ConversationFoldersState, order: (string | null)[]): (string | null)[] {
  const pins = new Set(state.pinnedFolderIds);
  return [...order.filter(id => pins.has(id)), ...order.filter(id => !pins.has(id))];
}
/** null is the system Unfiled section, never a user-created folder ID. */
export function conversationFolderOrder(state: ConversationFoldersState): (string | null)[] {
  const order: (string | null)[] = state.folders.map(folder => folder.id);
  order.splice(Math.min(state.unfiledIndex ?? order.length, order.length), 0, null);
  return pinnedFolderOrder(state, order);
}
