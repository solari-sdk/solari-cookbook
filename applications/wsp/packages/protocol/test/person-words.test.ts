// SPDX-License-Identifier: AGPL-3.0-only
// The words the app took out of a person's way, walked so none can come back.
// Round after round of the word cut left strings behind in corners nobody
// opened, so this reads the source rather than a list somebody keeps: every
// string a person can end up reading, in the app and in the tables the app
// draws from, against the design spec's word table.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { ROOT, sourceFiles } from "./source-files.js";

interface Said {
  where: string;
  text: string;
}

/** JSX attributes whose value is markup, a key or a wire word, never a sentence. */
const NOT_WORDS = new Set(["className", "class", "key", "id", "variant", "size", "role", "type"]);

/** The wire ids a record is held under. The command line names one because a person can type it back at it; the app
 * has the record on screen and names it by what the person called it. */
const RECORD_ID = /\b(?:machineId|threadId|workspaceId|snapshotId|sessionId|turnId|placeId)\b/;

/** Whether a string is one a person reads rather than a key, a class list, a wire word or a path: it either carries
 * a space or opens in capitals. Every label, sentence and aria line in this repo does one or the other; no action
 * id, event name, import path or tailwind class does both. */
const read = (text: string): boolean => /\s/.test(text) || /^[A-Z]/.test(text);

/** Every string a person can read in one file, with the template literals kept in the pieces they are written in.
 * Comments are not strings and never reach here, which is the whole reason this parses rather than greps. */
function saidIn(file: string): Said[] {
  const source = ts.createSourceFile(file, readFileSync(join(ROOT, file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Said[] = [];
  const at = (node: ts.Node): string => `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
  const add = (node: ts.Node, text: string): void => {
    if (read(text.trim()) && text.trim() !== "") out.push({ where: at(node), text: text.trim() });
  };
  const walk = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isJsxAttribute(node) && (NOT_WORDS.has(node.name.getText(source)) || node.name.getText(source).startsWith("data-"))) return;
    if (ts.isCallExpression(node) && node.expression.getText(source) === "cn") {
      node.arguments.forEach(walk);
      return;
    }
    // A template is one sentence: its pieces are joined before they are read, so a piece that is one word on its
    // own ("golden " in `golden ${name} v${n}`) is still read as part of the sentence it opens.
    if (ts.isTemplateExpression(node)) {
      add(node, [node.head.text, ...node.templateSpans.map(span => span.literal.text)].join(" "));
      node.templateSpans.forEach(span => walk(span.expression));
      return;
    }
    if (ts.isJsxText(node)) add(node, node.text);
    else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) add(node, node.text);
    node.forEachChild(walk);
  };
  source.forEachChild(walk);
  return out;
}

/** Every record id put into a sentence a person reads: a template that interpolates one, and a list of words joined
 * into one line with an id among them, which is the shape a palette row's meta had. A join on a control character
 * builds a key rather than a line, and is not one. */
function idsInSentences(file: string): Said[] {
  const source = ts.createSourceFile(file, readFileSync(join(ROOT, file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Said[] = [];
  const at = (node: ts.Node): string => `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
  // The lists this file declares, so a join of one by its name reads the elements it was given.
  const lists = new Map<string, ts.ArrayLiteralExpression>();
  const declared = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined && ts.isArrayLiteralExpression(node.initializer)) {
      lists.set(node.name.text, node.initializer);
    }
    node.forEachChild(declared);
  };
  source.forEachChild(declared);
  const joined = (node: ts.CallExpression): ts.ArrayLiteralExpression | undefined => {
    if (!ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== "join") return undefined;
    const separator = node.arguments[0];
    if (separator !== undefined && ts.isStringLiteral(separator) && /[\u0000-\u001f]/.test(separator.text)) return undefined;
    const list = node.expression.expression;
    return ts.isArrayLiteralExpression(list) ? list : ts.isIdentifier(list) ? lists.get(list.text) : undefined;
  };
  const walk = (node: ts.Node): void => {
    if (ts.isTemplateExpression(node)) {
      const words = [node.head.text, ...node.templateSpans.map(span => span.literal.text)].join("");
      const named = node.templateSpans.filter(span => RECORD_ID.test(span.expression.getText(source)));
      if (read(words) && named.length > 0) out.push({ where: at(node), text: node.getText(source) });
    }
    if (ts.isCallExpression(node)) {
      const list = joined(node);
      if (list !== undefined && list.elements.some(element => RECORD_ID.test(element.getText(source)))) {
        out.push({ where: at(node), text: `${node.getText(source)} over ${list.getText(source).replace(/\s+/g, " ")}` });
      }
    }
    node.forEachChild(walk);
  };
  source.forEachChild(walk);
  return out;
}

const under = (prefix: string): string[] => sourceFiles().filter(file => file.startsWith(prefix));

/** The words the spec's table replaced, each as the app can still spell it. `head` is the lower-case version word:
 * git's own HEAD is that tool's name for its own thing and stays as it writes it. */
const CUT = {
  golden: /(?<![\w-])goldens?(?![\w-])/i,
  vault: /(?<![\w-])vaults?(?![\w-])/i,
  lineage: /(?<![\w-])lineage(?![\w-])/i,
  volatile: /(?<![\w-])volatile(?![\w-])/i,
  head: /(?<![\w-])head(?![\w-])/,
  Reach: /(?<![\w-])Reach(?![\w-])/,
  upgrade: /(?<![\w-])upgrades?(?![\w-])/i,
  machine: /(?<![\w-])machines?(?![\w-])/i,
} as const;

/** Every file's said strings that spell one of these words, as `file:line` and the string, so a failure names the
 * string rather than a count. */
function spelling(files: string[], words: ReadonlyArray<keyof typeof CUT>): string[] {
  return files.flatMap(file => saidIn(file).flatMap(said => (words.some(word => CUT[word].test(said.text)) ? [`${said.where} ${JSON.stringify(said.text)}`] : [])));
}

describe("the words a person reads", () => {
  const app = under("apps/web/src");
  const tables = ["packages/protocol/src/format.ts", "packages/protocol/src/workspace-state.ts"];

  it("found the app's strings at all, so a walk that matched nothing cannot pass", () => {
    expect(app.length).toBeGreaterThan(100);
    const said = app.flatMap(saidIn);
    expect(said.length).toBeGreaterThan(1000);
    expect(said.some(s => s.text === "No tasks yet.")).toBe(true);
  });

  it("the app says none of the words the spec cut", () => {
    expect(spelling(app, Object.keys(CUT) as Array<keyof typeof CUT>)).toEqual([]);
  });

  // The protocol's tables are the command line's words as well as the app's, and the spec keeps the five nouns
  // there: "The five nouns stay on the command line; the app never says place, machine or fork to a person." What
  // the spec cut everywhere is the image's own vocabulary, and that is what these tables are read for.
  it("the format tables say none of the image words", () => {
    expect(spelling(tables, ["golden", "vault", "lineage", "volatile", "head", "Reach"])).toEqual([]);
  });

  it("no record's id goes into a sentence the app shows", () => {
    expect(app.flatMap(idsInSentences).map(said => `${said.where} ${said.text}`)).toEqual([]);
  });
});
