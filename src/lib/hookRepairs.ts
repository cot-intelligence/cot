import type { HookRepair, HookStatus } from './api';

const REPAIR_REASON: Record<string, string> = {
  hooks_missing: 'its hooks were removed',
  config_missing: 'its config file was deleted',
};

/** One hook-guard pass on one agent, as a sentence ("Re-wired 2m ago: …"). */
export function repairLine(r: HookRepair, ago: string): string {
  const why = REPAIR_REASON[r.reason] ?? 'the bridge couldn\'t start';
  if (r.status === 'repaired') return `Re-wired ${ago}: ${why}.`;
  if (r.status === 'paused') return `Stopped re-wiring ${ago}: something keeps removing the hooks.`;
  return `Couldn't re-wire ${ago}: ${r.error ?? why}.`;
}

/** The newest guard pass per agent (the collector keeps them newest first). */
export function latestRepairs(status: HookStatus | null | undefined): Map<string, HookRepair> {
  const out = new Map<string, HookRepair>();
  for (const r of status?.repairs ?? []) if (!out.has(r.agent)) out.set(r.agent, r);
  return out;
}

export const PAUSED_NOTE = 'cot stopped re-adding these hooks: something keeps removing them. Connect again to resume.';
