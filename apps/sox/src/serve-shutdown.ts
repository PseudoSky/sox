/**
 * apps/sox/src/serve-shutdown.ts — BL-592 / docs/spec/service-lifecycle.md §8.1a
 * part D.
 *
 * `cmdServe`'s `--port` branch SIGTERM/SIGHUP wait, factored into its own
 * side-effect-free module so it is independently unit-testable with an
 * injectable `FrontShimHandle` test double. `main.ts` runs `void main()` at
 * import time (it is a CLI entrypoint, not a library), so nothing exported
 * from it can be imported directly by a unit test without invoking the whole
 * CLI — this module has no such side effect.
 *
 * `handle.close()` MUST be called before the returned promise resolves,
 * matching the non-port branch's own BL-310 fix a few lines below it in
 * `cmdServe`. Previously this wait resolved on SIGTERM/SIGINT WITHOUT ever
 * calling `handle.close()`, orphaning the shim's UDS connection to its backend
 * on every port-configured proxy-mode `mcp-server` shutdown (`FrontShimHandle.
 * close()` tears down that connection — `libs/service-proxy/src/shim.ts`).
 */
export function waitForServePortSignal(handle: { close: () => void }): Promise<void> {
  return new Promise<void>((resolve) => {
    const onSignal = () => {
      handle.close();
      resolve();
    };
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
  });
}
