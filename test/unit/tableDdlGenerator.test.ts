import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateCreateTableSql,
  generateAlterTableSql,
  generatePreviewSql,
  validateDesignerState
} from '../../src/design/TableDdlGenerator.js';
import type { TableDesignerState } from '../../src/design/TableDesignerTypes.js';

test('TableDdlGenerator: validateDesignerState checks basic constraints', () => {
  const emptyState: TableDesignerState = {
    mode: 'create',
    connectionId: 'conn1',
    database: 'shop',
    tableName: '',
    columns: [],
    options: { engine: 'InnoDB', charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci', comment: '' }
  };

  const val1 = validateDesignerState(emptyState);
  assert.equal(val1.valid, false);
  assert.ok(val1.errors.some((e) => e.includes('表名不能为空')));
  assert.ok(val1.errors.some((e) => e.includes('至少需要包含一个字段')));

  const duplicateColsState: TableDesignerState = {
    ...emptyState,
    tableName: 'users',
    columns: [
      { id: '1', name: 'id', dataType: 'INT', notNull: true, isPrimaryKey: true },
      { id: '2', name: 'id', dataType: 'VARCHAR', length: '50', notNull: false, isPrimaryKey: false }
    ]
  };
  const val2 = validateDesignerState(duplicateColsState);
  assert.equal(val2.valid, false);
  assert.ok(val2.errors.some((e) => e.includes('存在重复的字段名')));

  const autoIncState: TableDesignerState = {
    ...emptyState,
    tableName: 'users',
    columns: [
      { id: '1', name: 'id', dataType: 'VARCHAR', length: '50', notNull: true, isPrimaryKey: false, autoIncrement: true }
    ]
  };
  const val3 = validateDesignerState(autoIncState);
  assert.equal(val3.valid, false);
  assert.ok(val3.errors.some((e) => e.includes('必须是整数类型')));
  assert.ok(val3.errors.some((e) => e.includes('必须设置为主键')));
});

test('TableDdlGenerator: generateCreateTableSql formats complete CREATE TABLE with primary key', () => {
  const state: TableDesignerState = {
    mode: 'create',
    connectionId: 'conn1',
    database: 'my_db',
    tableName: 'users',
    columns: [
      {
        id: '1',
        name: 'id',
        dataType: 'BIGINT',
        notNull: true,
        isPrimaryKey: true,
        autoIncrement: true,
        comment: '主键ID'
      },
      {
        id: '2',
        name: 'username',
        dataType: 'VARCHAR',
        length: '64',
        notNull: true,
        isPrimaryKey: false,
        defaultValue: 'EMPTY'
      },
      {
        id: '3',
        name: 'balance',
        dataType: 'DECIMAL',
        length: '10',
        scale: '2',
        notNull: true,
        isPrimaryKey: false,
        defaultValue: '0.00'
      },
      {
        id: '4',
        name: 'created_at',
        dataType: 'DATETIME',
        notNull: true,
        isPrimaryKey: false,
        defaultValue: 'CURRENT_TIMESTAMP'
      },
      {
        id: '5',
        name: 'bio',
        dataType: 'TEXT',
        notNull: false,
        isPrimaryKey: false,
        defaultValue: 'NULL'
      }
    ],
    options: {
      engine: 'InnoDB',
      charset: 'utf8mb4',
      collation: 'utf8mb4_unicode_ci',
      comment: '用户表'
    }
  };

  const sql = generateCreateTableSql(state);
  assert.ok(sql.startsWith('CREATE TABLE `my_db`.`users` ('));
  assert.ok(sql.includes('`id` BIGINT NOT NULL AUTO_INCREMENT COMMENT \'主键ID\''));
  assert.ok(sql.includes('`username` VARCHAR(64) NOT NULL DEFAULT \'\''));
  assert.ok(sql.includes('`balance` DECIMAL(10,2) NOT NULL DEFAULT \'0.00\''));
  assert.ok(sql.includes('`created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP'));
  assert.ok(sql.includes('`bio` TEXT NULL DEFAULT NULL'));
  assert.ok(sql.includes('PRIMARY KEY (`id`)'));
  assert.ok(sql.includes("ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户表'"));
});

test('TableDdlGenerator: generateAlterTableSql detects added, dropped, renamed, modified, moved columns and PK changes', () => {
  const origCols = [
    { id: '1', name: 'id', originalName: 'id', dataType: 'INT', notNull: true, isPrimaryKey: true },
    { id: '2', name: 'old_title', originalName: 'old_title', dataType: 'VARCHAR', length: '100', notNull: false, isPrimaryKey: false },
    { id: '3', name: 'obsolete', originalName: 'obsolete', dataType: 'INT', notNull: false, isPrimaryKey: false }
  ];

  const state: TableDesignerState = {
    mode: 'alter',
    connectionId: 'conn1',
    database: 'my_db',
    tableName: 'articles',
    originalTableName: 'articles',
    originalColumns: origCols,
    columns: [
      { id: '1', name: 'id', originalName: 'id', dataType: 'BIGINT', notNull: true, isPrimaryKey: true }, // modified type INT -> BIGINT
      { id: '2', name: 'new_title', originalName: 'old_title', dataType: 'VARCHAR', length: '200', notNull: true, isPrimaryKey: false }, // renamed old_title -> new_title & modified
      { id: '4', name: 'content', dataType: 'TEXT', notNull: false, isPrimaryKey: false } // added column after new_title
      // 'obsolete' dropped
    ],
    options: { engine: 'InnoDB', charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci', comment: '' },
    originalOptions: { engine: 'InnoDB', charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci', comment: '' }
  };

  const sql = generateAlterTableSql(state);
  assert.ok(sql.includes('DROP COLUMN `obsolete`'));
  assert.ok(sql.includes('MODIFY COLUMN `id` BIGINT NOT NULL FIRST'));
  assert.ok(sql.includes('CHANGE COLUMN `old_title` `new_title` VARCHAR(200) NOT NULL AFTER `id`'));
  assert.ok(sql.includes('ADD COLUMN `content` TEXT NULL AFTER `new_title`'));
});

test('TableDdlGenerator: generateAlterTableSql handles primary key alterations', () => {
  const origCols = [
    { id: '1', name: 'id', originalName: 'id', dataType: 'INT', notNull: true, isPrimaryKey: true },
    { id: '2', name: 'tenant_id', originalName: 'tenant_id', dataType: 'INT', notNull: true, isPrimaryKey: false }
  ];

  const state: TableDesignerState = {
    mode: 'alter',
    connectionId: 'conn1',
    database: 'my_db',
    tableName: 'tenants',
    originalTableName: 'tenants',
    originalColumns: origCols,
    columns: [
      { id: '1', name: 'id', originalName: 'id', dataType: 'INT', notNull: true, isPrimaryKey: true },
      { id: '2', name: 'tenant_id', originalName: 'tenant_id', dataType: 'INT', notNull: true, isPrimaryKey: true } // now composite PK
    ],
    options: { engine: 'InnoDB', charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci', comment: '' },
    originalOptions: { engine: 'InnoDB', charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci', comment: '' }
  };

  const sql = generateAlterTableSql(state);
  assert.ok(sql.includes('DROP PRIMARY KEY'));
  assert.ok(sql.includes('ADD PRIMARY KEY (`id`, `tenant_id`)'));
});

test('TableDdlGenerator: generatePreviewSql returns comment when no changes exist', () => {
  const origCols = [
    { id: '1', name: 'id', originalName: 'id', dataType: 'INT', notNull: true, isPrimaryKey: true }
  ];

  const state: TableDesignerState = {
    mode: 'alter',
    connectionId: 'conn1',
    database: 'my_db',
    tableName: 'tenants',
    originalTableName: 'tenants',
    originalColumns: origCols,
    columns: [
      { id: '1', name: 'id', originalName: 'id', dataType: 'INT', notNull: true, isPrimaryKey: true }
    ],
    options: { engine: 'InnoDB', charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci', comment: '' },
    originalOptions: { engine: 'InnoDB', charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci', comment: '' }
  };

  const sql = generatePreviewSql(state);
  assert.equal(sql, '-- 当前没有未保存的结构变更');
});

test('TableDdlGenerator: generateCreateTableSql formats indexes and auto increment table option', () => {
  const state: TableDesignerState = {
    mode: 'create',
    connectionId: 'conn1',
    database: 'shop',
    tableName: 'orders',
    columns: [
      { id: '1', name: 'id', dataType: 'BIGINT', notNull: true, isPrimaryKey: true, autoIncrement: true },
      { id: '2', name: 'order_no', dataType: 'VARCHAR', length: '64', notNull: true, isPrimaryKey: false },
      { id: '3', name: 'user_id', dataType: 'BIGINT', notNull: true, isPrimaryKey: false },
      { id: '4', name: 'description', dataType: 'TEXT', notNull: false, isPrimaryKey: false }
    ],
    indexes: [
      { id: 'idx_1', name: 'uk_order_no', columns: ['order_no'], type: 'UNIQUE', method: 'BTREE', comment: '唯一订单号' },
      { id: 'idx_2', name: 'idx_user_id', columns: ['user_id'], type: 'INDEX', method: 'BTREE' },
      { id: 'idx_3', name: 'ft_desc', columns: ['description'], type: 'FULLTEXT' }
    ],
    options: {
      engine: 'InnoDB',
      charset: 'utf8mb4',
      collation: 'utf8mb4_unicode_ci',
      autoIncrement: '1000',
      comment: '订单主表'
    }
  };

  const sql = generateCreateTableSql(state);
  assert.ok(sql.includes('UNIQUE KEY `uk_order_no` (`order_no`) USING BTREE COMMENT \'唯一订单号\''));
  assert.ok(sql.includes('INDEX `idx_user_id` (`user_id`) USING BTREE'));
  assert.ok(sql.includes('FULLTEXT KEY `ft_desc` (`description`)'));
  assert.ok(sql.includes("AUTO_INCREMENT=1000"));
  assert.ok(sql.includes("COMMENT='订单主表'"));
});

test('TableDdlGenerator: generateAlterTableSql detects added, dropped, modified indexes and altered table options', () => {
  const origIndexes = [
    { id: 'idx_1', name: 'uk_email', originalName: 'uk_email', columns: ['email'], type: 'UNIQUE' as const },
    { id: 'idx_2', name: 'idx_status', originalName: 'idx_status', columns: ['status'], type: 'INDEX' as const }
  ];

  const state: TableDesignerState = {
    mode: 'alter',
    connectionId: 'conn1',
    database: 'shop',
    tableName: 'members',
    originalTableName: 'members',
    columns: [
      { id: '1', name: 'id', originalName: 'id', dataType: 'BIGINT', notNull: true, isPrimaryKey: true },
      { id: '2', name: 'email', originalName: 'email', dataType: 'VARCHAR', length: '128', notNull: true, isPrimaryKey: false },
      { id: '3', name: 'nickname', originalName: 'nickname', dataType: 'VARCHAR', length: '64', notNull: false, isPrimaryKey: false }
    ],
    originalColumns: [
      { id: '1', name: 'id', originalName: 'id', dataType: 'BIGINT', notNull: true, isPrimaryKey: true },
      { id: '2', name: 'email', originalName: 'email', dataType: 'VARCHAR', length: '128', notNull: true, isPrimaryKey: false },
      { id: '3', name: 'nickname', originalName: 'nickname', dataType: 'VARCHAR', length: '64', notNull: false, isPrimaryKey: false }
    ],
    indexes: [
      { id: 'idx_1', name: 'uk_email_new', originalName: 'uk_email', columns: ['email'], type: 'UNIQUE' as const }, // renamed / modified
      { id: 'idx_3', name: 'idx_nick', columns: ['nickname'], type: 'INDEX' as const, method: 'BTREE' } // added
      // 'idx_status' dropped
    ],
    originalIndexes: origIndexes,
    options: {
      engine: 'InnoDB',
      charset: 'utf8mb4',
      collation: 'utf8mb4_0900_ai_ci',
      autoIncrement: '500',
      comment: '会员表更新'
    },
    originalOptions: {
      engine: 'InnoDB',
      charset: 'utf8mb4',
      collation: 'utf8mb4_general_ci',
      comment: '会员表'
    }
  };

  const sql = generateAlterTableSql(state);
  assert.ok(sql.includes('DROP INDEX `idx_status`'));
  assert.ok(sql.includes('DROP INDEX `uk_email`'));
  assert.ok(sql.includes('ADD UNIQUE KEY `uk_email_new` (`email`)'));
  assert.ok(sql.includes('ADD INDEX `idx_nick` (`nickname`) USING BTREE'));
  assert.ok(sql.includes('COLLATE = utf8mb4_0900_ai_ci'));
  assert.ok(sql.includes('AUTO_INCREMENT = 500'));
  assert.ok(sql.includes("COMMENT = '会员表更新'"));
});

