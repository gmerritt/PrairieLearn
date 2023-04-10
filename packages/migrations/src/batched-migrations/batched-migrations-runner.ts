import EventEmitter from 'node:events';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadSqlEquiv, queryValidatedZeroOrOneRow } from '@prairielearn/postgres';
import { tryWithLock } from '@prairielearn/named-locks';

import { MigrationFile, readAndValidateMigrationsFromDirectories } from '../load-migrations';
import {
  BatchedMigration,
  BatchedMigrationRowSchema,
  BatchedMigrationRow,
  insertBatchedMigration,
  BatchedMigrationStatus,
  selectBatchedMigrationForTimestamp,
  updateBatchedMigrationStatus,
} from './batched-migration';
import { BatchedMigrationRunner } from './batched-migration-runner';

const sql = loadSqlEquiv(__filename);

const DEFAULT_MIN_VALUE = 1n;
const DEFAULT_BATCH_SIZE = 1_000;
const EXTENSIONS = ['.js', '.ts', '.mjs', '.mts'];

interface BatchedMigrationRunnerOptions {
  project: string;
  directories: string[];
  runDurationMs?: number;
}

export class BatchedMigrationsRunner extends EventEmitter {
  private readonly options: BatchedMigrationRunnerOptions;
  private running: boolean = false;
  private migrationFiles: MigrationFile[] | null = null;
  private abortController = new AbortController();

  constructor(options: BatchedMigrationRunnerOptions) {
    super();
    this.options = options;
  }

  private lockNameForTimestamp(timestamp: string) {
    return `batched-migrations:${this.options.project}:${timestamp}`;
  }

  private getMigrationFiles = async () => {
    if (!this.migrationFiles) {
      this.migrationFiles = await readAndValidateMigrationsFromDirectories(
        this.options.directories,
        EXTENSIONS
      );
    }
    return this.migrationFiles;
  };

  private async getMigrationForIdentifier(identifier: string): Promise<MigrationFile | null> {
    const timestamp = identifier.split('_')[0];

    const migrationFiles = await this.getMigrationFiles();
    const migrationFile = migrationFiles.find((m) => m.timestamp === timestamp);
    return migrationFile ?? null;
  }

  /**
   * Loads that class for the migration with the given identifier. The identifier
   * must start with a 14-character timestamp. It may optionally be followed by
   * an underscore with additional characters, which are ignored. These should
   * typically be used to provide a human-readable name for the migration.
   */
  private async loadMigrationClass(migrationFile: MigrationFile) {
    // We use dynamic imports to handle both CJS and ESM modules.
    const migrationModulePath = path.join(migrationFile.directory, migrationFile.filename);
    const migrationModule = await import(migrationModulePath);

    const MigrationClass = migrationModule.default as new () => BatchedMigration;
    if (!MigrationClass || !(MigrationClass.prototype instanceof BatchedMigration)) {
      throw new Error(`Invalid migration class in ${migrationModulePath}`);
    }
    return MigrationClass;
  }

  async enqueueBatchedMigration(identifier: string) {
    const migrationFile = await this.getMigrationForIdentifier(identifier);
    if (!migrationFile) {
      throw new Error(`No migration found for identifier ${identifier}`);
    }

    const MigrationClass = await this.loadMigrationClass(migrationFile);
    const migration = new MigrationClass();
    const migrationParameters = await migration.getParameters();

    // If `max` is null, that implies that there are no rows to process, so
    // we can immediately mark the migration as finished.
    const status: BatchedMigrationStatus =
      migrationParameters.max === null ? 'succeeded' : 'pending';

    const minValue = migrationParameters.min ?? DEFAULT_MIN_VALUE;
    const maxValue = migrationParameters.max ?? minValue;
    const batchSize = migrationParameters.batchSize ?? DEFAULT_BATCH_SIZE;

    await insertBatchedMigration({
      project: this.options.project,
      filename: migrationFile.filename,
      timestamp: migrationFile.timestamp,
      batch_size: batchSize,
      min_value: minValue,
      max_value: maxValue,
      status,
    });
  }

  async finalizeBatchedMigration(identifier: string) {
    const timestamp = identifier.split('_')[0];

    let migration = await selectBatchedMigrationForTimestamp(this.options.project, timestamp);

    if (migration.status === 'succeeded') return;

    // If the migration isn't already in the finalizing state, mark it as such.
    if (migration.status !== 'finalizing') {
      migration = await updateBatchedMigrationStatus(migration.id, 'finalizing');
    }

    const migrationFile = await this.getMigrationForIdentifier(identifier);
    if (!migrationFile) {
      throw new Error(`No migration found for identifier ${identifier}`);
    }
    const MigrationClass = await this.loadMigrationClass(migrationFile);
    const migrationInstance = new MigrationClass();

    // TODO: we should still lock this migration. Probably what we want to do
    // is to have the normal run loop check for a runnable migration *before*
    // acquiring a lock. If it finds a running one, it should grab and hold a
    // lock just for that specific migration. This allows the instance that's
    // performing finalization to run without anyone else trying to grab a global lock.
    const runner = new BatchedMigrationRunner(migration, migrationInstance);
    await runner.run();

    migration = await selectBatchedMigrationForTimestamp(this.options.project, timestamp);

    if (migration.status === 'succeeded') return;

    throw new Error(
      `Expected batched migration with identifier ${identifier} to be marked as 'succeeded', but it is '${migration.status}'.`
    );
  }

  start() {
    if (this.running) {
      throw new Error('BatchedMigrationsRunner is already running');
    }

    this.loop();
  }

  async loop() {
    this.running = true;
    while (true) {
      if (this.abortController.signal.aborted) {
        this.running = false;
        return;
      }

      let didWork = false;
      try {
        didWork = await this.maybePerformWork(60 * 1000);
      } catch (err) {
        this.emit('error', err);
      }

      // If we did work, we'll immediately try again since there's probably more
      // work to be done. If not, we'll sleep for a while - maybe some more work
      // will become available!
      if (!didWork) {
        // We provide the signal here so that we can more quickly stop things
        // when we're shutting down.
        try {
          await sleep(30_000, null, { ref: false, signal: this.abortController.signal });
        } catch (err) {
          // We don't care about errors here, they should only ever occur when
          // the AbortController is aborted. Continue to the next iteration of
          // the loop so we can shut down.
          continue;
        }
      }
    }
  }

  private async getOrStartMigration(): Promise<BatchedMigrationRow | null> {
    // This query will lock all existing rows in the `batched_migrations` table
    // to guard against race conditions.
    //
    // TODO: should this use `LOCK TABLE ...` instead?
    return queryValidatedZeroOrOneRow(
      sql.select_or_start_running_migration,
      { project: this.options.project },
      BatchedMigrationRowSchema
    );
  }

  async maybePerformWork(durationMs: number): Promise<boolean> {
    const migration = await this.getOrStartMigration();
    if (!migration) {
      // No work to do. Handle this case.
      return false;
    }

    // This server may not yet know about the current running migration. If
    // that's the case, we'll just skip it for now.
    const migrationFile = await this.getMigrationForIdentifier(migration.timestamp);
    if (!migrationFile) {
      return false;
    }

    let didWork = false;
    await tryWithLock(this.lockNameForTimestamp(migrationFile.timestamp), async () => {
      didWork = true;
      const MigrationClass = await this.loadMigrationClass(migrationFile);
      const migrationInstance = new MigrationClass();

      const runner = new BatchedMigrationRunner(migration, migrationInstance);

      try {
        await runner.run({ signal: this.abortController.signal, durationMs });
      } catch (err) {
        this.emit('error', err);
      }
    });

    return didWork;
  }

  async stop() {
    this.abortController.abort();

    // Spin until we're no longer running.
    while (this.running) {
      await sleep(1000);
    }
  }
}

let runner: BatchedMigrationsRunner | null = null;

function assertRunner(
  runner: BatchedMigrationsRunner | null
): asserts runner is BatchedMigrationsRunner {
  if (!runner) throw new Error('Batched migrations not initialized');
}

export function initBatchedMigrations(options: BatchedMigrationRunnerOptions) {
  if (runner) throw new Error('Batched migrations already initialized');
  runner = new BatchedMigrationsRunner(options);
  return runner;
}

export function startBatchedMigrations() {
  assertRunner(runner);
  runner.start();
  return runner;
}

/**
 * Given a batched migration identifier like `20230406184103_migration`,
 * enqueues it for execution by creating a row in the `batched_migrations`
 * table.
 *
 * Despite taking a full identifier, only the timestamp is used to uniquely
 * identify the batched migration. The remaining part is just used to make
 * calls more human-readable.
 *
 * @param identifier The identifier of the batched migration to enqueue.
 */
export async function enqueueBatchedMigration(identifier: string) {
  assertRunner(runner);
  await runner.enqueueBatchedMigration(identifier);
}

export async function finalizeBatchedMigration(identifier: string) {
  assertRunner(runner);
  await runner.finalizeBatchedMigration(identifier);
}

export async function stopBatchedMigrations() {
  assertRunner(runner);
  await runner.stop();
  runner = null;
}
