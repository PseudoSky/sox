// @ts-check
/**
 * no-unguarded-listen — repo-wide listen() safety invariant (BL-619).
 *
 * On 2026-07-18 `libs/service-proxy/src/shim.ts` called
 * `httpServer.listen(port, host, ...)` with NO 'error' listener — the ONLY
 * unguarded `listen()` in the repo. When launchd held port 3099 and a
 * client-spawned duplicate shim tried to bind it, Node emitted an unhandled
 * 'error' event and killed the process with a raw crash stack, six times in one
 * day (`Error: listen EADDRINUSE: address already in use 127.0.0.1:3099`).
 *
 * The LIFETIME fix is not "add one handler" — it is a lint invariant that makes
 * an unguarded `listen()` impossible to reintroduce. This rule flags any
 * `X.listen(...)` call unless one of three guards is present:
 *
 *   (a) the FIRST argument is the literal `0` — an ephemeral port, so no
 *       collision is possible and a bind failure cannot be EADDRINUSE;
 *   (b) `X.on('error', …)` / `X.once('error', …)` on the SAME receiver appears
 *       EARLIER (textually) in the enclosing function body — the pre-attached
 *       guard that turns a bind failure into a handled event; or
 *   (c) the call sits inside an allowlisted guarded-listen primitive:
 *       `listenGuarded` (`@adhd/sox-listen-guard`) or `doListen`
 *       (`libs/service-proxy/src/backend.ts`) — the two functions whose entire
 *       job is to attach the guard before binding.
 *
 * The fix is always one of: attach `once('error', reject)` before `listen()`,
 * or route through `@adhd/sox-listen-guard`'s `listenGuarded()`.
 */

const GUARDED_CALLEES = new Set(['listenGuarded', 'doListen']);

function normalizeText(s) {
  return String(s).replace(/\s+/g, '').trim();
}

/**
 * Nearest NAMED enclosing function, or null at module scope. An anonymous
 * callback does not establish identity — keep walking out to the nearest named
 * scope (mirrors tools/eslint-local/no-storage-backend-leak.cjs).
 */
function enclosingFnName(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (
      n.type === 'FunctionDeclaration' ||
      n.type === 'FunctionExpression' ||
      n.type === 'ArrowFunctionExpression'
    ) {
      if (n.id && n.id.name) return n.id.name;
      const p = n.parent;
      if (p && p.type === 'VariableDeclarator' && p.id && p.id.name) return p.id.name;
      if (p && (p.type === 'MethodDefinition' || p.type === 'Property') && p.key && p.key.name) {
        return p.key.name;
      }
      continue;
    }
    if (n.type === 'MethodDefinition' && n.key && n.key.name) return n.key.name;
  }
  return null;
}

/** Recursive AST walk in document order. The visitor returns true to stop the whole traversal. */
function walk(node, visitor) {
  if (!node || typeof node.type !== 'string') return false;
  if (visitor(node)) return true;
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const c of child) {
        if (c && typeof c.type === 'string' && walk(c, visitor)) return true;
      }
    } else if (child && typeof child.type === 'string') {
      if (walk(child, visitor)) return true;
    }
  }
  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid calling server.listen() without a preceding error guard. An EADDRINUSE (or any other bind failure) surfaces as an unhandled \'error\' event and kills the process. BL-619.',
    },
    schema: [],
    messages: {
      unguardedListen:
        "'{{name}}.listen()' has no 'error' listener attached before it. A bind failure (e.g. EADDRINUSE) will surface as an unhandled 'error' event and kill the process. Attach {{name}}.once('error', …) BEFORE listen(), or route through @adhd/sox-listen-guard's listenGuarded(). BL-619.",
    },
  },

  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    /**
     * True iff `X.on('error', …)` / `X.once('error', …)` on the SAME receiver
     * (`receiverNode`) appears earlier in the enclosing function body than
     * `listenNode`. Only handlers BEFORE the listen count — a handler attached
     * in the listen callback (or after it) is too late to catch the bind error.
     */
    function hasEarlierErrorGuard(listenNode, receiverNode) {
      let body = null;
      for (let n = listenNode; n; n = n.parent) {
        if (
          n.type === 'FunctionDeclaration' ||
          n.type === 'FunctionExpression' ||
          n.type === 'ArrowFunctionExpression' ||
          n.type === 'Program'
        ) {
          body = n;
          break;
        }
      }
      if (!body) return false;

      const receiverText = normalizeText(sourceCode.getText(receiverNode));
      let guarded = false;
      walk(body, (node) => {
        if (node === listenNode) return true; // stop: only earlier handlers matter
        if (
          node.type === 'CallExpression' &&
          node.callee.type === 'MemberExpression' &&
          !node.callee.computed
        ) {
          const prop = node.callee.property;
          if (prop.type === 'Identifier' && (prop.name === 'on' || prop.name === 'once')) {
            const firstArg = node.arguments[0];
            if (firstArg && firstArg.type === 'Literal' && firstArg.value === 'error') {
              const recv = normalizeText(sourceCode.getText(node.callee.object));
              if (recv === receiverText) {
                guarded = true;
                return true;
              }
            }
          }
        }
        return false;
      });
      return guarded;
    }

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression' || callee.computed) return;
        if (callee.property.type !== 'Identifier' || callee.property.name !== 'listen') return;

        // (c) inside an allowlisted guarded-listen primitive.
        const fnName = enclosingFnName(node);
        if (fnName !== null && GUARDED_CALLEES.has(fnName)) return;

        // (a) first argument is the literal 0 (ephemeral port).
        const firstArg = node.arguments[0];
        if (firstArg && firstArg.type === 'Literal' && firstArg.value === 0) return;

        // (b) a matching error guard appears earlier in the enclosing body.
        if (hasEarlierErrorGuard(node, callee.object)) return;

        context.report({
          node,
          messageId: 'unguardedListen',
          data: { name: sourceCode.getText(callee.object) },
        });
      },
    };
  },
};
