import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import * as Diff from "diff";
import { resolvePath } from "../utils.js";

// --- Line ending handling ---

function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1) return "\n";
  if (crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

// --- BOM handling ---

function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

// --- Fuzzy matching ---

function normalizeForFuzzyMatch(text: string): string {
  return text
    .normalize("NFKC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

interface FuzzyMatchResult {
  found: boolean;
  originalIndex: number;
  originalMatchLength: number;
  usedFuzzyMatch: boolean;
}

function offsetToLineCol(text: string, offset: number): { line: number; col: number } {
  let line = 0;
  let col = 0;
  for (let i = 0; i < offset; i++) {
    if (text[i] === "\n") {
      line++;
      col = 0;
    } else {
      col++;
    }
  }
  return { line, col };
}

function lineColToOffset(text: string, line: number, col: number): number {
  let currentLine = 0;
  let i = 0;
  while (currentLine < line && i < text.length) {
    if (text[i] === "\n") currentLine++;
    i++;
  }
  return i + col;
}

function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
  // Try exact match first
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) {
    return {
      found: true,
      originalIndex: exactIndex,
      originalMatchLength: oldText.length,
      usedFuzzyMatch: false,
    };
  }

  // Try fuzzy match
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);

  if (fuzzyIndex === -1) {
    return { found: false, originalIndex: -1, originalMatchLength: 0, usedFuzzyMatch: false };
  }

  // Map fuzzy position back to original content using line:col
  const startPos = offsetToLineCol(fuzzyContent, fuzzyIndex);
  const endPos = offsetToLineCol(fuzzyContent, fuzzyIndex + fuzzyOldText.length);

  const originalStart = lineColToOffset(content, startPos.line, startPos.col);
  const originalEnd = lineColToOffset(content, endPos.line, endPos.col);

  return {
    found: true,
    originalIndex: originalStart,
    originalMatchLength: originalEnd - originalStart,
    usedFuzzyMatch: true,
  };
}

// --- Diff generation ---

function generateDiffString(oldContent: string, newContent: string, contextLines = 4): string {
  const parts = Diff.diffLines(oldContent, newContent);
  const output: string[] = [];

  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const maxLineNum = Math.max(oldLines.length, newLines.length);
  const lineNumWidth = String(maxLineNum).length;

  let oldLineNum = 1;
  let newLineNum = 1;
  let lastWasChange = false;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const raw = part.value.split("\n");
    if (raw[raw.length - 1] === "") raw.pop();

    if (part.added || part.removed) {
      for (const line of raw) {
        if (part.added) {
          output.push(`+${String(newLineNum).padStart(lineNumWidth, " ")} ${line}`);
          newLineNum++;
        } else {
          output.push(`-${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
          oldLineNum++;
        }
      }
      lastWasChange = true;
    } else {
      const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);

      if (lastWasChange || nextPartIsChange) {
        let linesToShow = raw;
        let skipStart = 0;
        let skipEnd = 0;

        if (!lastWasChange) {
          skipStart = Math.max(0, raw.length - contextLines);
          linesToShow = raw.slice(skipStart);
        }
        if (!nextPartIsChange && linesToShow.length > contextLines) {
          skipEnd = linesToShow.length - contextLines;
          linesToShow = linesToShow.slice(0, contextLines);
        }

        if (skipStart > 0) {
          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          oldLineNum += skipStart;
          newLineNum += skipStart;
        }

        for (const line of linesToShow) {
          output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
          oldLineNum++;
          newLineNum++;
        }

        if (skipEnd > 0) {
          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          oldLineNum += skipEnd;
          newLineNum += skipEnd;
        }
      } else {
        oldLineNum += raw.length;
        newLineNum += raw.length;
      }

      lastWasChange = false;
    }
  }

  return output.join("\n");
}

// --- Main edit tool ---

export async function editTool(
  args: { path: string; old_text: string; new_text: string; replace_all?: boolean },
  cwd: string,
): Promise<string> {
  const absolutePath = resolvePath(args.path, cwd);

  try {
    await access(absolutePath, constants.R_OK | constants.W_OK);
  } catch {
    throw new Error(`File not found or not writable: ${args.path}`);
  }

  const rawContent = (await readFile(absolutePath)).toString("utf-8");
  const { bom, text: content } = stripBom(rawContent);

  const originalEnding = detectLineEnding(content);
  const normalizedContent = normalizeToLF(content);
  const normalizedOldText = normalizeToLF(args.old_text);
  const normalizedNewText = normalizeToLF(args.new_text);

  const matchResult = fuzzyFindText(normalizedContent, normalizedOldText);

  if (!matchResult.found) {
    throw new Error(
      `Could not find the specified text in ${args.path}. The old_text must match exactly including all whitespace and newlines.`,
    );
  }

  let newContent: string;

  if (args.replace_all) {
    // Replace all occurrences
    if (matchResult.usedFuzzyMatch) {
      // For fuzzy matches with replace_all, we can only do exact replacements
      // on the normalized form — fall back to replacing all exact matches
      // after confirming at least one exists via fuzzy
      throw new Error("replace_all is not supported with fuzzy matching. Ensure old_text matches exactly.");
    }
    newContent = normalizedContent.split(normalizedOldText).join(normalizedNewText);
  } else {
    // Single replacement — check for multiple occurrences
    if (matchResult.usedFuzzyMatch) {
      const fuzzyContent = normalizeForFuzzyMatch(normalizedContent);
      const fuzzyOldText = normalizeForFuzzyMatch(normalizedOldText);
      const occurrences = fuzzyContent.split(fuzzyOldText).length - 1;
      if (occurrences > 1) {
        throw new Error(
          `Found ${occurrences} occurrences of the text in ${args.path}. The text must be unique. Provide more context to make it unique.`,
        );
      }
    } else {
      const occurrences = normalizedContent.split(normalizedOldText).length - 1;
      if (occurrences > 1) {
        throw new Error(
          `Found ${occurrences} occurrences of the text in ${args.path}. The text must be unique. Provide more context to make it unique.`,
        );
      }
    }

    // Fuzzy matching maps a position in the normalized text back to the original
    // via line:col. Because normalization changes per-line length (trailing-
    // whitespace trim, NFKC), that mapping can drift and mis-bound the slice we
    // replace. Guard against a silent mis-edit: re-normalize the slice we're
    // about to replace and require it to equal the normalized old_text.
    if (matchResult.usedFuzzyMatch) {
      const matchedSlice = normalizedContent.substring(
        matchResult.originalIndex,
        matchResult.originalIndex + matchResult.originalMatchLength,
      );
      if (normalizeForFuzzyMatch(matchedSlice) !== normalizeForFuzzyMatch(normalizedOldText)) {
        throw new Error(
          `Could not safely locate the text to replace in ${args.path}. Provide old_text that matches exactly (including whitespace).`,
        );
      }
    }

    newContent =
      normalizedContent.substring(0, matchResult.originalIndex) +
      normalizedNewText +
      normalizedContent.substring(matchResult.originalIndex + matchResult.originalMatchLength);
  }

  if (normalizedContent === newContent) {
    throw new Error(`No changes made to ${args.path}. The replacement produced identical content.`);
  }

  const finalContent = bom + restoreLineEndings(newContent, originalEnding);
  await writeFile(absolutePath, finalContent, "utf-8");

  const diff = generateDiffString(normalizedContent, newContent);
  return `Successfully edited ${args.path}.\n\n${diff}`;
}
