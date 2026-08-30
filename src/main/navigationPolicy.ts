const parseUrl = (value: string): URL | undefined => {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
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

export const isApprovedExternalUrl = (value: string): boolean =>
  parseUrl(value)?.protocol === 'https:';
