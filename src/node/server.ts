import http from 'node:http';
import https from 'node:https';
import type { Server } from 'node:net';
import path from 'path';
import compression from 'compression';
import type { Express } from 'express';
import express from 'express';
import printServerInfo from '@helpers/print-server-info';
import type { IRequestContext } from '@node/render';
import PrepareServer from '@services/prepare-server';
import ServerApi from '@services/server-api';
import type ServerConfig from '@services/server-config';

export interface ICreateServerOut {
  run: (options?: { version?: string; isPrintInfo?: boolean }) => Server;
  app: Express;
}

/**
 * Create SSR server
 */
async function createServer(config: ServerConfig): Promise<ICreateServerOut> {
  const app = express().disable('x-powered-by');
  const serverApi = new ServerApi();

  config.setApp(app);

  const prepareServer = PrepareServer.init(config, serverApi);

  if (!config.isProd) {
    // Create Vite server in middleware mode and configure the app type as
    // 'custom', disabling Vite's own HTML serving logic so parent server
    // can take control
    const vite = await (
      await import('vite')
    ).createServer({
      server: {
        middlewareMode: true,
        watch: {
          // During tests, we edit the files too fast and sometimes chokidar
          // misses change events, so enforce polling for consistency
          usePolling: true,
          interval: 100,
        },
      },
      appType: 'custom',
      mode: config.mode,
    });

    // Use vite's connect instance as middleware
    app.use(vite.middlewares);

    config.setVite(vite);
  }

  const { isSPA } = config.getParams();

  if (!isSPA) {
    await prepareServer.onAppCreated();
  }

  if (config.isProd) {
    const { root, publicDir } = config.getParams();
    const { compression: compressionConfig, expressStatic } = prepareServer.getMiddlewaresConfig();

    if (compressionConfig) {
      app.use(compression(compressionConfig));
    }

    if (!isSPA) {
      // ignore index.html file in SSR mode
      app.use((req, _, next) => {
        if (req.url === '/index.html' && !serverApi.hasAccessIndexHtml()) {
          req.url = '/index-not-found.html';
        }

        next();
      });
    }

    if (expressStatic) {
      const { basename, ...expressStaticOpts } = expressStatic;

      app.use(
        basename!,
        express.static(path.resolve(`${root}/${publicDir}`), {
          ...expressStaticOpts,
          index: isSPA ? undefined : false,
        }),
      );
    }
  }

  // SSR mode
  if (!isSPA) {
    app.use('*', (req, res, next) => {
      void (async () => {
        try {
          const [{ render, onRequest, ...renderParams }, clientHtml] = await Promise.all([
            prepareServer.loadEntrypoint(),
            prepareServer.loadHtml(req),
          ]);
          const { appProps, hasEarlyHints, shouldSkip } = (await onRequest?.(req, res)) ?? {};
          const [header, footer] = clientHtml;

          if (shouldSkip) {
            return next();
          }

          const context: IRequestContext = {
            req,
            res,
            hasEarlyHints,
            appProps: appProps ?? {},
            html: { header, footer },
          };

          await render(config, context, renderParams);
        } catch (e) {
          config
            .getLogger()
            .error(`Failed to handle request: ${(e as Error)?.message}`, { error: e as Error });
          next();
        }
      })();
    });
  } else {
    // SPA mode, redirect any request to index.html
    app.use('*', (req, res, next) => {
      void (async () => {
        try {
          const html = (await prepareServer.loadHtml(req)).join('');

          res.send(html);
        } catch (e) {
          config
            .getLogger()
            .error(`Failed to handle request: ${(e as Error)?.message}`, { error: e as Error });
          next();
        }
      })();
    });
  }

  return {
    run: ({ version, isPrintInfo = true } = {}): Server => {
      const { port, host } = config.getParams();
      const isHTTPS = Boolean(config.getVite()?.config?.server?.https);

      // update resolved host for print network link
      if (config.isHost && !config.isProd) {
        config.getVite()!.config.server.host = host;
      }

      const server = (
        isHTTPS
          ? https.createServer(config.getVite()!.config.server.https!, app)
          : http.createServer(app)
      ).listen(port, host, () => {
        void prepareServer.onServerStarted?.(app, serverApi, server);

        if (!isPrintInfo) {
          return;
        }

        void printServerInfo(config, { version, server });
      });

      return server;
    },
    app,
  };
}

export default createServer;
