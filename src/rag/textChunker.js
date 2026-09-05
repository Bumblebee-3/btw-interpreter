/**
 * Split extracted text into overlapping chunks suitable for embedding.
 */
function chunkText(text, options = {}) {
  const maxChars = options.maxChars ?? 800;
  const overlapChars = options.overlapChars ?? 100;
  const minChars = options.minChars ?? 40;

  if (!Number.isInteger(maxChars) || maxChars <= 0) {
    throw new Error("maxChars must be a positive integer");
  }
  if (!Number.isInteger(overlapChars) || overlapChars < 0 || overlapChars >= maxChars) {
    throw new Error("overlapChars must be an integer from 0 up to maxChars - 1");
  }

  const raw = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!raw.trim()) return [];

  const paragraphs = raw.split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const sentences = [];
  for (const paragraph of paragraphs) {
    const parts = paragraph
      .split(/(?<=[.!?])\s+(?=[A-Z0-9"'\[{(])|(?<=\n)/)
      .map((sentence) => sentence.trim())
      .filter(Boolean);
    sentences.push(...parts);
  }

  const chunks = [];
  let current = "";
  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      if (current) chunks.push(current);
      current = "";
      let remaining = sentence;
      while (remaining.length > maxChars) {
        const slice = remaining.slice(0, maxChars);
        const lastSpace = slice.lastIndexOf(" ");
        const cutAt = lastSpace > maxChars * 0.6 ? lastSpace : maxChars;
        chunks.push(remaining.slice(0, cutAt).trim());
        remaining = remaining.slice(Math.max(0, cutAt - overlapChars)).trim();
      }
      current = remaining;
      continue;
    }

    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      const overlap = current.slice(-overlapChars).trim();
      current = overlap ? `${overlap} ${sentence}` : sentence;
    }
  }
  if (current) chunks.push(current);

  return chunks.filter((chunk) => chunk.length >= minChars);
}

function cleanText(text) {
  return String(text || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/\t/g, " ")
    .replace(/ {2,}/g, " ")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

module.exports = { chunkText, cleanText };
