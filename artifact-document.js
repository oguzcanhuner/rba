const ARTIFACT_BASE_CSS = `
:root {
  color-scheme: light;
  --artifact-bg: #ffffff;
  --artifact-surface: #f7f7f8;
  --artifact-fg: #242428;
  --artifact-muted: #686872;
  --artifact-accent: #2563eb;
  --artifact-border: #dedee3;
  --artifact-radius: 8px;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: var(--artifact-fg);
  background: var(--artifact-bg);
}

* { box-sizing: border-box; }
html { min-height: 100%; background: var(--artifact-bg); }
body {
  width: min(100%, 960px);
  min-height: 100%;
  margin: 0 auto;
  padding: clamp(20px, 4vw, 48px);
  color: var(--artifact-fg);
  background: var(--artifact-bg);
  font-size: 15px;
  line-height: 1.6;
  text-rendering: optimizeLegibility;
}
h1, h2, h3, h4 { margin: 1.5em 0 0.5em; line-height: 1.2; letter-spacing: -0.02em; }
h1:first-child, h2:first-child, h3:first-child { margin-top: 0; }
h1 { font-size: clamp(1.75rem, 4vw, 2.5rem); }
h2 { padding-bottom: 0.3em; border-bottom: 1px solid var(--artifact-border); font-size: 1.35rem; }
h3 { font-size: 1.1rem; }
p, ul, ol, pre, table, blockquote { margin: 0 0 1em; }
a { color: var(--artifact-accent); text-underline-offset: 0.15em; }
img, svg, video, canvas { max-width: 100%; height: auto; }
code, pre { font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; }
:not(pre) > code {
  padding: 0.15em 0.35em;
  border-radius: 4px;
  background: var(--artifact-surface);
  font-size: 0.9em;
}
pre {
  max-width: 100%;
  overflow: auto;
  padding: 1rem;
  border: 1px solid var(--artifact-border);
  border-radius: var(--artifact-radius);
  background: var(--artifact-surface);
  font-size: 0.875rem;
  line-height: 1.5;
}
table { display: block; width: 100%; overflow-x: auto; border-collapse: collapse; }
th, td { padding: 0.55rem 0.7rem; border: 1px solid var(--artifact-border); text-align: left; vertical-align: top; }
th { background: var(--artifact-surface); font-weight: 650; }
blockquote {
  margin-left: 0;
  padding: 0.75rem 1rem;
  border-left: 3px solid var(--artifact-accent);
  background: var(--artifact-surface);
  color: var(--artifact-muted);
}
button, input, select, textarea {
  border: 1px solid var(--artifact-border);
  border-radius: 6px;
  padding: 0.5rem 0.7rem;
  color: inherit;
  background: var(--artifact-bg);
  font: inherit;
}
button { cursor: pointer; }
button:hover { border-color: var(--artifact-accent); }
hr { margin: 2rem 0; border: 0; border-top: 1px solid var(--artifact-border); }

@media (max-width: 560px) {
  body { padding: 18px; }
  th, td { min-width: 140px; }
}
`;

function renderArtifactDocument(html) {
  const baseStyle = `<style data-rba-artifact-base>\n${ARTIFACT_BASE_CSS}\n</style>`;
  const headMatch = html.match(/<head(?:\s[^>]*)?>/i);

  if (headMatch?.index !== undefined) {
    const insertionPoint = headMatch.index + headMatch[0].length;
    return `${html.slice(0, insertionPoint)}\n${baseStyle}${html.slice(insertionPoint)}`;
  }

  const bodyMatch = html.match(/<body(?:\s[^>]*)?>/i);
  if (bodyMatch?.index !== undefined) {
    return html.replace(
      bodyMatch[0],
      `<head>${baseStyle}</head>\n${bodyMatch[0]}`,
    );
  }

  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n${baseStyle}\n</head>\n<body>\n${html}\n</body>\n</html>`;
}

module.exports = { ARTIFACT_BASE_CSS, renderArtifactDocument };
