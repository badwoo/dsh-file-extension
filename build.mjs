/**
 * Build the two published artifacts.
 *
 * The Host half is a normal ES module. The Client half must be a plain
 * `window.__ModuleLoader__.load({ id, factory })` bundle, because the browser
 * module system only registers factories — it never evaluates a package's own
 * module graph.
 *
 * @module dsh-file-extension/build
 */

import { build } from 'esbuild'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Package name: the loader keys the Client factory by it. */
const PACKAGE_NAME = 'dsh-file-extension'

const root = dirname(fileURLToPath(import.meta.url))
const out = resolve(root, 'lib')

/** Modules the page already provides; the bundle must resolve them, never inline them. */
const PLATFORM_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

/**
 * Wrap an ES module bundle as a module-loader factory.
 *
 * The wrapper keeps the module's exports reachable through the factory's return
 * value, which is how a Client plugin exposes `inject` and `apply`.
 *
 * The body arrives as CommonJS source, so the wrapper supplies `module`,
 * `exports`, and `require`; the factory returns the resulting exports object.
 *
 * @param {string} id - the package name the loader keys the factory by.
 * @returns {object} an esbuild plugin.
 */
function moduleLoaderFormat(id) {
  return {
    name: 'dsh-module-loader',
    setup(pluginBuild) {
      pluginBuild.onEnd(async (result) => {
        if (result.errors.length > 0) return
        const output = result.outputFiles?.[0]
        if (output === undefined) return
        const body = output.text
        const wrapped = [
          'window.__ModuleLoader__.load({',
          `  id: ${JSON.stringify(id)},`,
          '  factory(require) {',
          '    const module = { exports: {} };',
          '    const exports = module.exports;',
          '    (function (module, exports, require) {',
          body,
          '    })(module, exports, require);',
          '    return module.exports;',
          '  },',
          '});',
          '',
        ].join('\n')
        await writeFile(resolve(out, 'client.js'), wrapped, 'utf8')
      })
    },
  }
}

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })

// Host half: a plain ESM module the Loader imports directly.
await build({
  entryPoints: [resolve(root, 'src/host/index.js')],
  outfile: resolve(out, 'index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  sourcemap: false,
  legalComments: 'none',
  // Node built-ins and the harness's own services stay external: the Host half
  // is imported by the running process, not packaged with its dependencies.
  external: ['node:*'],
  logLevel: 'info',
})

// Client half: a CommonJS body wrapped in the loader factory, with React and the
// platform module table left for the page to resolve.
const clientResult = await build({
  entryPoints: [resolve(root, 'src/client/index.js')],
  outfile: resolve(out, 'client.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  sourcemap: false,
  legalComments: 'none',
  external: PLATFORM_EXTERNALS,
  write: false,
  plugins: [moduleLoaderFormat(PACKAGE_NAME)],
  logLevel: 'info',
})

if (clientResult.errors.length > 0) {
  console.error('client build failed')
  process.exitCode = 1
}

console.log('built lib/index.js and lib/client.js')
