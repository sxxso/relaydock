import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import { describe, it, expect } from "vitest";
import { balanceAdapters, parseBalance } from "../src/lib/adapters";
import { accountInput } from "../src/lib/validation";

// Walk runtime imports, ignoring erased types. Catch accidental transport/store
// coupling and a client catalog pulling the whole server registry into bundles.
function dependencies(path: string) {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const imports: string[] = [],
    forbidden: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const allTypes =
        clause?.namedBindings &&
        ts.isNamedImports(clause.namedBindings) &&
        !clause.name &&
        clause.namedBindings.elements.every((e) => e.isTypeOnly);
      if (!clause?.isTypeOnly && !allTypes)
        imports.push((node.moduleSpecifier as ts.StringLiteral).text);
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      !node.isTypeOnly
    )
      imports.push((node.moduleSpecifier as ts.StringLiteral).text);
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = node.expression.getText(source);
      if (
        [
          "fetch",
          "eval",
          "Function",
          "require",
          "import",
          "setInterval",
          "setTimeout",
        ].includes(callee)
      )
        forbidden.push(callee);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { imports, forbidden };
}
function graph(entry: string, seen = new Set<string>()) {
  const path = resolve(entry);
  if (seen.has(path)) return seen;
  seen.add(path);
  const scan = dependencies(path);
  expect(scan.forbidden, path).toEqual([]);
  for (const spec of scan.imports) {
    if (!spec.startsWith(".")) {
      // Invitation backup URL validation uses only the deterministic IP parser;
      // keep transport, storage and scheduling forbidden across the graph.
      const allowed = ["decimal.js", "zod"];
      if (path === resolve("src/lib/invitation.ts")) allowed.push("ipaddr.js");
      expect(allowed, path).toContain(spec);
      continue;
    }
    const target = resolve(dirname(path), spec);
    graph(
      existsSync(target + ".ts") ? target + ".ts" : resolve(target, "index.ts"),
      seen,
    );
  }
  return seen;
}
describe("adapter boundaries", () => {
  it("client catalog imports only owned metadata, not parsing or transport", () => {
    const paths = [...graph("src/lib/platform-catalog.ts")];
    expect(paths).toHaveLength(8);
    expect(paths.slice(1).every((path) => path.endsWith("metadata.ts"))).toBe(
      true,
    );
  });
  it("static registry and transitive helpers cannot query, store, schedule or execute user scripts", () => {
    const paths = [...graph("src/lib/adapters/index.ts")];
    for (const file of [
      "outbound.ts",
      "store.ts",
      "api.ts",
      "query-balance.ts",
      "crypto.ts",
    ])
      expect(
        paths.some((path) => path.endsWith(file)),
        file,
      ).toBe(false);
    expect(paths.some((path) => path.endsWith("shared.ts"))).toBe(true);
  });
  it.each(Object.keys(balanceAdapters))(
    "%s rejects primitive/array/missing responses rather than producing zero",
    (provider) => {
      const a = accountInput.parse({
        name: "synthetic",
        siteUrl: "https://relay.example",
        provider,
      });
      for (const body of [null, undefined, true, 0, "0", [], {}])
        expect(() => parseBalance(body, a)).toThrow();
    },
  );
  it("field extraction cannot read inherited balances or run mappings", () => {
    const base = {
      name: "synthetic",
      siteUrl: "https://relay.example",
      provider: "custom",
    };
    expect(() =>
      parseBalance(Object.create({ balance: "99" }), accountInput.parse(base)),
    ).toThrow();
    for (const balancePath of [
      "__proto__.balance",
      "constructor",
      "x;process.exit()",
      "data[0]",
    ])
      expect(
        accountInput.safeParse({ ...base, query: { balancePath } }).success,
      ).toBe(false);
    expect(
      accountInput.safeParse({ ...base, query: { script: "return 99" } })
        .success,
    ).toBe(false);
  });
});
