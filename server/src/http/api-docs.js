import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import { parse as parseYaml } from 'yaml';

// Swagger UI for the OpenAPI documents in server/openapi/. Each app gets its own copy of the
// Swagger UI files (serveFiles), so the user API and the ingest API do not share state.

export const SPEC_FILES = {
  app: fileURLToPath(new URL('../../openapi/app.openapi.yaml', import.meta.url)),
  ingest: fileURLToPath(new URL('../../openapi/ingest.openapi.yaml', import.meta.url)),
};

export function loadSpec(name) {
  return parseYaml(readFileSync(SPEC_FILES[name], 'utf8'));
}

/** Swagger UI's own styles are inline: allow them on the docs pages only. */
function docsCsp(req, res, next) {
  res.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
  );
  next();
}

/** Router serving /openapi.yaml, /openapi.json and the Swagger UI page for one spec. */
export function apiDocs(name, title) {
  const spec = loadSpec(name);
  const r = Router();
  r.get('/openapi.yaml', (req, res) => res.type('application/yaml').sendFile(SPEC_FILES[name]));
  r.get('/openapi.json', (req, res) => res.json(spec));
  r.use('/', docsCsp, swaggerUi.serveFiles(spec), swaggerUi.setup(spec, { customSiteTitle: title }));
  return r;
}
