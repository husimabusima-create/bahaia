import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  FileText,
  Loader2,
} from 'lucide-react';
import type { JobStatus } from '../types';

const STATUS_META: Record<
  JobStatus,
  { label: string; colorClass: string; Icon: typeof FileText; spin?: boolean }
> = {
  draft: {
    label: 'Draft',
    colorClass: 'text-zinc-400',
    Icon: FileText,
  },
  script_ready: {
    label: 'Script Ready',
    colorClass: 'text-amber-400',
    Icon: FileText,
  },
  queued: {
    label: 'Queued',
    colorClass: 'text-sky-400',
    Icon: Clock,
  },
  processing: {
    label: 'Processing',
    colorClass: 'text-rose-400',
    Icon: Loader2,
    spin: true,
  },
  completed: {
    label: 'Completed MP4',
    colorClass: 'text-emerald-400',
    Icon: CheckCircle2,
  },
  failed: {
    label: 'Failed',
    colorClass: 'text-red-400',
    Icon: AlertTriangle,
  },
};

export function StatusLabel({ status }: { status: JobStatus }) {
  const meta = STATUS_META[status] ?? STATUS_META.draft;
  const Icon = meta.Icon;

  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap shrink-0 ${meta.colorClass}`}>
      <Icon className={`w-3.5 h-3.5 ${meta.spin ? 'animate-spin' : ''}`} aria-hidden="true" />
      <span>{meta.label}</span>
    </span>
  );
}
