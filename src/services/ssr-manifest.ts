import fs from 'node:fs';
import type { Socket } from 'node:net';
import path from 'node:path';
import type { AgnosticDataRouteMatch } from '@remix-run/router/dist/utils';
import chalk from 'chalk';
import type { RouteObject } from 'react-router-dom';
import type { Alias, ModuleNode } from 'vite';
import type { IRequestContext } from '@node/render';
import PrepareServer from '@services/prepare-server';
import ServerConfig from '@services/server-config';

interface ISsrManifestParams {
  buildDir?: string;
  viteAliases?: Alias[];
}

interface IManifest {
  [path: string]: {
    assets: string[];
    css: string[];
    file: string;
    imports: string[];
  };
}

enum AssetType {
  style = 'style',
  script = 'script',
  image = 'image',
  font = 'font',
}

interface IAsset {
  type: AssetType;
  url: string;
  content?: string;
}

const CRLF = '\r\n';

/**
 * Working with SSR Manifest file
 */
class SsrManifest {
  /**
   * Singleton
   */
  protected static instance: SsrManifest | null = null;

  /**
   * Server config
   */
  protected readonly config: ServerConfig;

  /**
   * Project root path
   */
  protected readonly root: string;

  /**
   * Build dir
   */
  protected readonly buildDir?: string;

  /**
   * Client manifest file name
   */
  protected readonly manifestName = 'manifest.json';

  /**
   * Assets manifest file name
   */
  protected readonly assetsManifest = 'assets-manifest.json';

  /**
   * Vite resolve aliases
   */
  protected readonly viteAliases?: Alias[];

  /**
   * Loaded assets manifest file
   */
  protected routesAssets: Record<string, string[]> | null = null;

  /**
   * @constructor
   */
  protected constructor(config: ServerConfig, { buildDir, viteAliases }: ISsrManifestParams = {}) {
    this.config = config;
    this.root = config.getParams().root;
    this.buildDir = buildDir;
    this.viteAliases = viteAliases ?? config.getVite()?.config?.resolve.alias;
  }

  /**
   * Get singleton instance
   */
  public static get(config: ServerConfig, params: ISsrManifestParams = {}): SsrManifest {
    if (SsrManifest.instance === null) {
      SsrManifest.instance = new SsrManifest(config, params);
    }

    return SsrManifest.instance;
  }

  /**
   * Get assets manifest file name
   */
  protected getAssetsManifestFile(): string {
    const outDir = path.resolve(this.root, this.buildDir || '');

    return `${outDir}/server/${this.assetsManifest}`;
  }

  /**
   * Load client ssr manifest
   */
  protected loadClientManifest(): IManifest {
    const clientSsrManifest = path.resolve(
      this.root,
      `${this.buildDir || ''}/client/${this.manifestName}`,
    );

    if (!fs.existsSync(clientSsrManifest)) {
      return {};
    }

    const result = JSON.parse(
      fs.readFileSync(clientSsrManifest, { encoding: 'utf-8' }),
    ) as IManifest;

    fs.rmSync(clientSsrManifest);

    return result;
  }

  /**
   * Load assets manifest
   */
  protected loadAssetsManifest(): Record<string, string[]> {
    if (this.routesAssets !== null) {
      return this.routesAssets;
    }

    const manifestFile = this.getAssetsManifestFile();

    if (!fs.existsSync(manifestFile)) {
      return {};
    }

    this.routesAssets = JSON.parse(fs.readFileSync(manifestFile, { encoding: 'utf-8' })) as Record<
      string,
      string[]
    >;

    return this.routesAssets;
  }

  /**
   * Recursive walk routes and return id's with route import path
   */
  protected async getRoutesIds(
    routes: RouteObject[],
    index?: string,
  ): Promise<Record<string, string>> {
    const result = {};

    for (const routeIndex in routes) {
      const route = routes[routeIndex];
      const routeId = [index, routeIndex].filter(Boolean).join('-');

      if (route.lazy) {
        const resolvedRoute = await route.lazy();

        result[routeId] = this.normalizeRoutePath(resolvedRoute?.['pathId'] as string);
      } else if (route.children) {
        Object.assign(result, await this.getRoutesIds(route.children, routeId));
      }
    }

    return result;
  }

  /**
   * Build routes manifest file
   */
  public async buildRoutesManifest(shouldPreloadAssets: boolean): Promise<void> {
    const prepareServer = PrepareServer.init(ServerConfig.init({ isProd: true }));
    const manifest = this.loadClientManifest();
    const { routes } = await prepareServer.loadEntrypoint(false);
    const routesPaths = await this.getRoutesIds(routes as RouteObject[]);
    const postfixes = this.getRouteImportPostfix();

    const result = {};

    // find route assets
    Object.entries(routesPaths).forEach(([routeId, routePath]) => {
      const routePostfix = postfixes.find((postfix) => {
        const filePath = `${routePath}${postfix}`;

        return manifest[filePath] !== undefined;
      });
      const routeFile = `${routePath}${routePostfix || ''}`;
      const routeMeta = manifest[routeFile];
      const routeAssets = [
        ...(routeMeta?.assets ?? []),
        ...(routeMeta?.css ?? []),
        routeMeta.file,
        ...(shouldPreloadAssets ? routeMeta?.imports ?? [] : []).map(
          (nestedAsset) => manifest[nestedAsset]?.file,
        ),
      ]
        .filter(
          (asset) =>
            // keep only js,css,image,fonts files
            asset && this.getAssetType(asset),
        )
        .map((asset) => `/${asset}`);

      if (routeAssets) {
        result[routeId] = routeAssets;
      }
    });

    fs.writeFileSync(this.getAssetsManifestFile(), JSON.stringify(result, null, 2), {
      encoding: 'utf-8',
    });
  }

  /**
   * Get vite aliases
   */
  protected getAliases(): Record<string, string> {
    const aliases = {};

    this.viteAliases?.forEach(({ find, replacement }) => {
      if (typeof find !== 'string') {
        return;
      }

      aliases[find] = replacement;
    });

    return aliases;
  }

  /**
   * Return route postfix
   */
  protected getRouteImportPostfix(): string[] {
    return ['', '/index']
      .map((prefix) => ['', '.js', '.ts', '.tsx'].map((ext) => `${prefix}${ext}`))
      .flat();
  }

  /**
   * Normalized route path
   */
  protected normalizeRoutePath(routePath?: string, withRoot = false): string | undefined {
    if (!routePath) {
      return;
    }

    let fullPath = '';

    // relative import
    if (routePath.startsWith('./') || routePath.startsWith('../')) {
      fullPath = path.resolve(this.root, routePath);
    } else {
      // alias import
      const aliases = this.getAliases();
      // get alias
      const [routeAlias] = routePath.split('/');

      if (aliases[routeAlias]) {
        fullPath = routePath.replace(routeAlias, aliases[routeAlias]);
      }
    }

    // normalize slashes
    fullPath = fullPath.split(path.win32.sep).join(path.posix.sep);

    if (withRoot) {
      return fullPath;
    }

    return fullPath.replace(this.root, '').replace(/^\/|\/$/g, '');
  }

  /**
   * Get route assets
   */
  protected getAssets(routes?: AgnosticDataRouteMatch[]): IAsset[] {
    if (this.config.getVite()) {
      return this.getAssetsDev(routes);
    }

    const routeIds = routes?.map(({ route }) => route.id).filter(Boolean) ?? [];

    if (!routeIds.length) {
      return [];
    }

    const routesAssets = this.loadAssetsManifest();

    return routeIds
      .map((routeId) => routesAssets[routeId])
      .filter(Boolean)
      .flat()
      .sort((a, b) => {
        const aWeight = this.getAssetWeight(a);
        const bWeight = this.getAssetWeight(b);

        return aWeight === bWeight ? 0 : aWeight - bWeight;
      })
      .map((url) => ({
        type: this.getAssetType(url)!,
        url,
      }));
  }

  /**
   * Get development route assets
   */
  protected getAssetsDev(routes?: AgnosticDataRouteMatch[]): IAsset[] {
    const routeIds =
      (routes
        ?.map(({ route }) => this.normalizeRoutePath(route?.['pathId'] as string, true))
        .filter(Boolean) as string[]) ?? [];

    if (!routeIds.length) {
      return [];
    }

    let assets: { [id: string]: IAsset } = {};
    const postfixes = this.getRouteImportPostfix();
    const rootId = `${this.root}/${this.config.getPluginConfig()?.clientFile ?? 'client.ts'}`;

    [rootId, ...routeIds].forEach((moduleId) => {
      for (const ext of postfixes) {
        const module = this.config.getVite()?.moduleGraph.getModuleById(`${moduleId}${ext}`);

        if (module) {
          assets = { ...assets, ...this.getModuleAssets(module) };
          break;
        }
      }
    });

    return Object.values(assets);
  }

  /**
   * Get module assets
   */
  protected getModuleAssets(module?: ModuleNode): { [id: string]: IAsset } {
    if (!module?.clientImportedModules.size) {
      return {};
    }

    let assets: { [id: string]: IAsset } = {};

    module.clientImportedModules.forEach((subModule) => {
      const { file, clientImportedModules, transformResult } = subModule;
      const ext = file?.split('.').at(-1);

      if (file && ext && ['css', 'scss'].includes(ext)) {
        // @TODO investigate better method?
        const code = transformResult?.code.match(/__vite__css\s+=\s+"(?<css>.+)"/)?.groups?.css;

        if (code) {
          try {
            assets[file] = {
              type: AssetType.style,
              url: file,
              content: JSON.parse(`{"style": "${code}"}`).style,
            };
          } catch (e) {
            console.warn(chalk.yellowBright('Failed to parse style: ', file));
          }
        }
      } else if (clientImportedModules.size) {
        assets = {
          ...assets,
          ...this.getModuleAssets(subModule),
        };
      }
    });

    return assets;
  }

  /**
   * Get asset weight
   */
  protected getAssetWeight(asset: string): number {
    const type = this.getAssetType(asset);

    switch (type) {
      case 'style':
        return 1;

      case 'script':
        return 2;

      default:
        return 3;
    }
  }

  /**
   * Get asset type
   */
  protected getAssetType(asset: string): AssetType | null {
    const ext = asset.split('.').at(-1)?.toLowerCase();

    switch (ext) {
      case 'css':
      case 'scss':
        return AssetType.style;

      case 'js':
        return AssetType.script;

      case 'svg':
      case 'jpg':
      case 'jpeg':
      case 'png':
      case 'webp':
      case 'gif':
      case 'ico':
        return AssetType.image;

      case 'ttf':
      case 'otf':
      case 'woff':
      case 'woff2':
        return AssetType.font;

      default:
        return null;
    }
  }

  /**
   * Write 103 Early Hits header
   */
  public writeEarlyHits(assets: IAsset[], socket: Socket): void {
    socket.write(`HTTP/1.1 103 Early Hints${CRLF}`);
    assets.forEach(({ type, url }) => {
      if (!type || !['style', 'script'].includes(type)) {
        return;
      }

      socket.write(`Link: <${url}>; rel=preload; as=${type}${CRLF}`);
    });
    socket.write(CRLF);
  }

  /**
   * Inject route assets to head html
   */
  public injectAssets({ routerContext, html, res, hasEarlyHints = false }: IRequestContext): void {
    const assets = this.getAssets(routerContext?.matches);
    const htmlAssets = assets
      .map(({ type, url, content = '' }) => {
        switch (type) {
          case 'style':
            return this.config.getVite()
              ? `<style data-vite-dev-id="${url}">${content}</style>`
              : `<link rel="stylesheet" href="${url}">`;

          case 'script':
            return `<script async type="module" src="${url}"></script>`;
        }

        return null;
      })
      .filter(Boolean);

    html.header = html.header.replace('</head>', `${htmlAssets.join('\n')}</head>`);

    if (hasEarlyHints && htmlAssets.length && res.socket) {
      this.writeEarlyHits(assets, res.socket);
    }
  }
}

export default SsrManifest;
