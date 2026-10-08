import { ts } from "ts-morph";
import { HTTP_METHODS, type HttpMethod } from "../types.ts";
import { lineOf, literalString } from "./shared.ts";

// Syntax readers the JavaScript adapters share: what a module exports, and
// what a config file sets, read without running either.

export type Setting<T> = { kind: "unset" } | { kind: "literal"; value: T } | { kind: "unreadable"; line: number };

/**
 * Reads one setting from the config's syntax. A plain literal is the value; a
 * computed one, or two that disagree, can't be known without running the file.
 */
export function readSetting<T>(sf: ts.SourceFile, name: string, literal: (n: ts.Expression) => T | null): Setting<T> {
  let found: Setting<T> = { kind: "unset" };
  const visit = (node: ts.Node) => {
    let value: T | null | undefined;
    if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && node.name.text === name) {
      value = literal(node.initializer);
    } else if (ts.isShorthandPropertyAssignment(node) && node.name.text === name) {
      value = null;
    } else if (ts.isPropertyAccessExpression(node) && node.name.text === name && ts.isBinaryExpression(node.parent) && node.parent.left === node) {
      value = null;
    }
    if (value !== undefined) {
      const same = found.kind === "literal" && value !== null && JSON.stringify(found.value) === JSON.stringify(value);
      if (found.kind === "unset" && value !== null) found = { kind: "literal", value };
      else if (found.kind !== "unreadable" && !same) found = { kind: "unreadable", line: lineOf(sf, node) };
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

export function stringArray(n: ts.Expression): string[] | null {
  if (!ts.isArrayLiteralExpression(n)) return null;
  const out: string[] = [];
  for (const e of n.elements) {
    const s = literalString(e);
    if (s === null) return null;
    out.push(s);
  }
  return out;
}

/** Where a module's default export is declared, or null if it has none. */
export function defaultExportLine(sf: ts.SourceFile): number | null {
  for (const s of sf.statements) {
    if (ts.isExportAssignment(s) && !s.isExportEquals) return lineOf(sf, s);
    if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && hasModifier(s, ts.SyntaxKind.ExportKeyword) && hasModifier(s, ts.SyntaxKind.DefaultKeyword)) {
      return lineOf(sf, s);
    }
    if (ts.isExportDeclaration(s) && s.exportClause && ts.isNamedExports(s.exportClause)) {
      const el = s.exportClause.elements.find((e) => e.name.text === "default");
      if (el) return lineOf(sf, el);
    }
  }
  return null;
}

export function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);
}


/** Every name a module exports, with the line it's declared on, and whether it also re-exports everything. */
export function exportNames(sf: ts.SourceFile): { names: Map<string, number>; star: boolean } {
  const names = new Map<string, number>();
  let star = false;
  const add = (name: ts.Identifier | ts.ModuleExportName) => {
    if ((ts.isIdentifier(name) || ts.isStringLiteral(name)) && !names.has(name.text)) names.set(name.text, lineOf(sf, name));
  };
  for (const s of sf.statements) {
    if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && hasModifier(s, ts.SyntaxKind.ExportKeyword)) {
      if (hasModifier(s, ts.SyntaxKind.DefaultKeyword)) names.set("default", lineOf(sf, s));
      else if (s.name) add(s.name);
    } else if (ts.isVariableStatement(s) && hasModifier(s, ts.SyntaxKind.ExportKeyword)) {
      for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name)) add(d.name);
    } else if (ts.isExportAssignment(s) && !s.isExportEquals) {
      names.set("default", lineOf(sf, s));
    } else if (ts.isExportDeclaration(s) && !s.isTypeOnly) {
      if (!s.exportClause) star = true;
      else if (ts.isNamedExports(s.exportClause)) {
        for (const el of s.exportClause.elements) if (!el.isTypeOnly) add(el.name);
      }
    }
  }
  return { names, star };
}

/** The HTTP methods a route handler exports by name, and whether it also re-exports everything. */
export function exportedMethods(sf: ts.SourceFile): { methods: { method: HttpMethod; line: number }[]; star: boolean } {
  const { names, star } = exportNames(sf);
  const methods: { method: HttpMethod; line: number }[] = [];
  for (const m of HTTP_METHODS) {
    const line = names.get(m);
    if (line !== undefined) methods.push({ method: m, line });
  }
  return { methods, star };
}
