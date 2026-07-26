/**
 * Prepend a one-time text block to the FIRST tool result, then pass every
 * subsequent result through untouched. A pass-through when `text` is null.
 * Used to surface the session-expiry warning inside Claude once per session
 * (MCP stderr is not reliably visible to the user).
 */
export function makeOnceNotice(text: string | null): (result: any) => any {
  let fired = false;
  return (result: any) => {
    if (!text || fired) return result;
    fired = true;
    const content = Array.isArray(result?.content) ? result.content : [];
    return { ...result, content: [{ type: 'text', text }, ...content] };
  };
}
