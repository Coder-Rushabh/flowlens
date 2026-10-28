// Source transform: wrap every function the static scanner names in `__flowlens.run(...)`.
//
//   function place(sku, qty) { BODY }      ->  function place(sku, qty) { return __flowlens.run(ID, …, arguments, () => { BODY }) }
//   const quote = async (sku) => EXPR       ->  const quote = async (sku) => __flowlens.run(ID, …, [sku], async () => EXPR)
//
// The inner arrow keeps `this`, `arguments` and `super` of the original function. TypeScript types are
// stripped in the same pass (transpileModule), so .ts files work under Node's type stripping too.

import ts from "typescript";
import { modulePath, namedFunctions } from "./naming.mjs";

const f = ts.factory;

function runCall(id, name, file, line, names, argsExpr, inner) {
  const target = f.createPropertyAccessExpression(f.createPropertyAccessExpression(f.createIdentifier("globalThis"), "__flowlens"), "run");
  return f.createCallExpression(target, undefined, [
    f.createStringLiteral(id),
    f.createStringLiteral(name),
    f.createStringLiteral(file),
    f.createNumericLiteral(line),
    f.createArrayLiteralExpression(names.map((n) => (n ? f.createStringLiteral(n) : f.createNull()))),
    argsExpr,
    inner,
  ]);
}

const asyncMods = (node) => (node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ? [f.createModifier(ts.SyntaxKind.AsyncKeyword)] : undefined);

function wrap(node, original, sf, meta) {
  const line = sf.getLineAndCharacterOfPosition(original.getStart(sf)).line + 1;
  const names = original.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : null));
  const id = `fn:${meta.service}:${meta.module}.${meta.qual}`;
  const name = meta.qual.replace(/^(default|exports)\./, "");
  if (ts.isArrowFunction(node)) {
    const argsExpr = f.createArrayLiteralExpression(names.map((n) => (n ? f.createIdentifier(n) : f.createVoidZero())));
    const inner = f.createArrowFunction(asyncMods(node), undefined, [], undefined, f.createToken(ts.SyntaxKind.EqualsGreaterThanToken), node.body);
    return f.updateArrowFunction(node, node.modifiers, node.typeParameters, node.parameters, node.type, node.equalsGreaterThanToken,
      runCall(id, name, meta.file, line, names, argsExpr, inner));
  }
  if (!node.body || node.asteriskToken) return node;
  const inner = f.createArrowFunction(asyncMods(node), undefined, [], undefined, f.createToken(ts.SyntaxKind.EqualsGreaterThanToken), node.body);
  const body = f.createBlock([f.createReturnStatement(runCall(id, name, meta.file, line, names, f.createIdentifier("arguments"), inner))], true);
  if (ts.isFunctionDeclaration(node)) {
    return f.updateFunctionDeclaration(node, node.modifiers, node.asteriskToken, node.name, node.typeParameters, node.parameters, node.type, body);
  }
  if (ts.isFunctionExpression(node)) {
    return f.updateFunctionExpression(node, node.modifiers, node.asteriskToken, node.name, node.typeParameters, node.parameters, node.type, body);
  }
  if (ts.isMethodDeclaration(node)) {
    return f.updateMethodDeclaration(node, node.modifiers, node.asteriskToken, node.name, node.questionToken, node.typeParameters, node.parameters, node.type, body);
  }
  return node;
}

/**
 * @param {string} source
 * @param {{ fileName: string, rel: string, repoFile: string, service: string, typescript: boolean, commonjs: boolean }} opts
 * @returns {string | null} transformed JavaScript, or null when nothing needed wrapping
 */
export function instrument(source, opts) {
  let wrapped = 0;
  const module = modulePath(opts.rel);
  const transformer = (ctx) => (sf) => {
    const named = new Map(namedFunctions(ts, sf).map((n) => [n.node, n.qual]));
    if (!named.size) return sf;
    const visit = (node) => {
      const qual = named.get(node);
      const visited = ts.visitEachChild(node, visit, ctx);
      if (!qual) return visited;
      wrapped++;
      return wrap(visited, node, sf, { qual, module, service: opts.service, file: opts.rel });
    };
    return ts.visitEachChild(sf, visit, ctx);
  };
  const out = ts.transpileModule(source, {
    fileName: opts.fileName,
    reportDiagnostics: false,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.Preserve,
      jsx: ts.JsxEmit.Preserve,
      allowJs: true,
      verbatimModuleSyntax: !opts.typescript,
      removeComments: false,
      sourceMap: false,
      inlineSourceMap: false,
    },
    transformers: { before: [transformer] },
  });
  return wrapped || opts.typescript ? out.outputText : null;
}
