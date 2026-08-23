const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  ARTIFACT_BASE_CSS,
  renderArtifactDocument,
} = require('../artifact-document');

test('injects base styles before artifact styles in a full document', () => {
  const artifact =
    '<!doctype html><html><head><style>body{color:red}</style></head><body>Hello</body></html>';
  const rendered = renderArtifactDocument(artifact);

  assert.ok(
    rendered.indexOf(ARTIFACT_BASE_CSS) < rendered.indexOf('body{color:red}'),
  );
  assert.match(rendered, /data-rba-artifact-base/);
  assert.match(rendered, /<body>Hello<\/body>/);
});

test('wraps HTML fragments in a complete styled document', () => {
  const rendered = renderArtifactDocument('<h1>System map</h1>');

  assert.match(rendered, /^<!doctype html>/);
  assert.match(rendered, /data-rba-artifact-base/);
  assert.match(rendered, /<body>\s*<h1>System map<\/h1>\s*<\/body>/);
});
