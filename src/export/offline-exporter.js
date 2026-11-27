/**
 * Frozen Aperture — Standalone Offline Player Exporter
 * Embeds the canonical project document and validated assets into a single
 * self-contained HTML file with zero external network dependencies.
 */

import { validateProject } from '../core/schema.js';

export function buildStandaloneHtmlExport(project, currentDocumentHtml) {
  const check = validateProject(project);
  if (!check.valid) {
    throw new Error(`Cannot export invalid project: ${check.errors.join('; ')}`);
  }

  // Safely serialize project JSON escaping closing script tags
  const safeJson = JSON.stringify(project).replace(/<\/script/gi, '<\\/script');
  const injection = `<script>window.__FROZEN_APERTURE_EMBEDDED_PROJECT__ = ${safeJson};</script>`;

  if (typeof currentDocumentHtml === 'string' && currentDocumentHtml.includes('</head>')) {
    // Strip any prior embedded project block before injecting the new one
    const cleaned = currentDocumentHtml.replace(
      /<script>window\.__FROZEN_APERTURE_EMBEDDED_PROJECT__\s*=[\s\S]*?<\/script>/g,
      ''
    );
    return cleaned.replace('</head>', `${injection}\n</head>`);
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${project.project.name} — Frozen Aperture Offline Player</title>
  ${injection}
</head>
<body>
  <p>Frozen Aperture standalone export bundle.</p>
</body>
</html>`;
}
