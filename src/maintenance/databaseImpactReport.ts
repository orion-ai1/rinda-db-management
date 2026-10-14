import type { DatabaseMaintenanceSnapshot, DatabaseObjectImpact } from './DatabaseMaintenanceService.js';

export function buildDatabaseImpactReport(snapshot: DatabaseMaintenanceSnapshot): string {
  const lines = [
    `# DROP DATABASE 影响清单：${escapeMarkdown(snapshot.database)}`,
    '',
    `- 分析时间：${snapshot.analyzedAt}`,
    `- 字符集/排序规则：${escapeMarkdown(snapshot.characterSet)} / ${escapeMarkdown(snapshot.collation)}`,
    `- 对象：表 ${snapshot.summary.tables}、视图 ${snapshot.summary.views}、存储过程 ${snapshot.procedures}、函数 ${snapshot.functions}、事件 ${snapshot.summary.events}、触发器 ${snapshot.summary.triggers}`,
    `- 估算行数：${snapshot.estimatedRows.toLocaleString()}`,
    `- 数据大小：${formatBytes(snapshot.dataBytes)}；索引大小：${formatBytes(snapshot.indexBytes)}；合计：${formatBytes(snapshot.dataBytes + snapshot.indexBytes)}`,
    '',
    '## 全部对象',
    '',
    '| 类型 | 名称 | 引擎/说明 | 估算行数 | 数据大小 | 索引大小 |',
    '| --- | --- | --- | ---: | ---: | ---: |'
  ];
  if (snapshot.objects.length === 0) {
    lines.push('| — | （空库） | — | — | — | — |');
  } else {
    for (const object of snapshot.objects) lines.push(formatObjectRow(object));
  }
  lines.push('', '## 外部依赖', '');
  if (snapshot.externalOutboundForeignKeys.length === 0) {
    lines.push('- 无指向其他数据库的外键。');
  } else {
    for (const dependency of snapshot.externalOutboundForeignKeys) {
      lines.push(`- 向外外键：${escapeMarkdown(dependency.schema)}.${escapeMarkdown(dependency.object)}（${escapeMarkdown(dependency.name)}）`);
    }
  }
  lines.push(
    '- 外部对象对本库的引用已完整核对为 0；否则流程会在生成备份前阻断。',
    '',
    '> 此报告记录确认时的分析快照。执行前扩展会再次核对完整对象清单、结构、依赖与备份摘要；任何变化都会阻止 DROP DATABASE。',
    ''
  );
  return lines.join('\n');
}

export function formatDatabaseBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

function formatObjectRow(object: DatabaseObjectImpact): string {
  return [
    object.type,
    escapeMarkdown(object.name),
    escapeMarkdown(object.engine ?? object.detail ?? '—'),
    object.estimatedRows?.toLocaleString() ?? '—',
    object.dataBytes === undefined ? '—' : formatDatabaseBytes(object.dataBytes),
    object.indexBytes === undefined ? '—' : formatDatabaseBytes(object.indexBytes)
  ].map((value) => ` ${value} `).join('|').replace(/^/, '|').replace(/$/, '|');
}

function escapeMarkdown(value: string): string {
  return value.replace(/[|\\]/g, (character) => `\\${character}`).replace(/[\r\n]+/g, ' ');
}

function formatBytes(bytes: number): string {
  return formatDatabaseBytes(bytes);
}
