import htmlEscape from '@helpers/html-escape';
import type { IRenderOptions } from '@node/render';

/**
 * Build custom state
 */
function buildCustomState(initState?: ReturnType<NonNullable<IRenderOptions['getState']>>): string {
  const stateScripts = Object.entries(initState ?? {}).map(([key, state]) => {
    if (!key || !state || !Object.keys(state || {}).length) {
      return '';
    }

    const json = htmlEscape(JSON.stringify(JSON.stringify(state)));

    return `<script async>window.${key} = JSON.parse(${json});</script>`;
  });

  return stateScripts.join('').trim();
}

export default buildCustomState;
