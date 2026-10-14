import type { TableOverview } from '../explorer/metadataRepository.js';

export interface OverviewItem {
  label: string;
  value: string;
}

export function buildTableOverviewItems(overview: TableOverview): OverviewItem[] {
  return [
    { label: '对象类型', value: overview.objectType === 'view' ? '视图' : '数据表' },
    { label: '估算行数', value: formatInteger(overview.estimatedRows) },
    { label: '存储引擎', value: overview.engine ?? '—' },
    { label: '数据大小', value: formatBytes(overview.dataBytes) },
    { label: '索引大小', value: formatBytes(overview.indexBytes) },
    { label: '排序规则', value: overview.collation ?? '—' },
    { label: '下一自增值', value: formatInteger(overview.autoIncrement) },
    { label: '更新时间', value: overview.updatedAt ?? overview.createdAt ?? '—' }
  ];
}

export function formatBytes(value?: string): string {
  if (value === undefined) return '—';
  try {
    const bytes = BigInt(value);
    if (bytes < 0n) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let divisor = 1n;
    let unitIndex = 0;
    while (unitIndex < units.length - 1 && bytes >= divisor * 1024n) {
      divisor *= 1024n;
      unitIndex += 1;
    }
    if (unitIndex === 0) return `${bytes.toLocaleString('en-US')} B`;
    const whole = bytes / divisor;
    const tenths = (bytes % divisor) * 10n / divisor;
    return `${whole.toLocaleString('en-US')}.${tenths} ${units[unitIndex]}`;
  } catch {
    return '—';
  }
}

function formatInteger(value?: string): string {
  if (value === undefined) return '—';
  try {
    return BigInt(value).toLocaleString('en-US');
  } catch {
    return value;
  }
}
