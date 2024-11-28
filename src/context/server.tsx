import type { FC, PropsWithChildren } from 'react';
import React, { useContext } from 'react';

export interface IServerContext {
  response: Response | null;
  isServer: boolean;
  basename?: string;
}

const initState = {
  response: null,
  isServer: false,
};

/**
 * Server application context
 */
const ServerContext = React.createContext<IServerContext>(initState);

interface IServerProvider {
  context: IServerContext;
}

/**
 * Server application context provider
 * @constructor
 */
const ServerProvider: FC<PropsWithChildren<IServerProvider>> = ({ children, context }) => (
  <ServerContext.Provider value={context} children={children} />
);

const useServerContext = (): IServerContext => useContext(ServerContext);

export { ServerContext, ServerProvider, useServerContext };
