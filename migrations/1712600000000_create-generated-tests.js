/**
 * Migration: Create generated_tests table for Playwright ZIP generation tracking
 * Stack: node-pg-migrate
 *
 * Run: npx node-pg-migrate up
 */

exports.up = (pgm) => {
  // --- ENUM for test generation status ---
  pgm.createType('gen_test_status', ['pending', 'generating', 'completed', 'failed']);

  // --- Main table ---
  pgm.createTable('generated_tests', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    project_id: {
      type: 'uuid',
      notNull: true,
      references: '"projects"',
      onDelete: 'CASCADE',
    },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: '"users"',
      onDelete: 'CASCADE',
    },
    story_ingestion_id: {
      type: 'uuid',
      notNull: true,
      references: '"story_ingestions"',
      onDelete: 'CASCADE',
    },
    // Which approved scenario IDs were included
    scenario_ids: { type: 'jsonb', notNull: true },
    // User-selected tags: ["smoke", "regression", "sanity", "critical_path", "e2e"]
    categories: { type: 'jsonb', notNull: true, default: '[]' },
    // Generation status
    status: { type: 'gen_test_status', notNull: true, default: 'pending' },
    // Number of test files generated
    test_file_count: { type: 'integer', default: 0 },
    // ZIP stored as base64 in DB for V1.5 simplicity (move to S3 in V2)
    zip_base64: { type: 'text' },
    zip_file_name: { type: 'text' },
    zip_size_bytes: { type: 'integer' },
    // If generation failed
    error_message: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    completed_at: { type: 'timestamptz' },
  });

  pgm.createIndex('generated_tests', ['project_id', 'user_id']);
  pgm.createIndex('generated_tests', ['story_ingestion_id']);
  pgm.createIndex('generated_tests', ['status']);
};

exports.down = (pgm) => {
  pgm.dropTable('generated_tests');
  pgm.dropType('gen_test_status');
};
