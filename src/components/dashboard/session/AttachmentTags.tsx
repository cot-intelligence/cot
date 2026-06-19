import type { Attachment } from '../../../lib/api';
import { Icon } from '../../ui/icons';

function formatSize(bytes?: number): string {
  if (!bytes) return '';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function formatType(a: Attachment): string {
  if (a.media_type) {
    return a.media_type.includes('/')
      ? a.media_type.split('/')[1].toUpperCase()
      : a.media_type.toUpperCase();
  }
  return a.kind.toUpperCase();
}

function describe(a: Attachment): string {
  const parts = [a.name || formatType(a)];
  if (a.width && a.height) parts.push(`${a.width}×${a.height}`);
  const size = formatSize(a.size_bytes);
  if (size) parts.push(size);
  return parts.join(' · ');
}

/** Compact count badge — for dense rows. */
export function AttachmentBadge({ attachments }: { attachments: Attachment[] }) {
  if (!attachments?.length) return null;
  return (
    <span
      title={attachments.map(describe).join('\n')}
      className="inline-flex shrink-0 items-center gap-1 rounded border border-cobalt/30 px-1 py-0.5 font-mono text-[0.55rem] text-cobalt">
      <Icon name="paperclip" className="h-2.5 w-2.5" />
      {attachments.length}
    </span>
  );
}

/** Full metadata chips — for the detail panel. */
export function AttachmentTags({ attachments }: { attachments: Attachment[] }) {
  if (!attachments?.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {attachments.map((a, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-1.5 rounded border border-fg/15 bg-panel px-2 py-1 font-mono text-[0.6rem] text-fg/70">
          <Icon name={a.kind === 'image' ? 'image' : 'file'} className="h-3 w-3 text-cobalt" />
          {describe(a)}
        </span>
      ))}
    </div>
  );
}
