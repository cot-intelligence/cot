import { Composer } from './Composer';
import { Library } from './Library';
import { RunView } from './RunView';

/** #/analysis: the composer with saved runs under it. #/analysis/<id>: one run. */
export function AnalysisView({ runId }: { runId?: string }) {
  if (runId) return <RunView key={runId} runId={runId} />;
  return (
    <div className="scroll" id="vf-scroll">
      <div className="page an-page">
        <div className="ph">
          <div style={{ minWidth: 0 }}>
            <span className="label">Analysis</span>
            <h1>Ask an expert to read your sessions</h1>
            <p>An agent investigates a session (or all of them) through one persona's eyes, cites the steps it read, and hands you deliverables to use.</p>
          </div>
        </div>
        <Composer />
        <div className="an-sec-h" style={{ marginTop: 32 }}><span className="label">Saved analyses</span></div>
        <Library />
      </div>
    </div>
  );
}

/** The session page's Analysis tab: analyse this session, and its earlier runs. */
export function SessionAnalysisTab({ sessionId }: { sessionId: string }) {
  return (
    <div className="an-tab">
      <Composer fixedSessionId={sessionId} />
      <div className="an-sec-h" style={{ marginTop: 24 }}><span className="label">Analyses of this session</span></div>
      <Library sessionId={sessionId} compact />
    </div>
  );
}
