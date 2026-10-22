import { useState } from 'react';
import type { AgentId } from '../../../lib/agents';
import type { PassiveAgentDetail } from '../../../lib/api';
import { AgentMark, agentLabel } from '../../forest/AgentMark';
import { fmt } from '../../forest/format';
import { Icon } from '../../forest/icons';
import { Switch } from '../../forest/ui';
import { scanLine } from '../../passive/PassiveParts';
import { Actions, Shell } from './Shell';
import { LIVE_AGENTS, type Setup } from './setup';

/** One agent: its mark and name, what the scan found, and a switch. */
function PickRow({ d, id, on, onChange, switchLabel }: { d?: PassiveAgentDetail; id: string; on: boolean; onChange: (v: boolean) => void; switchLabel: string }) {
  const found = !!d && d.readable && d.transcripts > 0;
  return (
    <li className="onb-st" data-off={!on || undefined}>
      <div className="onb-st-h">
        <span className="onb-st-mark"><AgentMark id={id} size={16} /></span>
        <div className="onb-st-t">
          <b>{agentLabel(id)}</b>
          <span className="dim">{found ? scanLine(d) : 'No sessions on this machine yet'}</span>
        </div>
        <Switch on={on} onChange={onChange} label={`${switchLabel} ${agentLabel(id)}`} />
      </div>
    </li>
  );
}

/** Step one: what's on this machine, before anything is installed or imported. */
export function Found({ setup, onContinue }: { setup: Setup; onContinue: (live: AgentId[]) => void }) {
  const { p, failed, live, setLive, skipped, setSkipped } = setup;
  const [more, setMore] = useState(false);

  if (failed) {
    return (
      <Shell
        eyebrow="Set up cot"
        title={failed === 'unsupported' ? 'This collector needs an update' : "Couldn't reach the collector"}
        lead={failed === 'unsupported' ? 'The cot collector running here predates this setup. Update the cot app and open it again.' : 'Setup needs the cot collector running on this machine. It will retry on its own.'}>
        <span />
      </Shell>
    );
  }
  if (!p || !live) {
    return (
      <Shell eyebrow="Set up cot" title="Looking at this machine…" lead="Checking the folders your coding agents save their sessions to.">
        <div className="onb-skel" aria-hidden="true"><span /><span /><span /></div>
      </Shell>
    );
  }

  const byId = new Map(p.agents_detail.map((d) => [d.agent, d]));
  const others = p.agents_detail.filter((d) => !(LIVE_AGENTS as string[]).includes(d.agent));
  const foundOthers = others.filter((d) => d.readable && d.transcripts > 0);
  const notFound = others.filter((d) => !(d.readable && d.transcripts > 0));
  const sessions = p.agents_detail.reduce((n, d) => n + (d.readable ? d.transcripts : 0), 0);
  const agentsFound = p.agents_detail.filter((d) => d.readable && d.transcripts > 0).length;
  const running = p.agents_detail.reduce((n, d) => n + d.active, 0);
  const nothingReadable = !p.agents_detail.some((d) => d.readable);
  const toggleLive = (id: AgentId, on: boolean) => setLive((cur) => (on ? [...(cur ?? []), id] : (cur ?? []).filter((x) => x !== id)));
  const toggleImport = (a: string, on: boolean) => setSkipped((cur) => (on ? cur.filter((x) => x !== a) : [...cur, a]));

  return (
    <Shell
      eyebrow="Set up cot · step 1"
      title="Here’s what’s on this machine"
      lead={
        agentsFound
          ? `cot found ${fmt.n(sessions)} sessions from ${agentsFound} agent${agentsFound === 1 ? '' : 's'}. Nothing has been installed or imported yet.`
          : 'No agent sessions yet. Connect the agents you use and they will appear as you work.'
      }>
      <section className="onb-grp" aria-labelledby="onb-live">
        <div className="onb-grp-h">
          <span className="label" id="onb-live">Connect live</span>
          <span className="dim">Hooks show sessions as they happen. Their history is imported either way.</span>
        </div>
        <ul className="onb-status">
          {LIVE_AGENTS.map((id) => (
            <PickRow key={id} id={id} d={byId.get(id)} on={live.includes(id)} onChange={(v) => toggleLive(id, v)} switchLabel="Live hooks for" />
          ))}
        </ul>
      </section>

      {foundOthers.length > 0 && (
        <section className="onb-grp" aria-labelledby="onb-disk">
          <div className="onb-grp-h">
            <span className="label" id="onb-disk">Import from disk</span>
            <span className="dim">cot reads these agents’ saved sessions on a schedule. Nothing is installed in them.</span>
          </div>
          <ul className="onb-status">
            {foundOthers.map((d) => (
              <PickRow key={d.agent} id={d.agent} d={d} on={!skipped.includes(d.agent)} onChange={(v) => toggleImport(d.agent, v)} switchLabel="Import" />
            ))}
          </ul>
        </section>
      )}

      {notFound.length > 0 && (
        <div className="psv-absent" data-open={more || undefined}>
          <button type="button" className="psv-absent-t" aria-expanded={more} onClick={() => setMore((m) => !m)}>
            <Icon name="chevron" size={14} />
            <span>{notFound.length} more agents cot can read</span>
            <span className="psv-absent-h faint">Picked up automatically if you install one</span>
          </button>
          {more && (
            <ul className="psv-absent-l">
              {notFound.map((d) => (
                <li key={d.agent} className="psv-absent-r"><span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><AgentMark id={d.agent} size={14} />{agentLabel(d.agent)}</span></li>
              ))}
            </ul>
          )}
        </div>
      )}

      {nothingReadable && (
        <p className="onb-note"><Icon name="eye" size={14} />A collector running in Docker only sees <span className="mono">~/.cot</span>, so it can’t import from disk. Live hooks still work, or use the desktop app.</p>
      )}
      {running > 0 && (
        <p className="onb-note"><Icon name="clock" size={14} />{running} session{running === 1 ? ' is' : 's are'} still running. They’re imported once they’ve been quiet for 10 minutes.</p>
      )}
      <Actions next={{ label: live.length ? `Connect ${live.length} agent${live.length === 1 ? '' : 's'}` : 'Import history', onClick: () => onContinue(live) }} />
    </Shell>
  );
}
