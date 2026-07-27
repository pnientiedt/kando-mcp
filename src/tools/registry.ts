import { z } from 'zod';
import { type Gql, type ToolHost, toolText, resolveBoardId } from './read.js';
import { resolveTagIds, resolveReleaseId } from '../resolve.js';
import {
  GET_BOARD,
  CREATE_TAG,
  UPDATE_TAG,
  DELETE_TAG,
  CREATE_RELEASE,
  UPDATE_RELEASE,
  DELETE_RELEASE,
} from '../operations.js';

/** Fetch the board once, for the tools that must turn a name into an id. */
async function boardOf(gql: Gql, board: string) {
  const boardId = await resolveBoardId(gql, board);
  const bc = (await gql(GET_BOARD, { boardId })).getBoard;
  return { boardId, bc };
}

export function registerRegistryTools(server: ToolHost, gql: Gql) {
  server.registerTool(
    'create_tag',
    {
      description: "Create a tag in a board's tag registry. Apply it to tickets by NAME.",
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
      return toolText({ tag: d.createTag.tag.name, created: true });
    },
  );

  server.registerTool(
    'update_tag',
    {
      description: 'Rename or recolor a tag.',
      inputSchema: {
        board: z.string(),
        tag: z.string().describe('tag name or id'),
        name: z.string().optional(),
        colorBg: z.string().optional(),
        colorText: z.string().optional(),
      },
    },
    async ({ board, tag, ...rest }) => {
      const { boardId, bc } = await boardOf(gql, board);
      const tagId = resolveTagIds(bc, [tag])[0];
      const d = await gql(UPDATE_TAG, { boardId, tagId, ...rest });
      return toolText({ tag: d.updateTag.tag.name, updated: true });
    },
  );

  server.registerTool(
    'delete_tag',
    {
      description: 'Delete a tag (strips it from all items).',
      inputSchema: { board: z.string(), tag: z.string().describe('tag name or id') },
    },
    async ({ board, tag }) => {
      const { boardId, bc } = await boardOf(gql, board);
      const tagId = resolveTagIds(bc, [tag])[0];
      await gql(DELETE_TAG, { boardId, tagId });
      return toolText({ deleted: tag });
    },
  );

  server.registerTool(
    'create_release',
    {
      description: "Create a release in a board's release registry. Apply it to tickets by NAME.",
      inputSchema: {
        board: z.string(),
        name: z.string(),
        targetDate: z.string().optional().describe('YYYY-MM-DD'),
      },
    },
    async ({ board, ...rest }) => {
      const boardId = await resolveBoardId(gql, board);
      const d = await gql(CREATE_RELEASE, { boardId, ...rest });
      return toolText({ release: d.createRelease.release.name, created: true });
    },
  );

  server.registerTool(
    'update_release',
    {
      description: 'Rename or re-date a release.',
      inputSchema: {
        board: z.string(),
        release: z.string().describe('release name or id'),
        name: z.string().optional(),
        targetDate: z.string().optional(),
      },
    },
    async ({ board, release, ...rest }) => {
      const { boardId, bc } = await boardOf(gql, board);
      const releaseId = resolveReleaseId(bc, release);
      const d = await gql(UPDATE_RELEASE, { boardId, releaseId, ...rest });
      return toolText({ release: d.updateRelease.release.name, updated: true });
    },
  );

  server.registerTool(
    'delete_release',
    {
      description: 'Delete a release (strips it from all items).',
      inputSchema: { board: z.string(), release: z.string().describe('release name or id') },
    },
    async ({ board, release }) => {
      const { boardId, bc } = await boardOf(gql, board);
      const releaseId = resolveReleaseId(bc, release);
      await gql(DELETE_RELEASE, { boardId, releaseId });
      return toolText({ deleted: release });
    },
  );
}
