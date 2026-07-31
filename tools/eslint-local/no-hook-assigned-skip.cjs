// @ts-check
/**
 * no-hook-assigned-skip — catches the frozen-`{ skip }` trap.
 *
 * Vitest evaluates a test's options object during the SYNCHRONOUS `describe()`
 * collection pass, before any `beforeAll`/`beforeEach` hook runs. So this:
 *
 *   let hasTurso = false;
 *   beforeAll(async () => { hasTurso = await tursoAvailable(); });
 *   it('...', { skip: !hasTurso }, async () => { ... });
 *
 * reads `hasTurso` while it still holds its `false` initializer, freezes the
 * options object with `skip: true`, and never consults the assigned value
 * again. The test is PERMANENTLY skipped while reporting green.
 *
 * This is not hypothetical. `recall-parity.test.ts` and
 * `heal-backend-agnostic.test.ts` — the two tests whose entire purpose was to
 * prove the Turso storage path end-to-end — had statically skipped on every run
 * since they were written. Nobody noticed, because a skipped test and a passing
 * test look the same on a green board.
 *
 * The rule flags any identifier referenced inside a `{ skip }` / `{ only }` /
 * `{ todo }` option value, or in a `skipIf`/`runIf` argument, when that same
 * identifier is assigned inside a test hook in the same file.
 *
 * The fix is always to resolve the condition synchronously at module load.
 */

const HOOKS = new Set(['beforeAll', 'beforeEach', 'afterAll', 'afterEach']);
const CONDITIONAL_OPTS = new Set(['skip', 'only', 'todo', 'fails']);
const CONDITIONAL_FNS = new Set(['skipIf', 'runIf']);

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow deciding a test skip from a variable assigned in a test hook — the options object is frozen during collection, before hooks run, so the test skips permanently.',
    },
    schema: [],
    messages: {
      frozenSkip:
        "'{{name}}' is assigned inside a {{hook}} hook but read in a test-skip condition. Vitest freezes the options object during the synchronous collection pass, BEFORE hooks run, so this test is PERMANENTLY skipped regardless of the value the hook assigns. Resolve the condition synchronously at module load instead.",
    },
  },

  create(context) {
    /** name -> hook it is assigned in */
    const assignedInHook = new Map();
    /** [identifier node, name] pairs read from a skip condition */
    const skipReads = [];

    /** Walk up to see whether this node sits inside a test hook callback. */
    function enclosingHook(node) {
      for (let n = node; n; n = n.parent) {
        if (
          n.type === 'CallExpression' &&
          n.callee.type === 'Identifier' &&
          HOOKS.has(n.callee.name)
        ) {
          return n.callee.name;
        }
      }
      return null;
    }

    /** Collect every identifier referenced in an expression subtree. */
    function collectIdentifiers(node, out) {
      if (!node || typeof node.type !== 'string') return;
      if (node.type === 'Identifier') {
        out.push(node);
        return;
      }
      for (const key of Object.keys(node)) {
        if (key === 'parent') continue;
        const child = node[key];
        if (Array.isArray(child)) child.forEach((c) => collectIdentifiers(c, out));
        else if (child && typeof child.type === 'string') collectIdentifiers(child, out);
      }
    }

    return {
      AssignmentExpression(node) {
        if (node.left.type !== 'Identifier') return;
        const hook = enclosingHook(node);
        if (hook) assignedInHook.set(node.left.name, hook);
      },

      // `it('...', { skip: !x }, fn)` / `describe('...', { skip: x }, fn)`
      Property(node) {
        if (node.key.type !== 'Identifier' || !CONDITIONAL_OPTS.has(node.key.name)) return;
        if (node.parent.type !== 'ObjectExpression') return;
        // only care when the object is an argument to a call (the options object)
        const call = node.parent.parent;
        if (!call || call.type !== 'CallExpression') return;
        const ids = [];
        collectIdentifiers(node.value, ids);
        ids.forEach((id) => skipReads.push(id));
      },

      // `it.skipIf(!x)(...)` / `it.runIf(x)(...)`
      'CallExpression > MemberExpression'(node) {
        if (node.property.type !== 'Identifier' || !CONDITIONAL_FNS.has(node.property.name)) return;
        const call = node.parent;
        if (call.type !== 'CallExpression') return;
        const ids = [];
        call.arguments.forEach((a) => collectIdentifiers(a, ids));
        ids.forEach((id) => skipReads.push(id));
      },

      'Program:exit'() {
        for (const id of skipReads) {
          const hook = assignedInHook.get(id.name);
          if (hook) {
            context.report({
              node: id,
              messageId: 'frozenSkip',
              data: { name: id.name, hook },
            });
          }
        }
      },
    };
  },
};
