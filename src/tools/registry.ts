import { z } from 'zod';
import { type Gql, type ToolHost, toolText, resolveBoardId } from './read.js';
import {
  CREATE_TAG,
  UPDATE_TAG,
  DELETE_TAG,
  CREATE_RELEASE,
  UPDATE_RELEASE,
  DELETE_RELEASE,
} from '../operations.js';

export function registerRegistryTools(server: ToolHost, gql: Gql) {
  server.registerTool(
    'create_tag',
    {
      description: "Create a tag in a board's tag registry.",
      inputSchema: {
        board: z.string(),
        name: z.string(),
        colorBg: z.string().describe('hex, e.g. #fee2e2'),
        colorText: z.string().describe('hex, e.g. #991b1b'),
      },
    },
    async ({ board, ...rest }) => {
      const boardId = await resolveBoardId(gql, board);
      const d = await gql(CREATE_TAG, { boardId, ...rest });
      return toolText(d.createTag.tag);
    },
  );

  server.registerTool(
    'update_tag',
    {
      description: 'Rename or recolor a tag.',
      inputSchema: {
        board: z.string(),
        tagId: z.string(),
        name: z.string().optional(),
        colorBg: z.string().optional(),
        colorText: z.string().optional(),
      },
    },
    async ({ board, tagId, ...rest }) => {
      const boardId = await resolveBoardId(gql, board);
      const d = await gql(UPDATE_TAG, { boardId, tagId, ...rest });
      return toolText(d.updateTag.tag);
    },
  );

  server.registerTool(
    'delete_tag',
    {
      description: 'Delete a tag (strips it from all items).',
      inputSchema: { board: z.string(), tagId: z.string() },
    },
    async ({ board, tagId }) => {
      const boardId = await resolveBoardId(gql, board);
      await gql(DELETE_TAG, { boardId, tagId });
      return toolText({ deletedTag: tagId });
    },
  );

  server.registerTool(
    'create_release',
    {
      description: "Create a release in a board's release registry.",
      inputSchema: {
        board: z.string(),
        name: z.string(),
        targetDate: z.string().optional().describe('YYYY-MM-DD'),
      },
    },
    async ({ board, ...rest }) => {
      const boardId = await resolveBoardId(gql, board);
      const d = await gql(CREATE_RELEASE, { boardId, ...rest });
      return toolText(d.createRelease.release);
    },
  );

  server.registerTool(
    'update_release',
    {
      description: 'Rename or re-date a release.',
      inputSchema: {
        board: z.string(),
        releaseId: z.string(),
        name: z.string().optional(),
        targetDate: z.string().optional(),
      },
    },
    async ({ board, releaseId, ...rest }) => {
      const boardId = await resolveBoardId(gql, board);
      const d = await gql(UPDATE_RELEASE, { boardId, releaseId, ...rest });
      return toolText(d.updateRelease.release);
    },
  );

  server.registerTool(
    'delete_release',
    {
      description: 'Delete a release (strips it from all items).',
      inputSchema: { board: z.string(), releaseId: z.string() },
    },
    async ({ board, releaseId }) => {
      const boardId = await resolveBoardId(gql, board);
      await gql(DELETE_RELEASE, { boardId, releaseId });
      return toolText({ deletedRelease: releaseId });
    },
  );
}
