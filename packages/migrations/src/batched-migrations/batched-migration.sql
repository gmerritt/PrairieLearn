-- BLOCK insert_batched_migration
INSERT INTO
  batched_migrations (
    project,
    filename,
    timestamp,
    batch_size,
    min_value,
    max_value
  )
VALUES
  (
    $project,
    $filename,
    $timestamp,
    $batch_size,
    $min_value,
    $max_value
  )
RETURNING
  *;

-- BLOCK select_all_batched_migrations
SELECT
  *
FROM
  batched_migrations
WHERE
  project = $project
ORDER BY
  id ASC;

-- BLOCK update_batched_migration_status
UPDATE batched_migrations
SET
  status = $status,
  updated_at = CURRENT_TIMESTAMP
WHERE
  id = $id;
