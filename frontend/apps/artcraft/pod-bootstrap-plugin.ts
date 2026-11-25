import { build, type Plugin } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import path from "node:path";

const FILE_NAME = "pod-bootstrap.js";

/**
 * Bundles app/src/bootstrap.ts into one classic (non-module, non-deferred) script served and
 * emitted as /pod-bootstrap.js, so index.html can make it the first thing the page runs
 * instead of relying on bundler ordering.
 */
export function podBootstrapPlugin(opts: { entry: string; workspaceRoot: string }): Plugin {
  let cached: Promise<string> | undefined;

  const bundle = async (): Promise<string> => {
    const result = await build({
      configFile: false,
      logLevel: "silent",
      root: path.dirname(opts.entry),
      publicDir: false,
      plugins: [tsconfigPaths({ projects: [path.resolve(opts.workspaceRoot, "tsconfig.base.json")] })],
      build: {
        write: false,
        minify: true,
        target: "es2020",
        lib: { entry: opts.entry, name: "ArtcraftBootstrap", formats: ["iife"], fileName: () => FILE_NAME },
      },
    });
    const outputs = Array.isArray(result) ? result : [result];
    const chunk = (outputs as any[]).flatMap((o) => o.output).find((o: any) => o.type === "chunk");
    if (!chunk) throw new Error("pod-bootstrap: no chunk emitted");
    return chunk.code as string;
  };
  const get = () => (cached ??= bundle());

  return {
    name: "pod-bootstrap",
    configureServer(server) {
      server.middlewares.use(`/${FILE_NAME}`, (_req, res, next) => {
        get()
          .then((code) => {
            res.setHeader("Content-Type", "text/javascript");
            res.setHeader("Cache-Control", "no-store");
            res.end(code);
          })
          .catch(next);
      });
    },
    async generateBundle() {
      this.emitFile({ type: "asset", fileName: FILE_NAME, source: await get() });
    },
  };
}
