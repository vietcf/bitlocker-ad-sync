import { readFileSync } from 'node:fs';

/** Version of this server: the single source is package.json (bumped at each release, see CHANGELOG.md). */
export const APP_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
