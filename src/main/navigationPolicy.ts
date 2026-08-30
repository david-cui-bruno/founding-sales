const parseUrl = (value: string): URL | undefined => {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
};

const productionRendererUrl = 'callie://app/index.html';
const expectedDevelopmentRendererOrigin = 'http://localhost:5173';

export type RendererTrust = {
  isTrustedRendererUrl(value: string): boolean;
  rendererUrl: string;
};

export type RendererTrustOptions = {
  developmentRendererUrl?: string;
  isPackaged: boolean;
};

export const isTrustedRendererUrl = (value: string): boolean => {
  const url = parseUrl(value);

  return (
    url?.protocol === 'callie:' &&
    url.hostname === 'app' &&
    url.port === '' &&
    url.username === '' &&
    url.password === ''
  );
};

const configuredDevelopmentRendererUrl = (
  value: string | undefined,
): string | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const url = parseUrl(value);
  if (
    url?.origin !== expectedDevelopmentRendererOrigin ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    return undefined;
  }

  return url.href;
};

export const createRendererTrust = (
  options: RendererTrustOptions,
): RendererTrust => {
  const developmentRendererUrl = options.isPackaged
    ? undefined
    : configuredDevelopmentRendererUrl(options.developmentRendererUrl);

  return {
    rendererUrl: developmentRendererUrl ?? productionRendererUrl,
    isTrustedRendererUrl: (value: string): boolean =>
      isTrustedRendererUrl(value) || value === developmentRendererUrl,
  };
};

export const isApprovedExternalUrl = (value: string): boolean =>
  parseUrl(value)?.protocol === 'https:';
