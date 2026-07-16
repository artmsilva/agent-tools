import assert from "node:assert/strict";
import { test } from "node:test";
import { isPoisonError, parseMessageIndex, sanitizeMessages, stripOversizedImages } from "./index.ts";

test("isPoisonError detects Anthropic error patterns", () => {
   assert.ok(isPoisonError("all content must be type 'text' if 'is_error' is true"));
   assert.ok(isPoisonError('all content must be type "text" if "is_error" is true'));
   assert.ok(isPoisonError("image exceeds 5 MB maximum"));
   assert.ok(isPoisonError("unexpected `tool_use_id` found"));
   assert.ok(!isPoisonError("normal error message"));
   assert.ok(!isPoisonError("some other validation failure"));
});

test("parseMessageIndex extracts message index from error text", () => {
   assert.equal(parseMessageIndex("messages.164.content.0.tool_result"), 164);
   assert.equal(parseMessageIndex("messages.0.content.1"), 0);
   assert.equal(parseMessageIndex("messages.999.foo"), 999);
   assert.equal(parseMessageIndex("no index here"), undefined);
   assert.equal(parseMessageIndex("messages"), undefined);
});

test("sanitizeMessages strips non-text from error tool_result blocks", () => {
   const messages = [
      {
         role: "assistant",
         content: [
            {
               type: "tool_result",
               is_error: true,
               content: [
                  { type: "text", text: "Error occurred" },
                  { type: "image", data: "base64data", mimeType: "image/png" },
               ],
            },
         ],
      },
   ];

   const cleaned = sanitizeMessages(messages);
   const result = cleaned[0] as any;

   assert.equal(result.role, "assistant");
   assert.equal(result.content[0].type, "tool_result");
   assert.equal(result.content[0].is_error, true);
   assert.equal(result.content[0].content.length, 2);
   assert.equal(result.content[0].content[0].type, "text");
   assert.equal(result.content[0].content[0].text, "Error occurred");
   assert.equal(result.content[0].content[1].type, "text");
   assert.match(result.content[0].content[1].text, /1 non-text block\(s\) removed/);
});

test("sanitizeMessages preserves clean messages", () => {
   const messages = [
      {
         role: "assistant",
         content: [
            {
               type: "tool_result",
               is_error: true,
               content: [{ type: "text", text: "Error message" }],
            },
         ],
      },
   ];

   const cleaned = sanitizeMessages(messages);
   assert.deepEqual(cleaned, messages);
});

test("sanitizeMessages ignores non-error tool_result blocks", () => {
   const messages = [
      {
         role: "assistant",
         content: [
            {
               type: "tool_result",
               is_error: false,
               content: [
                  { type: "text", text: "Success" },
                  { type: "image", data: "base64data", mimeType: "image/png" },
               ],
            },
         ],
      },
   ];

   const cleaned = sanitizeMessages(messages);
   assert.deepEqual(cleaned, messages);
});

test("sanitizeMessages handles multiple tool_result blocks", () => {
   const messages = [
      {
         role: "assistant",
         content: [
            {
               type: "tool_result",
               is_error: true,
               content: [
                  { type: "text", text: "Error 1" },
                  { type: "image", data: "img1", mimeType: "image/png" },
               ],
            },
            {
               type: "tool_result",
               is_error: true,
               content: [
                  { type: "text", text: "Error 2" },
                  { type: "image", data: "img2", mimeType: "image/jpeg" },
                  { type: "image", data: "img3", mimeType: "image/png" },
               ],
            },
         ],
      },
   ];

   const cleaned = sanitizeMessages(messages);
   const result = cleaned[0] as any;

   assert.equal(result.content[0].content.length, 2);
   assert.match(result.content[0].content[1].text, /1 non-text block\(s\) removed/);

   assert.equal(result.content[1].content.length, 2);
   assert.match(result.content[1].content[1].text, /2 non-text block\(s\) removed/);
});

test("stripOversizedImages removes images exceeding size limit", () => {
   // 5MB base64 ≈ 6.67MB raw, so create a string that exceeds that
   const largeBase64 = "a".repeat(7 * 1024 * 1024);
   const messages = [
      {
         role: "assistant",
         content: [
            {
               type: "tool_result",
               content: [
                  { type: "text", text: "Screenshot taken" },
                  { type: "image", data: largeBase64, mimeType: "image/png" },
               ],
            },
         ],
      },
   ];

   const cleaned = stripOversizedImages(messages);
   const result = cleaned[0] as any;

   assert.equal(result.content[0].content.length, 2);
   assert.equal(result.content[0].content[0].type, "text");
   assert.equal(result.content[0].content[0].text, "Screenshot taken");
   assert.equal(result.content[0].content[1].type, "text");
   assert.match(result.content[0].content[1].text, /Image removed.*exceeded.*5\.0MB/);
});

test("stripOversizedImages preserves small images", () => {
   const smallBase64 = "a".repeat(1024); // ~1KB
   const messages = [
      {
         role: "assistant",
         content: [
            {
               type: "tool_result",
               content: [
                  { type: "text", text: "Screenshot taken" },
                  { type: "image", data: smallBase64, mimeType: "image/png" },
               ],
            },
         ],
      },
   ];

   const cleaned = stripOversizedImages(messages);
   assert.deepEqual(cleaned, messages);
});

test("stripOversizedImages handles custom size limit", () => {
   const base64 = "a".repeat(200_000); // ~150KB raw
   const messages = [
      {
         role: "assistant",
         content: [
            {
               type: "tool_result",
               content: [{ type: "image", data: base64, mimeType: "image/png" }],
            },
         ],
      },
   ];

   const cleaned = stripOversizedImages(messages, 100_000); // 100KB limit
   const result = cleaned[0] as any;

   assert.equal(result.content[0].content[0].type, "text");
   assert.match(result.content[0].content[0].text, /Image removed/);
});

test("sanitizeMessages and stripOversizedImages can be chained", () => {
   const largeBase64 = "a".repeat(7 * 1024 * 1024);
   const messages = [
      {
         role: "assistant",
         content: [
            {
               type: "tool_result",
               is_error: true,
               content: [
                  { type: "text", text: "Error with large image" },
                  { type: "image", data: largeBase64, mimeType: "image/png" },
                  { type: "image", data: "small", mimeType: "image/jpeg" },
               ],
            },
         ],
      },
   ];

   let cleaned = sanitizeMessages(messages);
   cleaned = stripOversizedImages(cleaned);

   const result = cleaned[0] as any;
   assert.equal(result.content[0].content.length, 2);
   assert.equal(result.content[0].content[0].type, "text");
   assert.equal(result.content[0].content[0].text, "Error with large image");
   // Both images should be stripped: one by sanitize (error+image), one by strip (oversized)
   assert.match(result.content[0].content[1].text, /2 non-text block\(s\) removed/);
});
