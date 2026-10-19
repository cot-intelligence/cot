import type { QuestionPart } from '../../../lib/api';
import { Icon } from '../../forest/icons';

/**
 * A question the agent asked: each part's options with their descriptions, the
 * picked ones filled and checked, plus any typed answer or note. Options that
 * weren't picked stay quiet so the answer reads at a glance.
 */
export function QuestionCards({ questions, waiting }: { questions: QuestionPart[]; waiting: boolean }) {
  return (
    <div className="qa">
      {questions.map((q, qi) => {
        const choices = q.choices ?? (q.options ?? []).map((label) => ({ label, description: null }));
        const picked = new Set(q.picked ?? (q.answer && choices.some((c) => c.label === q.answer) ? [q.answer] : []));
        const custom = q.custom ?? (q.answer && picked.size === 0 ? q.answer : null);
        const answered = picked.size > 0 || !!custom;
        const state = answered ? null : q.skipped ? 'Skipped' : waiting ? 'Waiting for an answer' : 'No answer recorded';
        return (
          <div key={qi} className="qa-q">
            <div className="qa-h">
              {q.header && <span className="qa-tag">{q.header}</span>}
              {q.multi && <span className="qa-hint">pick any</span>}
              {state && <span className="qa-hint" data-state={q.skipped ? 'skipped' : 'open'}>{state}</span>}
            </div>
            <p className="qa-t">{q.question}</p>
            {choices.length > 0 && (
              <ul className="qa-opts" aria-label="Options">
                {choices.map((c) => {
                  const on = picked.has(c.label);
                  return (
                    <li key={c.label} className="qa-o" data-on={on || undefined} data-dim={(answered && !on) || undefined}>
                      <span className="qa-mark" data-multi={q.multi || undefined} aria-hidden="true">{on && <Icon name="check" size={11} stroke={2.4} />}</span>
                      <span style={{ minWidth: 0 }}>
                        <span className="qa-l">{c.label}{on && <span className="sr-only"> (picked)</span>}</span>
                        {c.description && <span className="qa-d">{c.description}</span>}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            {custom && (
              <div className="qa-o qa-custom" data-on>
                <span className="qa-mark" aria-hidden="true"><Icon name="edit" size={11} stroke={2} /></span>
                <span style={{ minWidth: 0 }}>
                  <span className="qa-d" style={{ marginTop: 0 }}>{choices.length ? 'Own answer' : 'Answer'}</span>
                  <span className="qa-l">{custom}</span>
                </span>
              </div>
            )}
            {q.note && <p className="qa-note"><Icon name="prompt" size={12} /> {q.note}</p>}
          </div>
        );
      })}
    </div>
  );
}
