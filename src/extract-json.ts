/** Escape raw control characters that appear INSIDE JSON string literals. Some
 *  model outputs put a literal newline / tab / control char inside a string
 *  value, which is invalid JSON and makes JSON.parse throw ("Bad control
 *  character in string literal"). Control chars BETWEEN tokens (formatting
 *  whitespace) are valid JSON and left untouched. */
export function escapeControlCharsInJson(s: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) { out += c; esc = false; continue; }
      if (c === "\\") { out += c; esc = true; continue; }
      if (c === '"') { out += c; inStr = false; continue; }
      const code = s.charCodeAt(i);
      if (code < 0x20) {
        out += c === "\n" ? "\\n" : c === "\r" ? "\\r" : c === "\t" ? "\\t"
             : "\\u" + code.toString(16).padStart(4, "0");
        continue;
      }
      out += c;
      continue;
    }
    if (c === '"') inStr = true;
    out += c;
  }
  return out;
}

/** Pull the first balanced JSON object out of a string, repairing stray control
 *  characters inside string literals first. */
export function firstJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("Model did not return JSON:\n" + text.slice(0, 500));
  }
  return JSON.parse(escapeControlCharsInJson(text.slice(start, end + 1)));
}
