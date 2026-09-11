const { isBuiltin } = require('node:module');
const { dirname } = require('node:path');
const ts = require('typescript');
exports.interfaceVersion = 2;
exports.resolve = (source, file) => {
  if (isBuiltin(source)) return { found: true, path: null };
  try {
    const configPath = ts.findConfigFile(dirname(file), ts.sys.fileExists, 'tsconfig.json');
    if (!configPath) return { found: false };
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) return { found: false };
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
    if (parsed.errors.length) return { found: false };
    const resolved = ts.resolveModuleName(source, file, parsed.options, ts.sys).resolvedModule;
    return resolved ? { found: true, path: resolved.resolvedFileName } : { found: false };
  } catch { return { found: false }; }
};
