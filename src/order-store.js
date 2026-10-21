export class OrderStore {
  constructor(accountStore) {
    this.db = accountStore.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, reference_id TEXT,
        create_key TEXT NOT NULL, create_hash TEXT NOT NULL,
        timely_order_id TEXT UNIQUE, data TEXT NOT NULL CHECK(json_valid(data)),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(owner_id, reference_id), UNIQUE(owner_id, create_key)
      );
      CREATE INDEX IF NOT EXISTS orders_owner ON orders(owner_id, created_at);
      CREATE TABLE IF NOT EXISTS payment_screenshots (
        id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        content_type TEXT NOT NULL, sha256 TEXT NOT NULL, data BLOB NOT NULL CHECK(length(data) BETWEEN 1 AND 5242880), created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS management_events (
        event_id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id),
        type TEXT NOT NULL, payload_hash TEXT NOT NULL, received_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fulfillment_jobs (
        id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
        status TEXT NOT NULL CHECK(status IN ('pending', 'sending', 'retry', 'attention', 'created')),
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
        lease_until INTEGER NOT NULL DEFAULT 0, last_error TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
    `);
    this.migrateOptionalReference();
    this.migratePaymentScreenshots();
    this.db.exec('CREATE INDEX IF NOT EXISTS payment_screenshots_order ON payment_screenshots(order_id)');
  }
  migrateOptionalReference() {
    if (!this.db.pragma('table_info(orders)').find(column => column.name === 'reference_id')?.notnull) return;
    const foreignKeys = this.db.pragma('foreign_keys', { simple: true });
    this.db.pragma('foreign_keys = OFF');
    try {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE orders_optional_reference (
            id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, reference_id TEXT,
            create_key TEXT NOT NULL, create_hash TEXT NOT NULL,
            timely_order_id TEXT UNIQUE, data TEXT NOT NULL CHECK(json_valid(data)),
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
            UNIQUE(owner_id, reference_id), UNIQUE(owner_id, create_key)
          );
          INSERT INTO orders_optional_reference SELECT * FROM orders;
          DROP TABLE orders;
          ALTER TABLE orders_optional_reference RENAME TO orders;
          CREATE INDEX orders_owner ON orders(owner_id, created_at);
        `);
        if (this.db.pragma('foreign_key_check').length) throw new Error('订单数据库迁移后关联校验失败');
      });
    } finally {
      this.db.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
    }
  }
  migratePaymentScreenshots() {
    const indexes = this.db.prepare('SELECT name FROM pragma_index_list(?) WHERE "unique"=1').all('payment_screenshots');
    const uniqueByOrder = indexes.some(index => {
      const columns = this.db.prepare('SELECT name FROM pragma_index_info(?)').all(index.name);
      return columns.length === 1 && columns[0].name === 'order_id';
    });
    if (!uniqueByOrder) return;
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE payment_screenshots_multiple (
          id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
          content_type TEXT NOT NULL, sha256 TEXT NOT NULL, data BLOB NOT NULL CHECK(length(data) BETWEEN 1 AND 5242880), created_at INTEGER NOT NULL
        );
        INSERT INTO payment_screenshots_multiple SELECT * FROM payment_screenshots;
        DROP TABLE payment_screenshots;
        ALTER TABLE payment_screenshots_multiple RENAME TO payment_screenshots;
      `);
      if (this.db.pragma('foreign_key_check').length) throw new Error('付款截图迁移后关联校验失败');
    });
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  read(id) { const row = this.db.prepare('SELECT data FROM orders WHERE id=?').get(id); return row ? JSON.parse(row.data) : null; }
  write(order, now) {
    this.db.prepare('UPDATE orders SET data=?, timely_order_id=?, updated_at=? WHERE id=?')
      .run(JSON.stringify(order), order.external.timelyOrderId || null, now, order.id);
  }

}
