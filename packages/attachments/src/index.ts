/**
 * Public entry point for @banto/attachments (spec `docs/design/attachments-plan.md`
 * §3.7).
 */
export type { AttachmentMeta, AttachmentsClient } from './types';
export { default as AttachmentsPanel } from './AttachmentsPanel.svelte';
export { defaultAttachmentsMessages, type AttachmentsMessages } from './messages';
