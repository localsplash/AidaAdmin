import { existsSync, readFileSync } from 'node:fs';
const metadataPath = new URL('./build-info.json', import.meta.url);
// Source development is explicitly unbuilt; production metadata is stamped by the build.
export const buildInfo = Object.freeze(
  existsSync(metadataPath)
    ? JSON.parse(readFileSync(metadataPath, 'utf8'))
    : {
        version: 'unbuilt',
        revision: null,
        sourceUpdatedAt: null,
        timeZone: 'America/Los_Angeles',
        dirty: null,
      },
);
