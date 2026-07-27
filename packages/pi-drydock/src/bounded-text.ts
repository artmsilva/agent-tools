export function createBoundedTextCollector(stream: NodeJS.ReadableStream, limit: number): () => string {
  const chunks: Buffer[] = [];
  let total = 0;
  stream.on("error", () => undefined);
  stream.on("data", (chunk: Buffer) => {
    if (total >= limit) return;
    const kept = chunk.subarray(0, limit - total);
    chunks.push(kept);
    total += kept.byteLength;
  });
  return () => Buffer.concat(chunks).toString("utf8");
}
