import type { Components } from '../../lib/api';

interface ComponentsPanelProps {
  components: Components;
}

function Section({ title, items }: { title: string; items: { label: string; count: number }[] }) {
  if (!items.length) return null;
  return (
    <div className="space-y-2">
      <h3 className="font-mono text-[0.6rem] font-bold uppercase tracking-widest text-fg/45">
        {title}
      </h3>
      <ul className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <li
            key={item.label}
            className="border border-fg/15 bg-surface px-2 py-1 font-mono text-[0.6rem] text-fg/70">
            <span className="text-fg">{item.label}</span>
            <span className="ml-1.5 text-fg/35">{item.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ComponentsPanel({ components }: ComponentsPanelProps) {
  const hasAny =
    components.files_edited.length ||
    components.files_read.length ||
    components.skills_context.length ||
    components.mcp_plugins.length ||
    components.web_calls.length ||
    components.subagents.length ||
    components.shell_count > 0;

  if (!hasAny) {
    return (
      <p className="font-mono text-xs text-fg/40">No component interactions recorded yet.</p>
    );
  }

  return (
    <div className="grid gap-5 sm:grid-cols-2">
      <Section
        title="FILES_EDITED"
        items={components.files_edited.map((f) => ({ label: f.path!, count: f.count }))}
      />
      <Section
        title="FILES_READ"
        items={components.files_read.map((f) => ({ label: f.path!, count: f.count }))}
      />
      <Section
        title="SKILLS_CONTEXT"
        items={components.skills_context.map((f) => ({ label: f.path!, count: f.count }))}
      />
      <Section
        title="MCP_PLUGINS"
        items={components.mcp_plugins.map((f) => ({ label: f.target!, count: f.count }))}
      />
      <Section
        title="EXTERNAL_NETWORK"
        items={components.web_calls.map((f) => ({ label: f.target!, count: f.count }))}
      />
      <Section
        title="SUBAGENTS"
        items={components.subagents.map((f) => ({ label: f.target!, count: f.count }))}
      />
      {components.shell_count > 0 && (
        <div className="font-mono text-[0.65rem] text-fg/55">
          Shell commands: <span className="font-bold text-fg">{components.shell_count}</span>
        </div>
      )}
    </div>
  );
}
