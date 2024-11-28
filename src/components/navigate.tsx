import type { FC } from 'react';
import React from 'react';
import type { NavigateProps } from 'react-router-dom';
import { Navigate as DefaultNavigate } from 'react-router-dom';
import { useServerContext } from '@context/server';

interface INavigate {
  status?: number;
}

type TProps = INavigate & NavigateProps;

/**
 * React router navigate with server support
 * @constructor
 */
const Navigate: FC<TProps> = ({ to, status = 301, ...rest }) => {
  const context = useServerContext();

  if (!context.isServer) {
    return <DefaultNavigate to={to} {...rest} />;
  }

  if (context) {
    const { basename } = context;
    const location =
      typeof to === 'string'
        ? [basename, to].filter(Boolean).join('')
        : [basename, to.pathname, to.search, to.hash].filter(Boolean).join('');

    context.response = new Response('', { status, headers: new Headers({ Location: location }) });
  }

  return null;
};

export default Navigate;
