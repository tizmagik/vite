/**
 * This file is refactored into TypeScript based on
 * https://github.com/preactjs/wmr/blob/main/packages/wmr/src/lib/rollup-plugin-container.js
 */

/**
https://github.com/preactjs/wmr/blob/master/LICENSE

MIT License

Copyright (c) 2020 The Preact Authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

import fs from 'node:fs'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createRequire } from 'node:module'
import type {
  EmittedFile,
  InputOptions,
  LoadResult,
  MinimalPluginContext,
  ModuleInfo,
  NormalizedInputOptions,
  OutputOptions,
  PartialResolvedId,
  ResolvedId,
  RollupError,
  PluginContext as RollupPluginContext,
  SourceDescription,
  SourceMap,
  TransformResult
} from 'rollup'
import * as acorn from 'acorn'
import type { RawSourceMap } from '@ampproject/remapping'
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping'
import MagicString from 'magic-string'
import type { FSWatcher } from 'chokidar'
import colors from 'picocolors'
import type * as postcss from 'postcss'
import type { Plugin } from '../plugin'
import {
  cleanUrl,
  combineSourcemaps,
  createDebugger,
  ensureWatchedFile,
  generateCodeFrame,
  isExternalUrl,
  isObject,
  normalizePath,
  numberToPos,
  prettifyUrl,
  timeFrom
} from '../utils'
import { FS_PREFIX } from '../constants'
import type { ResolvedConfig } from '../config'
import { buildErrorMessage } from './middlewares/error'
import type { ModuleGraph } from './moduleGraph'

export interface PluginContainerOptions {
  cwd?: string
  output?: OutputOptions
  modules?: Map<string, { info: ModuleInfo }>
  writeFile?: (name: string, source: string | Uint8Array) => void
}

export interface PluginContainer {
  options: InputOptions
  getModuleInfo(id: string): ModuleInfo | null
  buildStart(options: InputOptions): Promise<void>
  resolveId(
    id: string,
    importer?: string,
    options?: {
      skip?: Set<Plugin>
      ssr?: boolean
      /**
       * @internal
       */
      scan?: boolean
    }
  ): Promise<PartialResolvedId | null>
  transform(
    code: string,
    id: string,
    options?: {
      inMap?: SourceDescription['map']
      ssr?: boolean
    }
  ): Promise<SourceDescription | null>
  load(
    id: string,
    options?: {
      ssr?: boolean
    }
  ): Promise<LoadResult | null>
  close(): Promise<void>
}

type PluginContext = Omit<
  RollupPluginContext,
  // not documented
  | 'cache'
  // deprecated
  | 'emitAsset'
  | 'emitChunk'
  | 'getAssetFileName'
  | 'getChunkFileName'
  | 'isExternal'
  | 'moduleIds'
  | 'resolveId'
  | 'load'
>

export let parser = acorn.Parser

export async function createPluginContainer(
  { plugins, logger, root, build: { rollupOptions } }: ResolvedConfig,
  moduleGraph?: ModuleGraph,
  watcher?: FSWatcher
): Promise<PluginContainer> {
  const isDebug = process.env.DEBUG

  const seenResolves: Record<string, true | undefined> = {}
  const debugResolve = createDebugger('vite:resolve')
  const debugPluginResolve = createDebugger('vite:plugin-resolve', {
    onlyWhenFocused: 'vite:plugin'
  })
  const debugPluginTransform = createDebugger('vite:plugin-transform', {
    onlyWhenFocused: 'vite:plugin'
  })

  // ---------------------------------------------------------------------------

  const watchFiles = new Set<string>()

  // TODO: use import()
  const _require = createRequire(import.meta.url)

  // get rollup version
  const rollupPkgPath = resolve(
    _require.resolve('rollup'),
    '../../package.json'
  )
  const minimalContext: MinimalPluginContext = {
    meta: {
      rollupVersion: JSON.parse(fs.readFileSync(rollupPkgPath, 'utf-8'))
        .version,
      watchMode: true
    }
  }

  function warnIncompatibleMethod(method: string, plugin: string) {
    logger.warn(
      colors.cyan(`[plugin:${plugin}] `) +
        colors.yellow(
          `context method ${colors.bold(
            `${method}()`
          )} is not supported in serve mode. This plugin is likely not vite-compatible.`
        )
    )
  }

  // throw when an unsupported ModuleInfo property is accessed,
  // so that incompatible plugins fail in a non-cryptic way.
  const ModuleInfoProxy: ProxyHandler<ModuleInfo> = {
    get(info: any, key: string) {
      if (key in info) {
        return info[key]
      }
      throw Error(
        `[vite] The "${key}" property of ModuleInfo is not supported.`
      )
    }
  }

  // same default value of "moduleInfo.meta" as in Rollup
  const EMPTY_OBJECT = Object.freeze({})

  function getModuleInfo(id: string) {
    const module = moduleGraph?.getModuleById(id)
    if (!module) {
      return null
    }
    if (!module.info) {
      module.info = new Proxy(
        { id, meta: module.meta || EMPTY_OBJECT } as ModuleInfo,
        ModuleInfoProxy
      )
    }
    return module.info
  }

  function updateModuleInfo(id: string, { meta }: { meta?: object | null }) {
    if (meta) {
      const moduleInfo = getModuleInfo(id)
      if (moduleInfo) {
        moduleInfo.meta = { ...moduleInfo.meta, ...meta }
      }
    }
  }

  // we should create a new context for each async hook pipeline so that the
  // active plugin in that pipeline can be tracked in a concurrency-safe manner.
  // using a class to make creating new contexts more efficient
  class Context implements PluginContext {
    meta = minimalContext.meta
    ssr = false
    _scan = false
    _activePlugin: Plugin | null
    _activeId: string | null = null
    _activeCode: string | null = null
    _resolveSkips?: Set<Plugin>
    _addedImports: Set<string> | null = null

    constructor(initialPlugin?: Plugin) {
      this._activePlugin = initialPlugin || null
    }

    parse(code: string, opts: any = {}) {
      return parser.parse(code, {
        sourceType: 'module',
        ecmaVersion: 'latest',
        locations: true,
        ...opts
      })
    }

    async resolve(
      id: string,
      importer?: string,
      options?: { skipSelf?: boolean }
    ) {
      let skip: Set<Plugin> | undefined
      if (options?.skipSelf && this._activePlugin) {
        skip = new Set(this._resolveSkips)
        skip.add(this._activePlugin)
      }
      let out = await container.resolveId(id, importer, {
        skip,
        ssr: this.ssr,
        scan: this._scan
      })
      if (typeof out === 'string') out = { id: out }
      return out as ResolvedId | null
    }

    getModuleInfo(id: string) {
      return getModuleInfo(id)
    }

    getModuleIds() {
      return moduleGraph
        ? moduleGraph.idToModuleMap.keys()
        : Array.prototype[Symbol.iterator]()
    }

    addWatchFile(id: string) {
      watchFiles.add(id)
      ;(this._addedImports || (this._addedImports = new Set())).add(id)
      if (watcher) ensureWatchedFile(watcher, id, root)
    }

    getWatchFiles() {
      return [...watchFiles]
    }

    emitFile(assetOrFile: EmittedFile) {
      warnIncompatibleMethod(`emitFile`, this._activePlugin!.name)
      return ''
    }

    setAssetSource() {
      warnIncompatibleMethod(`setAssetSource`, this._activePlugin!.name)
    }

    getFileName() {
      warnIncompatibleMethod(`getFileName`, this._activePlugin!.name)
      return ''
    }

    warn(
      e: string | RollupError,
      position?: number | { column: number; line: number }
    ) {
      const err = formatError(e, position, this)
      const msg = buildErrorMessage(
        err,
        [colors.yellow(`warning: ${err.message}`)],
        false
      )
      logger.warn(msg, {
        clear: true,
        timestamp: true
      })
    }

    error(
      e: string | RollupError,
      position?: number | { column: number; line: number }
    ): never {
      // error thrown here is caught by the transform middleware and passed on
      // the the error middleware.
      throw formatError(e, position, this)
    }
  }

  function formatError(
    e: string | RollupError,
    position: number | { column: number; line: number } | undefined,
    ctx: Context
  ) {
    const err = (
      typeof e === 'string' ? new Error(e) : e
    ) as postcss.CssSyntaxError & RollupError
    if (err.pluginCode) {
      return err // The plugin likely called `this.error`
    }
    if (err.file && err.name === 'CssSyntaxError') {
      err.id = normalizePath(err.file)
    }
    if (ctx._activePlugin) err.plugin = ctx._activePlugin.name
    if (ctx._activeId && !err.id) err.id = ctx._activeId
    if (ctx._activeCode) {
      err.pluginCode = ctx._activeCode

      const pos =
        position != null
          ? position
          : err.pos != null
          ? err.pos
          : // some rollup plugins, e.g. json, sets position instead of pos
            (err as any).position

      if (pos != null) {
        let errLocation
        try {
          errLocation = numberToPos(ctx._activeCode, pos)
        } catch (err2) {
          logger.error(
            colors.red(
              `Error in error handler:\n${err2.stack || err2.message}\n`
            ),
            // print extra newline to separate the two errors
            { error: err2 }
          )
          throw err
        }
        err.loc = err.loc || {
          file: err.id,
          ...errLocation
        }
        err.frame = err.frame || generateCodeFrame(ctx._activeCode, pos)
      } else if (err.loc) {
        // css preprocessors may report errors in an included file
        if (!err.frame) {
          let code = ctx._activeCode
          if (err.loc.file) {
            err.id = normalizePath(err.loc.file)
            try {
              code = fs.readFileSync(err.loc.file, 'utf-8')
            } catch {}
          }
          err.frame = generateCodeFrame(code, err.loc)
        }
      } else if ((err as any).line && (err as any).column) {
        err.loc = {
          file: err.id,
          line: (err as any).line,
          column: (err as any).column
        }
        err.frame = err.frame || generateCodeFrame(err.id!, err.loc)
      }

      if (err.loc && ctx instanceof TransformContext) {
        const rawSourceMap = ctx._getCombinedSourcemap()
        if (rawSourceMap) {
          const traced = new TraceMap(rawSourceMap as any)
          const { source, line, column } = originalPositionFor(traced, {
            line: Number(err.loc.line),
            column: Number(err.loc.column)
          })
          if (source && line != null && column != null) {
            err.loc = { file: source, line, column }
          }
        }
      }
    }
    return err
  }

  class TransformContext extends Context {
    filename: string
    originalCode: string
    originalSourcemap: SourceMap | null = null
    sourcemapChain: NonNullable<SourceDescription['map']>[] = []
    combinedMap: SourceMap | null = null

    constructor(filename: string, code: string, inMap?: SourceMap | string) {
      super()
      this.filename = filename
      this.originalCode = code
      if (inMap) {
        this.sourcemapChain.push(inMap)
      }
    }

    _getCombinedSourcemap(createIfNull = false) {
      let combinedMap = this.combinedMap
      for (let m of this.sourcemapChain) {
        if (typeof m === 'string') m = JSON.parse(m)
        if (!('version' in (m as SourceMap))) {
          // empty, nullified source map
          combinedMap = this.combinedMap = null
          this.sourcemapChain.length = 0
          break
        }
        if (!combinedMap) {
          combinedMap = m as SourceMap
        } else {
          combinedMap = combineSourcemaps(cleanUrl(this.filename), [
            {
              ...(m as RawSourceMap),
              sourcesContent: combinedMap.sourcesContent
            },
            combinedMap as RawSourceMap
          ]) as SourceMap
        }
      }
      if (!combinedMap) {
        return createIfNull
          ? new MagicString(this.originalCode).generateMap({
              includeContent: true,
              hires: true,
              source: cleanUrl(this.filename)
            })
          : null
      }
      if (combinedMap !== this.combinedMap) {
        this.combinedMap = combinedMap
        this.sourcemapChain.length = 0
      }
      return this.combinedMap
    }

    getCombinedSourcemap() {
      return this._getCombinedSourcemap(true) as SourceMap
    }
  }

  let closed = false

  const container: PluginContainer = {
    options: await (async () => {
      let options = rollupOptions
      for (const plugin of plugins) {
        if (!plugin.options) continue
        options =
          (await plugin.options.call(minimalContext, options)) || options
      }
      if (options.acornInjectPlugins) {
        parser = acorn.Parser.extend(options.acornInjectPlugins as any)
      }
      return {
        acorn,
        acornInjectPlugins: [],
        ...options
      }
    })(),

    getModuleInfo,

    async buildStart() {
      await Promise.all(
        plugins.map((plugin) => {
          if (plugin.buildStart) {
            return plugin.buildStart.call(
              new Context(plugin) as any,
              container.options as NormalizedInputOptions
            )
          }
        })
      )
    },

    async resolveId(rawId, importer = join(root, 'index.html'), options) {
      const skip = options?.skip
      const ssr = options?.ssr
      const scan = !!options?.scan
      const ctx = new Context()
      ctx.ssr = !!ssr
      ctx._scan = scan
      ctx._resolveSkips = skip
      const resolveStart = isDebug ? performance.now() : 0

      let id: string | null = null
      const partial: Partial<PartialResolvedId> = {}
      for (const plugin of plugins) {
        if (!plugin.resolveId) continue
        if (skip?.has(plugin)) continue

        ctx._activePlugin = plugin

        const pluginResolveStart = isDebug ? performance.now() : 0
        const result = await plugin.resolveId.call(
          ctx as any,
          rawId,
          importer,
          { ssr, scan }
        )
        if (!result) continue

        if (typeof result === 'string') {
          id = result
        } else {
          id = result.id
          Object.assign(partial, result)
        }

        isDebug &&
          debugPluginResolve(
            timeFrom(pluginResolveStart),
            plugin.name,
            prettifyUrl(id, root)
          )

        // resolveId() is hookFirst - first non-null result is returned.
        break
      }

      if (isDebug && rawId !== id && !rawId.startsWith(FS_PREFIX)) {
        const key = rawId + id
        // avoid spamming
        if (!seenResolves[key]) {
          seenResolves[key] = true
          debugResolve(
            `${timeFrom(resolveStart)} ${colors.cyan(rawId)} -> ${colors.dim(
              id
            )}`
          )
        }
      }

      if (id) {
        partial.id = isExternalUrl(id) ? id : normalizePath(id)
        return partial as PartialResolvedId
      } else {
        return null
      }
    },

    async load(id, options) {
      const ssr = options?.ssr
      const ctx = new Context()
      ctx.ssr = !!ssr
      for (const plugin of plugins) {
        if (!plugin.load) continue
        ctx._activePlugin = plugin
        const result = await plugin.load.call(ctx as any, id, { ssr })
        if (result != null) {
          if (isObject(result)) {
            updateModuleInfo(id, result)
          }
          return result
        }
      }
      return null
    },

    async transform(code, id, options) {
      const inMap = options?.inMap
      const ssr = options?.ssr
      const ctx = new TransformContext(id, code, inMap as SourceMap)
      ctx.ssr = !!ssr
      for (const plugin of plugins) {
        if (!plugin.transform) continue
        ctx._activePlugin = plugin
        ctx._activeId = id
        ctx._activeCode = code
        const start = isDebug ? performance.now() : 0
        let result: TransformResult | string | undefined
        try {
          result = await plugin.transform.call(ctx as any, code, id, { ssr })
        } catch (e) {
          ctx.error(e)
        }
        if (!result) continue
        isDebug &&
          debugPluginTransform(
            timeFrom(start),
            plugin.name,
            prettifyUrl(id, root)
          )
        if (isObject(result)) {
          if (result.code !== undefined) {
            code = result.code
            if (result.map) {
              ctx.sourcemapChain.push(result.map)
            }
          }
          updateModuleInfo(id, result)
        } else {
          code = result
        }
      }
      return {
        code,
        map: ctx._getCombinedSourcemap()
      }
    },

    async close() {
      if (closed) return
      const ctx = new Context()
      await Promise.all(
        plugins.map((p) => p.buildEnd && p.buildEnd.call(ctx as any))
      )
      await Promise.all(
        plugins.map((p) => p.closeBundle && p.closeBundle.call(ctx as any))
      )
      closed = true
    }
  }

  return container
}
