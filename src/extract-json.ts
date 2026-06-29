/** Pull the first balanced JSON object out of a string. */
export function firstJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("Model did not return JSON:\n" + text.slice(0, 500));
  }
  return JSON.parse(text.slice(start, end + 1));
}
