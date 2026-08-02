// GraphQL operation strings, mirroring infra/graphql/schema.graphql.
// Field selections ported from web/src/api/operations.ts.

const columnFields = `id label order`;

const subtaskFields = `
  id num boardId storyId title body tags columnId rank
  releaseId estimateHours excludedFromRelease visibleAt assignee creator archivedAt blockedBy`;

const storyFields = `
  id num boardId title body tags columnId rank
  releaseId estimateHours visibleAt assignee creator archivedAt blockedBy
  subtasks { ${subtaskFields} }`;

const boardFields = `id name key role storyCount columns { ${columnFields} }`;
const tagFields = `id name colorBg colorText`;
const releaseFields = `id name targetDate`;
const membershipFields = `boardId userSub email displayName avatarUrl role`;

export const MY_BOARDS = `query { myBoards { ${boardFields} } }`;

export const GET_BOARD = `
  query GetBoard($boardId: ID!) {
    getBoard(boardId: $boardId) {
      board { ${boardFields} }
      stories { ${storyFields} }
      tags { ${tagFields} }
      releases { ${releaseFields} }
      members { ${membershipFields} }
    }
  }`;

// `archived` (KDO-90): resolveTicket returns archived tickets too, flagged, rather
// than 404ing them. Without it unarchive_ticket could never resolve its own target.
export const RESOLVE_TICKET = `
  query ResolveTicket($key: String!, $num: Int!) {
    resolveTicket(key: $key, num: $num) { boardId storyId subtaskId archived }
  }`;

export const ARCHIVED_ITEMS = `
  query ArchivedItems($boardId: ID!) {
    archivedItems(boardId: $boardId) {
      archivedAt story { ${storyFields} } subtask { ${subtaskFields} }
    }
  }`;

// Mutations return an ACK, not an object: enough to name the ticket, nothing more.
// Deliberately NOT the fat storyFields — that embeds every subtask body, which cost
// ~19,000 tokens to confirm a column change on a 5-subtask container.
const ackStoryFields = `id num boardId`;
const ackSubtaskFields = `id num boardId storyId`;

const storyChange = `boardId kind story { ${ackStoryFields} }`;
const subtaskChange = `boardId kind subtask { ${ackSubtaskFields} }`;
const tagChange = `boardId kind tag { ${tagFields} } deletedId`;
const releaseChange = `boardId kind release { ${releaseFields} } deletedId`;

export const CREATE_STORY = `
  mutation ($boardId: ID!, $title: String!, $columnId: ID!, $body: String,
    $tags: [String!], $releaseId: String, $estimateHours: Float, $visibleAt: String, $assignee: String) {
    createStory(boardId: $boardId, title: $title, columnId: $columnId, body: $body,
      tags: $tags, releaseId: $releaseId, estimateHours: $estimateHours,
      visibleAt: $visibleAt, assignee: $assignee) { ${storyChange} }
  }`;

export const UPDATE_STORY = `
  mutation ($boardId: ID!, $storyId: ID!, $title: String, $columnId: ID, $rank: String,
    $body: String, $tags: [String!], $releaseId: String, $estimateHours: Float,
    $visibleAt: String, $assignee: String) {
    updateStory(boardId: $boardId, storyId: $storyId, title: $title, columnId: $columnId,
      rank: $rank, body: $body, tags: $tags, releaseId: $releaseId,
      estimateHours: $estimateHours, visibleAt: $visibleAt, assignee: $assignee) { ${storyChange} }
  }`;

export const DELETE_STORY = `
  mutation ($boardId: ID!, $storyId: ID!) {
    deleteStory(boardId: $boardId, storyId: $storyId) { boardId kind deletedId }
  }`;

export const ARCHIVE_STORY = `
  mutation ($boardId: ID!, $storyId: ID!) {
    archiveStory(boardId: $boardId, storyId: $storyId) { boardId kind deletedId }
  }`;

export const UNARCHIVE_STORY = `
  mutation ($boardId: ID!, $storyId: ID!) {
    unarchiveStory(boardId: $boardId, storyId: $storyId) { ${storyChange} }
  }`;

export const CREATE_SUBTASK = `
  mutation ($boardId: ID!, $storyId: ID!, $title: String!, $columnId: ID!, $body: String,
    $tags: [String!], $releaseId: String, $estimateHours: Float, $excludedFromRelease: Boolean,
    $visibleAt: String, $assignee: String) {
    createSubtask(boardId: $boardId, storyId: $storyId, title: $title, columnId: $columnId,
      body: $body, tags: $tags, releaseId: $releaseId, estimateHours: $estimateHours,
      excludedFromRelease: $excludedFromRelease, visibleAt: $visibleAt, assignee: $assignee) { ${subtaskChange} }
  }`;

export const UPDATE_SUBTASK = `
  mutation ($boardId: ID!, $storyId: ID!, $subtaskId: ID!, $title: String, $columnId: ID,
    $rank: String, $body: String, $tags: [String!], $releaseId: String, $estimateHours: Float,
    $excludedFromRelease: Boolean, $visibleAt: String, $assignee: String) {
    updateSubtask(boardId: $boardId, storyId: $storyId, subtaskId: $subtaskId, title: $title,
      columnId: $columnId, rank: $rank, body: $body, tags: $tags, releaseId: $releaseId,
      estimateHours: $estimateHours, excludedFromRelease: $excludedFromRelease,
      visibleAt: $visibleAt, assignee: $assignee) { ${subtaskChange} }
  }`;

export const DELETE_SUBTASK = `
  mutation ($boardId: ID!, $storyId: ID!, $subtaskId: ID!) {
    deleteSubtask(boardId: $boardId, storyId: $storyId, subtaskId: $subtaskId) { boardId kind deletedId }
  }`;

export const ARCHIVE_SUBTASK = `
  mutation ($boardId: ID!, $storyId: ID!, $subtaskId: ID!) {
    archiveSubtask(boardId: $boardId, storyId: $storyId, subtaskId: $subtaskId) { boardId kind deletedId }
  }`;

export const UNARCHIVE_SUBTASK = `
  mutation ($boardId: ID!, $storyId: ID!, $subtaskId: ID!) {
    unarchiveSubtask(boardId: $boardId, storyId: $storyId, subtaskId: $subtaskId) { ${subtaskChange} }
  }`;

export const CREATE_TAG = `
  mutation ($boardId: ID!, $name: String!, $colorBg: String!, $colorText: String!) {
    createTag(boardId: $boardId, name: $name, colorBg: $colorBg, colorText: $colorText) { ${tagChange} }
  }`;
export const UPDATE_TAG = `
  mutation ($boardId: ID!, $tagId: ID!, $name: String, $colorBg: String, $colorText: String) {
    updateTag(boardId: $boardId, tagId: $tagId, name: $name, colorBg: $colorBg, colorText: $colorText) { ${tagChange} }
  }`;
export const DELETE_TAG = `
  mutation ($boardId: ID!, $tagId: ID!) {
    deleteTag(boardId: $boardId, tagId: $tagId) { boardId kind deletedId }
  }`;

export const CREATE_RELEASE = `
  mutation ($boardId: ID!, $name: String!, $targetDate: String) {
    createRelease(boardId: $boardId, name: $name, targetDate: $targetDate) { ${releaseChange} }
  }`;
export const UPDATE_RELEASE = `
  mutation ($boardId: ID!, $releaseId: ID!, $name: String, $targetDate: String) {
    updateRelease(boardId: $boardId, releaseId: $releaseId, name: $name, targetDate: $targetDate) { ${releaseChange} }
  }`;
export const DELETE_RELEASE = `
  mutation ($boardId: ID!, $releaseId: ID!) {
    deleteRelease(boardId: $boardId, releaseId: $releaseId) { boardId kind deletedId }
  }`;

const commentFields = `id author text createdAt editedAt`;

export const COMMENTS = `
  query Comments($boardId: ID!, $itemId: ID!) {
    comments(boardId: $boardId, itemId: $itemId) { ${commentFields} }
  }`;

// The mutations return only the key, never the body they were just handed:
// `addComment` yields the id the server assigned, `deleteComment` the id it
// removed. Enough to acknowledge precisely, nothing fetched to be discarded.
export const ADD_COMMENT = `
  mutation ($boardId: ID!, $itemId: ID!, $text: String!) {
    addComment(boardId: $boardId, itemId: $itemId, text: $text) { comment { id } }
  }`;

export const EDIT_COMMENT = `
  mutation ($boardId: ID!, $itemId: ID!, $commentId: ID!, $text: String!) {
    editComment(boardId: $boardId, itemId: $itemId, commentId: $commentId, text: $text) {
      comment { id }
    }
  }`;

export const DELETE_COMMENT = `
  mutation ($boardId: ID!, $itemId: ID!, $commentId: ID!) {
    deleteComment(boardId: $boardId, itemId: $itemId, commentId: $commentId) { deletedId }
  }`;
