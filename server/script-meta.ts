export interface ScriptMeta {
  name: string | null;
  description: string | null;
  phases: { title: string; detail: string | null }[];
}

const OPENERS = "([{";
const CLOSERS = ")]}";

/** Index of the bracket that closes the one at `start`, skipping strings and comments. */
function matchingClose(source: string, start: number): number {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (char === "'" || char === '"' || char === "`") {
      i = skipString(source, i);
      continue;
    }
    if (char === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (char === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    if (OPENERS.includes(char)) depth++;
    else if (CLOSERS.includes(char) && --depth === 0) return i;
  }
  return -1;
}

function skipString(source: string, start: number): number {
  const quote = source[start];
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === "\\") i++;
    else if (source[i] === quote) return i;
  }
  return source.length;
}

function unescape(value: string): string {
  return value.replace(/\\(.)/g, (_, char: string) => (char === "n" ? "\n" : char === "t" ? "\t" : char));
}

function stringField(source: string, key: string): string | null {
  const match = new RegExp(`\\b${key}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`).exec(source);
  return match ? unescape(match[2]) : null;
}

/** Top-level `{...}` chunks of an array literal's body. */
function objectChunks(arrayBody: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < arrayBody.length; i++) {
    const char = arrayBody[i];
    if (char === "'" || char === '"' || char === "`") {
      i = skipString(arrayBody, i);
    } else if (char === "{") {
      const end = matchingClose(arrayBody, i);
      if (end === -1) break;
      chunks.push(arrayBody.slice(i, end + 1));
      i = end;
    }
  }
  return chunks;
}

/**
 * Reads `export const meta = {...}` without running the script. The Workflow tool requires
 * meta to be a pure literal, so a scan for name, description and phases[].title is enough.
 */
export function parseScriptMeta(source: string): ScriptMeta {
  const empty: ScriptMeta = { name: null, description: null, phases: [] };
  const anchor = /export\s+const\s+meta\s*=\s*\{/.exec(source);
  if (!anchor) return empty;
  const open = anchor.index + anchor[0].length - 1;
  const close = matchingClose(source, open);
  if (close === -1) return empty;
  const meta = source.slice(open, close + 1);

  // Read name and description from the text outside the phases array.
  let outer = meta;
  const phases: ScriptMeta["phases"] = [];
  const phasesKey = /\bphases\s*:\s*\[/.exec(meta);
  if (phasesKey) {
    const arrayOpen = phasesKey.index + phasesKey[0].length - 1;
    const arrayClose = matchingClose(meta, arrayOpen);
    if (arrayClose !== -1) {
      for (const chunk of objectChunks(meta.slice(arrayOpen + 1, arrayClose))) {
        const title = stringField(chunk, "title");
        if (title) phases.push({ title, detail: stringField(chunk, "detail") });
      }
      outer = meta.slice(0, phasesKey.index) + meta.slice(arrayClose + 1);
    }
  }
  return { name: stringField(outer, "name"), description: stringField(outer, "description"), phases };
}
