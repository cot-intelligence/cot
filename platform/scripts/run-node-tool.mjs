#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SUPPORTED_NODE_CANDIDATES = [
  process.env.COT_NODE,
  '/opt/homebrew/bin/node',
  '/usr/local/bin/node',
  process.execPath,
].filter(Boolean);

const scriptPath = fileURLToPath(import.meta.url);
const [tool, ...toolArgs] = process.argv.slice(2);

if (!tool) {
  console.error('Usage: node scripts/run-node-tool.mjs <tool> [...args]');
  process.exit(1);
}

if (!isSupportedNode(process.versions.node)) {
  const candidate = findSupportedNode();
  if (!candidate) {
    console.error(
      `Node ${process.versions.node} is too old for the frontend toolchain. ` +
        'Install Node >=20.19 or >=22.12, or set COT_NODE=/path/to/node.',
    );
    process.exit(1);
  }
  const result = spawnSync(candidate, [scriptPath, tool, ...toolArgs], {
    stdio: 'inherit',
    env: {
      ...process.env,
      COT_NODE_REEXEC: '1',
    },
  });
  process.exit(result.status ?? 1);
}

const binPath = resolvePackageBin(tool);
const env = {
  ...process.env,
  WRANGLER_LOG_PATH:
    process.env.WRANGLER_LOG_PATH || path.join(process.cwd(), '.wrangler', 'logs'),
};
const result = spawnSync(process.execPath, [binPath, ...toolArgs], {
  stdio: 'inherit',
  env,
});
process.exit(result.status ?? 1);

function isSupportedNode(version) {
  const [major, minor] = version.split('.').map((part) => Number(part));
  if (major === 20) return minor >= 19;
  if (major === 22) return minor >= 12;
  return major > 22;
}

function findSupportedNode() {
  for (const candidate of SUPPORTED_NODE_CANDIDATES) {
    if (!candidate || !fs.existsSync(candidate)) continue;
    const result = spawnSync(candidate, ['-p', 'process.versions.node'], {
      encoding: 'utf8',
    });
    if (result.status === 0 && isSupportedNode(result.stdout.trim())) {
      return candidate;
    }
  }
  return null;
}

function resolvePackageBin(name) {
  const bin = path.join(process.cwd(), 'node_modules', '.bin', name);
  if (!fs.existsSync(bin)) {
    console.error(`Could not find local tool: ${bin}`);
    process.exit(1);
  }
  return fs.realpathSync(bin);
}
