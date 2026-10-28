// Which functions in a JS/TS module get a node, and what they are called.
// Shared by the static scanner (packages/core) and the runtime tracer (register.mjs) so that
// runtime spans land on exactly the same `fn:<service>:<module>.<qualname>` ids.
//
// Named: top-level functions, `const f = () => …` (also wrapped: memo(() => …)), methods of top-level
// object literals (`export const api = { get: () => … }`), class methods and arrow properties,
// default exports, CommonJS exports, and inline handlers of route registrations (`app.get("/x", (req, res) => …)`).
// Anything nested inside those belongs to its enclosing function.

const VERBS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "all"]);

/** Module path used in ids: posix path relative to the service root, no extension, no trailing /index. */
export function modulePath(relPath) {
  const noExt = relPath.replace(/\\/g, "/").replace(/\.(d\.)?[cm]?[jt]sx?$/, "");
  return noExt.endsWith("/index") ? noExt.slice(0, -6) : noExt === "index" ? "index" : noExt;
}

export function isFunctionLike(ts, node) {
  return !!node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
}

/** Unwrap `memo(() => …)`, `forwardRef(function X() …)`, `withAuth(handler)`-style wrappers (one level). */
function unwrap(ts, init) {
  if (!init) return null;
  if (isFunctionLike(ts, init)) return init;
  if (ts.isCallExpression(init)) return init.arguments.find((a) => isFunctionLike(ts, a)) ?? null;
  if (ts.isParenthesizedExpression(init) || ts.isAsExpression?.(init) || ts.isSatisfiesExpression?.(init)) return unwrap(ts, init.expression);
  return null;
}

const propName = (ts, name) =>
  name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isPrivateIdentifier(name)) ? name.text : null;

function objectMembers(ts, obj, prefix, out) {
  for (const p of obj.properties) {
    const name = propName(ts, p.name);
    if (!name) continue;
    if (ts.isMethodDeclaration(p) && p.body && !p.asteriskToken) out.push({ node: p, qual: `${prefix}.${name}` });
    else if (ts.isPropertyAssignment(p)) {
      const fn = unwrap(ts, p.initializer);
      if (fn) out.push({ node: fn, qual: `${prefix}.${name}` });
    }
  }
}

function classMembers(ts, cls, className, out) {
  for (const m of cls.members) {
    const name = propName(ts, m.name);
    if (!name) continue;
    if (ts.isMethodDeclaration(m) && m.body && !m.asteriskToken) out.push({ node: m, qual: `${className}.${name}`, cls: className });
    else if (ts.isPropertyDeclaration(m) && m.initializer && isFunctionLike(ts, m.initializer)) {
      out.push({ node: m.initializer, qual: `${className}.${name}`, cls: className });
    }
  }
}

/** Path string of a route registration call, or null. */
export function routeRegistration(ts, call) {
  if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return null;
  const verb = call.expression.name.text;
  if (!VERBS.has(verb) || call.arguments.length < 2) return null;
  const first = call.arguments[0];
  if (!(ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) || !first.text.startsWith("/")) return null;
  const handlers = call.arguments.slice(1).filter((a) => isFunctionLike(ts, a) || ts.isIdentifier(a) || ts.isPropertyAccessExpression(a));
  if (!handlers.length) return null;
  return { method: verb === "all" ? "ANY" : verb.toUpperCase(), path: first.text, handlers };
}

/**
 * @returns {{node: import("typescript").Node, qual: string, cls?: string}[]}
 */
export function namedFunctions(ts, sf) {
  const out = [];
  for (const st of sf.statements) {
    const exportDefault = st.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    if (ts.isFunctionDeclaration(st) && st.body && !st.asteriskToken) {
      out.push({ node: st, qual: st.name?.text ?? (exportDefault ? "default" : "anonymous") });
    } else if (ts.isClassDeclaration(st)) {
      classMembers(ts, st, st.name?.text ?? "default", out);
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        const fn = unwrap(ts, d.initializer);
        if (fn) out.push({ node: fn, qual: d.name.text });
        else if (ts.isObjectLiteralExpression(d.initializer)) objectMembers(ts, d.initializer, d.name.text, out);
        else if (ts.isClassExpression(d.initializer)) classMembers(ts, d.initializer, d.name.text, out);
      }
    } else if (ts.isExportAssignment(st)) {
      const fn = unwrap(ts, st.expression);
      if (fn) out.push({ node: fn, qual: "default" });
      else if (ts.isObjectLiteralExpression(st.expression)) objectMembers(ts, st.expression, "default", out);
    } else if (ts.isExpressionStatement(st)) {
      const e = st.expression;
      // module.exports = {...} / module.exports.x = fn / exports.x = fn
      if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const left = e.left.getText(sf);
        const fn = unwrap(ts, e.right);
        if (left === "module.exports") {
          if (fn) out.push({ node: fn, qual: "default" });
          else if (ts.isObjectLiteralExpression(e.right)) objectMembers(ts, e.right, "exports", out);
        } else if (/^(module\.)?exports\.\w+$/.test(left) && fn) {
          out.push({ node: fn, qual: `exports.${left.split(".").pop()}` });
        }
      }
      // app.get("/x", (req, res) => …)
      const reg = ts.isCallExpression(e) ? routeRegistration(ts, e) : null;
      if (reg) {
        let n = 0;
        for (const h of reg.handlers) {
          if (!isFunctionLike(ts, h)) continue;
          out.push({ node: h, qual: `<${reg.method} ${reg.path}>${n++ ? `#${n}` : ""}` });
        }
      }
    }
  }
  return out;
}
