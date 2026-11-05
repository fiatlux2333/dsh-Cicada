import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import semver from 'semver';

const root = new URL('../', import.meta.url);
const readJson = (url) => JSON.parse(readFileSync(url, 'utf8'));
const isDsh = (name) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-');
const CORE = '@deepseek-ai/cordis';
const GENERATOR = '@deepseek-ai/dsh-typert-generator';

export function auditManifests(workspace, plugin, hostVersion) {
  const sdkVersion = workspace.devDependencies['@deepseek-ai/dsh-typert-generator'];
  if (!semver.valid(sdkVersion)) throw new Error('The official generator must use an exact SDK version');
  // RC releases are certified individually, not by an open-ended prerelease range.
  if (plugin.engines.dsh !== `=${sdkVersion}`)
    throw new Error('engines.dsh must match the SDK target; certify a new release before changing it');
  for (const [section, dependencies] of Object.entries({
    peerDependencies: plugin.peerDependencies,
    devDependencies: plugin.devDependencies,
  })) {
    for (const [name, version] of Object.entries(dependencies)) {
      if (isDsh(name) && version !== sdkVersion)
        throw new Error(`${section}.${name} is ${version}, expected ${sdkVersion}`);
    }
  }
  for (const name of Object.keys(plugin.peerDependencies)) {
    if (isDsh(name) || name === '@deepseek-ai/cordis')
      if (plugin.devDependencies[name] !== plugin.peerDependencies[name])
        throw new Error(`${name} must have matching peer and development declarations`);
  }
  if (
    hostVersion !== undefined &&
    (!semver.valid(hostVersion) ||
      !semver.satisfies(hostVersion, plugin.engines.dsh, { includePrerelease: true }))
  )
    throw new Error(
      `Harness ${hostVersion} is not supported by ${plugin.name}@${plugin.version} (${plugin.engines.dsh}). ` +
        'Do not grant a version exemption. Build and test an updated plugin in an isolated profile first.',
    );
  return { plugin: `${plugin.name}@${plugin.version}`, sdkVersion, hostRange: plugin.engines.dsh };
}

export function auditInstalledManifests(workspace, plugin, loadInstalled) {
  const sdkVersion = workspace.devDependencies[GENERATOR];
  const core = loadInstalled('plugin', CORE);
  const validateVersion = (manifest, name, range) => {
    if (
      manifest.name !== name ||
      !semver.valid(manifest.version) ||
      !semver.satisfies(manifest.version, range, { includePrerelease: true })
    )
      throw new Error(
        `Installed ${name}@${manifest.version} does not satisfy ${range}; run pnpm install --frozen-lockfile`,
      );
  };
  validateVersion(core, CORE, plugin.devDependencies[CORE]);
  const validateOfficialCore = (manifest) => {
    const range = manifest.peerDependencies?.[CORE];
    if (range === undefined) return;
    if (typeof range !== 'string' || !semver.validRange(range))
      throw new Error(`Invalid official peer metadata: ${manifest.name}.${CORE}`);
    const validatePeer = (peer) => {
      if (
        peer.name !== CORE ||
        !semver.valid(peer.version) ||
        !semver.satisfies(peer.version, range, { includePrerelease: true })
      )
        throw new Error(
          `Official ${manifest.name}@${manifest.version} requires ${CORE} ${range}, ` +
            `but ${CORE}@${peer.version} is installed; reinstall compatible dependencies`,
        );
    };
    validatePeer(core);
    const resolvedCore = loadInstalled(manifest.name, CORE);
    validatePeer(resolvedCore);
    if (resolvedCore.version !== core.version)
      throw new Error(
        `${manifest.name} resolves ${CORE}@${resolvedCore.version}, expected shared Core version ${core.version}`,
      );
  };
  const generator = loadInstalled('workspace', GENERATOR);
  validateVersion(generator, GENERATOR, sdkVersion);
  validateOfficialCore(generator);
  for (const [name, version] of Object.entries(plugin.devDependencies)) {
    if (!isDsh(name)) continue;
    const sdk = loadInstalled('plugin', name);
    validateVersion(sdk, name, version);
    validateOfficialCore(sdk);
  }
}

export function checkCompatibility(args = process.argv.slice(2)) {
  let hostVersion;
  if (args.length === 1 && args[0] === '--sdk-only') hostVersion = undefined;
  else if (args.length === 2 && args[0] === '--host-version') hostVersion = args[1];
  else if (args.length === 0) {
    hostVersion = execFileSync(
      process.platform === 'win32' ? 'cmd.exe' : 'dsh',
      process.platform === 'win32' ? ['/d', '/s', '/c', 'dsh --version'] : ['--version'],
      { encoding: 'utf8', timeout: 15000, windowsHide: true, cwd: fileURLToPath(root) },
    ).trim();
  } else throw new Error('Usage: pnpm compat:check [--sdk-only | --host-version <version>]');
  const workspace = readJson(new URL('package.json', root));
  const pluginUrl = new URL('packages/dsh-cicada/package.json', root);
  const plugin = readJson(pluginUrl);
  const report = auditManifests(workspace, plugin, hostVersion);
  const resolvers = {
    workspace: createRequire(new URL('package.json', root)),
    plugin: createRequire(pluginUrl),
  };
  auditInstalledManifests(workspace, plugin, (scope, name) => {
    const path = resolvers[scope].resolve(`${name}/package.json`);
    const manifest = readJson(path);
    resolvers[name] ??= createRequire(path);
    return manifest;
  });
  return {
    ...report,
    hostVersion: hostVersion ?? null,
    source: args[0] === '--host-version' ? 'supplied version, not the installed Host' : 'local',
    note: 'Version preflight only; does not certify API or live Host compatibility and never installs a plugin.',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(checkCompatibility(), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Compatibility check failed');
    process.exitCode = 1;
  }
}
