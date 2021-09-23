import { UserConfig, ConfigEnv } from 'vite'
import {
  ConfigTypeSet,
  RemotesConfig,
  VitePluginFederationOptions
} from 'types'
import { walk } from 'estree-walker'
import MagicString from 'magic-string'
import { AcornNode, TransformPluginContext } from 'rollup'
import { PluginHooks } from '../types/pluginHooks'
import { parseOptions, getModuleMarker } from './utils'
import { IMPORT_ALIAS } from './public'
import { shared } from './shared'

export let providedRemotes

export function remotesPlugin(
  options: VitePluginFederationOptions
): PluginHooks {
  providedRemotes = parseOptions(
    options.remotes ? options.remotes : {},
    (item) => ({
      external: Array.isArray(item) ? item : [item],
      shareScope: options.shareScope || 'default'
    }),
    (item) => ({
      external: Array.isArray(item.external) ? item.external : [item.external],
      shareScope: item.shareScope || options.shareScope || 'default'
    })
  )
  const remotes: { id: string; config: RemotesConfig }[] = []
  for (const item of providedRemotes) {
    remotes.push({ id: item[0], config: item[1] })
  }

  return {
    name: 'originjs:remotes',
    virtualFile: {
      __federation__: `
            const remotesMap = {
              ${remotes
                .map(
                  (remote) =>
                    `${JSON.stringify(remote.id)}: () => ${
                      options.mode === 'development' ? 'import' : IMPORT_ALIAS
                    }(${JSON.stringify(remote.config.external[0])})`
                )
                .join(',\n  ')}
            };
            const processModule = (mod) => {
              if (mod && mod.__useDefault) {
                return mod.default;
              }
              return mod;
            }
          
            const shareScope = {
              ${
                options.mode === 'development'
                  ? ''
                  : getModuleMarker('shareScope')
              }
            };
            const initMap = {};
            export default {
              ensure: async (remoteId) => {
                const remote = await remotesMap[remoteId]();
                if (!initMap[remoteId]) {
                  remote.init(shareScope);
                  initMap[remoteId] = true;
                }
                return remote;
              }
            };`
    },
    config(config: UserConfig, env: ConfigEnv) {
      // need to include remotes in the optimizeDeps.exclude
      if (options.mode === 'development') {
        let excludeRemotes: string[] = []
        for (const providedRemote of providedRemotes) {
          excludeRemotes.push(providedRemote[0])
        }
        if (
          config !== undefined &&
          config.optimizeDeps !== undefined &&
          config.optimizeDeps.exclude !== undefined
        ) {
          excludeRemotes = excludeRemotes.concat(config.optimizeDeps.exclude)
        }

        Object.assign(config, { optimizeDeps: { exclude: excludeRemotes } })
      }
    },
    transform(
      this: TransformPluginContext,
      code: string,
      id: string,
      ssr?: boolean | undefined
    ) {
      if (options.mode !== 'development' && id === '\0virtual:__federation__') {
        return code.replace(
          getModuleMarker('shareScope'),
          sharedScopeCode(shared).join(',')
        )
      }
      if (remotes.length === 0 || id.includes('node_modules')) {
        return null
      }
      if (!/import/.test(code)) {
        return null
      }

      let ast: AcornNode | null = null
      try {
        ast = this.parse(code)
      } catch (err) {
        console.error(err)
      }
      if (!ast) {
        return null
      }

      const magicString = new MagicString(code)
      let requiresRuntime = false
      walk(ast, {
        enter(node: any) {
          if (node.type === 'ImportExpression') {
            if (node.source && node.source.value) {
              const moduleId = node.source.value
              const remote = remotes.find((r) => moduleId.startsWith(r.id))

              if (remote) {
                requiresRuntime = true
                const modName = `.${moduleId.slice(remote.id.length)}`

                magicString.overwrite(
                  node.start,
                  node.end,
                  `__federation__.ensure(${JSON.stringify(
                    remote.id
                  )}).then((remote) => remote.get(${JSON.stringify(modName)}))`
                )
              }
            }
          }
        }
      })

      if (requiresRuntime) {
        magicString.prepend(`import __federation__ from '__federation__';\n\n`)
      }

      return {
        code: magicString.toString(),
        map: null
      }
    }
  }

  function sharedScopeCode(shared: (string | ConfigTypeSet)[]): string[] {
    const res: string[] = []
    const displayField = new Set<string>()
    displayField.add('version')
    displayField.add('shareScope')
    if (shared.length) {
      shared.forEach((arr) => {
        const sharedName = arr[0]
        const obj = arr[1]
        let str = ''
        if (typeof obj === 'object') {
          Object.entries(obj).forEach(([key, value]) => {
            if (displayField.has(key))
              str += `${key}:${JSON.stringify(value)}, \n`
          })
          str += `get: ()=> ${IMPORT_ALIAS}('${getModuleMarker(
            `\${${sharedName}}`,
            'shareScope'
          )}')`
          res.push(`'${sharedName}':{${str}}`)
        }
      })
    }
    return res
  }
}
