const { execFile } = require('node:child_process');
const { mkdtemp, readFile, realpath, rm, stat } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

async function findPackageDirectory(workspace, filename) {
  let directory = path.dirname(filename);
  while (directory.startsWith(workspace)) {
    try {
      const packageJson = JSON.parse(
        await readFile(path.join(directory, 'package.json'), 'utf8'),
      );
      if (
        packageJson.devDependencies?.vitest ||
        packageJson.dependencies?.vitest ||
        Object.values(packageJson.scripts ?? {}).some((script) =>
          /(^|\s)vitest(\s|$)/.test(script),
        )
      ) {
        return directory;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }
  throw new Error('No Vitest package was found for this test file.');
}

async function findVitestExecutable(workspace, packageDirectory) {
  let directory = packageDirectory;
  while (directory.startsWith(workspace)) {
    const candidate = path.join(directory, 'node_modules', '.bin', 'vitest');
    try {
      if ((await stat(candidate)).isFile()) {
        return candidate;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }
  throw new Error('Vitest is not installed in this workspace.');
}

function traceFromReport(report, { testPath, testName, createdAt }) {
  const assertions = (report.testResults ?? []).flatMap((suite) =>
    (suite.assertionResults ?? []).map((assertion) => ({
      name: assertion.fullName?.trim() || assertion.title,
      status: assertion.status,
      durationMs: assertion.duration ?? null,
      location: assertion.location ?? null,
      failures: (assertion.failureMessages ?? []).map((message) =>
        String(message).slice(0, 20_000),
      ),
    })),
  );
  return {
    testPath,
    testName: testName ?? null,
    createdAt,
    success: report.success === true,
    durationMs: Math.max(0, Date.now() - report.startTime),
    assertions,
  };
}

async function runVitestTrace(
  { workingDirectory, testPath, testName },
  { runProcess = execFileAsync } = {},
) {
  const workspace = await realpath(workingDirectory);
  const filename = await realpath(path.resolve(workspace, testPath));
  const relative = path.relative(workspace, filename);
  if (
    !relative ||
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    !(await stat(filename)).isFile()
  ) {
    throw new Error('The test file must be inside the workspace.');
  }

  const packageDirectory = await findPackageDirectory(workspace, filename);
  const executable = await findVitestExecutable(workspace, packageDirectory);
  const outputDirectory = await mkdtemp(
    path.join(tmpdir(), 'rba-vitest-trace-'),
  );
  const outputFile = path.join(outputDirectory, 'report.json');
  const args = [
    'run',
    path.relative(packageDirectory, filename),
    '--reporter=json',
    `--outputFile=${outputFile}`,
  ];
  if (testName) {
    args.push(
      '--testNamePattern',
      testName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    );
  }

  const createdAt = new Date().toISOString();
  try {
    let runFailed = false;
    try {
      await runProcess(executable, args, {
        cwd: packageDirectory,
        maxBuffer: 2_000_000,
        timeout: 120_000,
      });
    } catch {
      // Vitest exits non-zero for failing tests but still writes its report.
      runFailed = true;
    }
    let report;
    try {
      report = JSON.parse(await readFile(outputFile, 'utf8'));
    } catch (error) {
      if (runFailed) {
        throw new Error('Vitest did not produce a test trace.');
      }
      throw error;
    }
    return traceFromReport(report, { testPath, testName, createdAt });
  } finally {
    await rm(outputDirectory, { force: true, recursive: true });
  }
}

async function supportsVitestTrace({ workingDirectory, testPath }) {
  const workspace = await realpath(workingDirectory);
  const filename = await realpath(path.resolve(workspace, testPath));
  try {
    await findPackageDirectory(workspace, filename);
    return true;
  } catch (error) {
    if (error?.message === 'No Vitest package was found for this test file.') {
      return false;
    }
    throw error;
  }
}

module.exports = { runVitestTrace, supportsVitestTrace, traceFromReport };
