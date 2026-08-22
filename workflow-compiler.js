const { createHash } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const esbuild = require('esbuild');

const SDK_SOURCE = `
export function workflow(definition) {
  if (typeof definition === 'function') return { id: definition.name || 'workflow', run: definition };
  return definition;
}
`;

async function compileWorkflow(sourcePath) {
  const source = await readFile(sourcePath, 'utf8');
  const result = await esbuild.build({
    stdin: {
      contents: source,
      loader: sourcePath.endsWith('.ts') ? 'ts' : 'js',
      resolveDir: path.dirname(sourcePath),
      sourcefile: sourcePath,
    },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    write: false,
    plugins: [
      {
        name: 'rba-workflow-sdk',
        setup(build) {
          build.onResolve({ filter: /^@rba\/workflow$/ }, () => ({
            path: '@rba/workflow',
            namespace: 'rba-sdk',
          }));
          build.onLoad({ filter: /.*/, namespace: 'rba-sdk' }, () => ({
            contents: SDK_SOURCE,
            loader: 'js',
          }));
        },
      },
    ],
  });
  const bundledSource = result.outputFiles[0].text;
  return {
    bundledSource,
    sourceHash: createHash('sha256').update(bundledSource).digest('hex'),
  };
}

module.exports = { compileWorkflow };
