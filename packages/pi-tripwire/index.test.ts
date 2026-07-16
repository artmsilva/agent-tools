import assert from "node:assert/strict";
import { test } from "node:test";
import { redact } from "./index.ts";

// Positive tests — each pattern should be detected and redacted.

test("redacts GitHub personal access tokens", () => {
   const { text, hits } = redact("Token: ghp_abcdefghijklmnopqrstuvwxyz123456");
   assert.match(text, /\[TRIPWIRE:github-token\]/);
   assert.equal(hits["github-token"], 1);
});

test("redacts GitHub OAuth tokens", () => {
   const { text, hits } = redact("Auth: gho_1234567890abcdefghijklmnopqrstuvwxyz");
   assert.match(text, /\[TRIPWIRE:github-token\]/);
   assert.equal(hits["github-token"], 1);
});

test("redacts GitHub user tokens", () => {
   const { text, hits } = redact("User token: ghu_aaaabbbbccccddddeeeeffffgggghhhh");
   assert.match(text, /\[TRIPWIRE:github-token\]/);
   assert.equal(hits["github-token"], 1);
});

test("redacts GitHub server tokens", () => {
   const { text, hits } = redact("Server: ghs_aaaabbbbccccddddeeeeffffgggghhhh");
   assert.match(text, /\[TRIPWIRE:github-token\]/);
   assert.equal(hits["github-token"], 1);
});

test("redacts GitHub refresh tokens", () => {
   const { text, hits } = redact("Refresh: ghr_aaaabbbbccccddddeeeeffffgggghhhh");
   assert.match(text, /\[TRIPWIRE:github-token\]/);
   assert.equal(hits["github-token"], 1);
});

test("redacts GitHub fine-grained tokens", () => {
   const { text, hits } = redact("Fine: github_pat_11AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
   assert.match(text, /\[TRIPWIRE:github-token\]/);
   assert.equal(hits["github-token"], 1);
});

test("redacts Slack bot tokens", () => {
   const { text, hits } = redact("Bot: " + "xoxb" + "-123456789012-123456789012-abcdefghijklmnopqrstuvwx");
   assert.match(text, /\[TRIPWIRE:slack-token\]/);
   assert.equal(hits["slack-token"], 1);
});

test("redacts Slack app tokens", () => {
   const { text, hits } = redact("App: " + "xoxa" + "-1234567890-1234567890-abcdefgh");
   assert.match(text, /\[TRIPWIRE:slack-token\]/);
   assert.equal(hits["slack-token"], 1);
});

test("redacts Slack user tokens", () => {
   const { text, hits } = redact("User: " + "xoxp" + "-1234567890-1234567890-abcdefgh");
   assert.match(text, /\[TRIPWIRE:slack-token\]/);
   assert.equal(hits["slack-token"], 1);
});

test("redacts AWS access keys", () => {
   const { text, hits } = redact("AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE");
   assert.match(text, /\[TRIPWIRE:aws-access-key\]/);
   assert.equal(hits["aws-access-key"], 1);
});

test("redacts AWS secret keys with context", () => {
   const { text, hits } = redact("aws_secret_access_key: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
   assert.match(text, /\[TRIPWIRE:aws-secret-key\]/);
   assert.equal(hits["aws-secret-key"], 1);
});

test("redacts AWS secret keys with equals sign", () => {
   const { text, hits } = redact("aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
   assert.match(text, /\[TRIPWIRE:aws-secret-key\]/);
   assert.equal(hits["aws-secret-key"], 1);
});

test("redacts OpenAI API keys", () => {
   const { text, hits } = redact("OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456");
   assert.match(text, /\[TRIPWIRE:openai-key\]/);
   assert.equal(hits["openai-key"], 1);
});

test("redacts Anthropic API keys", () => {
   const { text, hits } = redact("ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456");
   assert.match(text, /\[TRIPWIRE:anthropic-key\]/);
   assert.equal(hits["anthropic-key"], 1);
});

test("redacts JWTs", () => {
   const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
   const { text, hits } = redact(`Token: ${jwt}`);
   assert.match(text, /\[TRIPWIRE:jwt\]/);
   assert.equal(hits["jwt"], 1);
});

test("redacts PEM private keys", () => {
   const pem = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj
MzEfYyjiWA4R4/M2bS1+fWIcPm15j4j3n0Y6Tn8A4VxZ+h3xT4fX2fG1i/f3k5
-----END PRIVATE KEY-----`;
   const { text, hits } = redact(pem);
   assert.match(text, /\[TRIPWIRE:pem-private-key\]/);
   assert.equal(hits["pem-private-key"], 1);
});

test("redacts PEM RSA private keys", () => {
   const pem = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEAy8Dbv8prpJ/0kKhlGeJYozo2t60EG8L0561g13R29LvMR5hy
vGZlGJpmn65+A4xHXInJYiPuKzrKUnApeLZ+vw==
-----END RSA PRIVATE KEY-----`;
   const { text, hits } = redact(pem);
   assert.match(text, /\[TRIPWIRE:pem-private-key\]/);
   assert.equal(hits["pem-private-key"], 1);
});

test("redacts Bearer tokens in Authorization headers", () => {
   const { text, hits } = redact("Authorization: Bearer abc123def456ghi789jklmnopqrstuvwxyz");
   assert.match(text, /Authorization:\s*Bearer\s+\[TRIPWIRE:bearer-token\]/i);
   assert.equal(hits["bearer-token"], 1);
});

test("redacts npm tokens", () => {
   const { text, hits } = redact("NPM_TOKEN=npm_abcdefghijklmnopqrstuvwxyz1234567890");
   assert.match(text, /\[TRIPWIRE:npm-token\]/);
   assert.equal(hits["npm-token"], 1);
});

test("counts multiple redactions", () => {
   const { text, hits } = redact("Token1: ghp_abcdefghijklmnopqrstuvwxyz1234, Token2: ghp_defghijklmnopqrstuvwxyz5678, Token3: " + "xoxb" + "-1234567890-1234567890-abcdefghijklmnop");
   assert.equal(hits["github-token"], 2);
   assert.equal(hits["slack-token"], 1);
   assert.ok(text.includes("[TRIPWIRE:github-token]"));
   assert.ok(text.includes("[TRIPWIRE:slack-token]"));
});

// Negative tests — these should NOT be redacted.

test("does not redact op:// references", () => {
   const { text, hits } = redact("Use the secret at op://vault/item/field for access");
   assert.ok(text.includes("op://vault/item/field"));
   assert.deepEqual(hits, {});
});

test("does not redact base64 encoded data", () => {
   const base64 = "SGVsbG8gV29ybGQhIFRoaXMgaXMgYSBiYXNlNjQgZW5jb2RlZCBzdHJpbmcu";
   const { text, hits } = redact(`Image data: ${base64}`);
   assert.ok(text.includes(base64));
   assert.deepEqual(hits, {});
});

test("does not redact SHA hashes", () => {
   const sha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
   const { text, hits } = redact(`Commit: ${sha256}`);
   assert.ok(text.includes(sha256));
   assert.deepEqual(hits, {});
});

test("does not redact normal prose", () => {
   const prose = "The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs.";
   const { text, hits } = redact(prose);
   assert.equal(text, prose);
   assert.deepEqual(hits, {});
});

test("does not redact UUIDs", () => {
   const uuid = "550e8400-e29b-41d4-a716-446655440000";
   const { text, hits } = redact(`Request ID: ${uuid}`);
   assert.ok(text.includes(uuid));
   assert.deepEqual(hits, {});
});

test("does not redact hex strings that look like tokens but are not", () => {
   const hex = "0x1234567890abcdef";
   const { text, hits } = redact(`Address: ${hex}`);
   assert.ok(text.includes(hex));
   assert.deepEqual(hits, {});
});

test("preserves op:// refs even when surrounded by secrets", () => {
   const { text, hits } = redact("Token ghp_abcdefghijklmnopqrstuvwxyz1234, secret at op://vault/key, another " + "xoxb" + "-1234567890-1234567890-abcdefghijklmnop");
   assert.ok(text.includes("op://vault/key"));
   assert.equal(hits["github-token"], 1);
   assert.equal(hits["slack-token"], 1);
});

test("does not redact short strings that resemble prefixes", () => {
   const { text, hits } = redact("ghp_ gho_ ghu_ ghs_ ghr_ github_pat_");
   assert.deepEqual(hits, {});
});

test("does not redact incomplete JWT-like strings", () => {
   const { text, hits } = redact("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.incomplete");
   assert.deepEqual(hits, {});
});
