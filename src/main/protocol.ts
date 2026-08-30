import { net, protocol } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isTrustedRendererUrl } from './navigationPolicy';

export const resolveRendererAsset = (
  rendererRoot: string,
  requestPath: string,
): string => {
  let decodedPath: string;

  try {
    decodedPath = decodeURIComponent(requestPath);
  } catch {
    throw new Error('Renderer asset path is not valid percent-encoding');
  }

  if (decodedPath.includes('\0')) {
    throw new Error('Renderer asset path contains a null byte');
  }

  const normalizedRoot = path.resolve(rendererRoot);
  const resolvedAsset = path.resolve(
    normalizedRoot,
    `.${decodedPath.startsWith('/') ? decodedPath : `/${decodedPath}`}`,
  );
  const rootPrefix = normalizedRoot.endsWith(path.sep)
    ? normalizedRoot
    : `${normalizedRoot}${path.sep}`;

  if (resolvedAsset !== normalizedRoot && !resolvedAsset.startsWith(rootPrefix)) {
    throw new Error('Renderer asset path escapes the renderer bundle');
  }

  return resolvedAsset;
};

export const registerCallieProtocol = (rendererRoot: string): void => {
  protocol.handle('callie', (request) => {
    if (!isTrustedRendererUrl(request.url)) {
      return new Response('Not found', { status: 404 });
    }

    try {
      const requestUrl = new URL(request.url);
      const requestPath =
        requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname;
      const assetPath = resolveRendererAsset(rendererRoot, requestPath);

      return net.fetch(pathToFileURL(assetPath).toString());
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
};
