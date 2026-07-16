/**
 * sanitize-error-results — userland fix for the Anthropic is_error contract.
 *
 * Anthropic rejects tool_result blocks that have is_error:true and any
 * non-text content ("all content must be type 'text' if 'is_error' is true").
 * pi's convertToolResult forwards tool content unchanged, so a tool that
 * fails AND returns an image (e.g. a QA screenshot) poisons the session:
 * the message persists in history and every subsequent request 400s forever.
 *
 * This hook strips non-text blocks from error results before they are
 * persisted. Same failure class as earendil-works/pi#2055.
 * Remove once fixed upstream in pi-ai's convertToolResult.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function activate(pi: ExtensionAPI) {
   pi.on("tool_result", (event) => {
      if (!event.isError) return;
      if (!event.content.some((block) => block.type !== "text")) return;
      const dropped = event.content.filter((block) => block.type !== "text").length;
      return {
         content: [
            ...event.content.filter((block) => block.type === "text"),
            {
               type: "text" as const,
               text: `[${dropped} non-text content block(s) removed from this error result: Anthropic requires error tool results to be text-only]`,
            },
         ],
      };
   });
}
