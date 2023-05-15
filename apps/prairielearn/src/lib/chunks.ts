import { S3 } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import async = require('async');
import child_process = require('child_process');
import fs = require('fs-extra');
import path = require('path');
import { PassThrough as PassThroughStream } from 'stream';
import tar = require('tar');
import util = require('util');
import { v4 as uuidv4 } from 'uuid';

import { logger } from '@prairielearn/logger';
import namedLocks = require('@prairielearn/named-locks');
import sqldb = require('@prairielearn/postgres');

import aws = require('./aws');
import { chalk, chalkDim } from './chalk';
import serverJobs = require('./server-jobs-legacy');
import type { Job } from './server-jobs-legacy';
import courseDB = require('../sync/course-db');
import type { CourseData } from '../sync/course-db';
import { config } from './config';

const sql = sqldb.loadSqlEquiv(__filename);

type ChunkType =
  | 'elements'
  | 'elementExtensions'
  | 'clientFilesCourse'
  | 'serverFilesCourse'
  | 'clientFilesCourseInstance'
  | 'clientFilesAssessment'
  | 'question';

type ElementsChunkMetadata = {
  type: 'elements';
};

type ElementExtensionsChunkMetadata = {
  type: 'elementExtensions';
};

type ClientFilesCourseChunkMetadata = {
  type: 'clientFilesCourse';
};

type ServerFilesCourseChunkMetadata = {
  type: 'serverFilesCourse';
};

type ClientFilesCourseInstanceChunkMetadata = {
  type: 'clientFilesCourseInstance';
  courseInstanceName: string;
};

type ClientFilesAssessmentChunkMetadata = {
  type: 'clientFilesAssessment';
  courseInstanceName: string;
  assessmentName: string;
};

type QuestionChunkMetadata = {
  type: 'question';
  questionName: string;
};

/**
 * {@link ChunkMetadata} objects are used to refer to chunks according to their
 * human-readable names. For instance, a question chunk has a `questionName` property
 * that corresponds to a QID, not a `questionId` property that corresponds to a
 * database identifier.
 *
 * For chunks that are identified by database IDs instead, see {@link Chunk}.
 *
 */
type ChunkMetadata =
  | ElementsChunkMetadata
  | ElementExtensionsChunkMetadata
  | ClientFilesCourseChunkMetadata
  | ServerFilesCourseChunkMetadata
  | ClientFilesCourseInstanceChunkMetadata
  | ClientFilesAssessmentChunkMetadata
  | QuestionChunkMetadata;

type ElementsChunk = {
  type: 'elements';
};

type ElementExtensionsChunk = {
  type: 'elementExtensions';
};

type ClientFilesCourseChunk = {
  type: 'clientFilesCourse';
};

type ServerFilesCourseChunk = {
  type: 'serverFilesCourse';
};

type ClientFilesCourseInstanceChunk = {
  type: 'clientFilesCourseInstance';
  courseInstanceId: string | number;
};

type ClientFilesAssessmentChunk = {
  type: 'clientFilesAssessment';
  courseInstanceId: string | number;
  assessmentId: string | number;
};

type QuestionChunk = {
  type: 'question';
  questionId: string | number;
};

/**
 * {@link Chunk} objects are used to identify chunks by the IDs of their
 * corresponding entities. For instance, a question chunk has a `questionId`
 * property that corresponds to `questions.id` in the database.
 *
 * For chunks that are identified by human-readable names instead, see
 * {@link ChunkMetadata}.
 *
 */
export type Chunk =
  | ElementsChunk
  | ElementExtensionsChunk
  | ClientFilesCourseChunk
  | ServerFilesCourseChunk
  | ClientFilesCourseInstanceChunk
  | ClientFilesAssessmentChunk
  | QuestionChunk;

/**
 * {@link DatabaseChunk} objects represent chunks that we've fetched from the
 * database. They're sort of a superset of {@link Chunk} and {@link ChunkMetadata}
 * objects that contain both the IDs and human-readable names of the chunks.
 */
type DatabaseChunk = {
  id: string | number | null;
  type: ChunkType;
  uuid: string;
  course_id: string | number;
  course_instance_id?: string | number;
  course_instance_name?: string;
  assessment_id?: string | number;
  assessment_name?: string;
  question_id?: string | number;
  question_name?: string;
};

type CourseInstanceChunks = {
  clientFilesCourseInstance: boolean;
  assessments: Set<string>;
};

type CourseChunks = {
  elements: boolean;
  elementExtensions: boolean;
  clientFilesCourse: boolean;
  serverFilesCourse: boolean;
  questions: Set<string>;
  courseInstances: {
    [id: string]: CourseInstanceChunks;
  };
};

/**
 * Constructs a {@link ChunkMetadata} object from the given {@link DatabaseChunk}
 * object.
 */
export function chunkMetadataFromDatabaseChunk(chunk: DatabaseChunk): ChunkMetadata {
  switch (chunk.type) {
    case 'elements':
    case 'elementExtensions':
    case 'clientFilesCourse':
    case 'serverFilesCourse':
      return {
        type: chunk.type,
      };
    case 'clientFilesCourseInstance':
      if (!chunk.course_instance_name) {
        throw new Error(`course_instance_name is missing for chunk ${chunk.uuid}`);
      }
      return {
        type: chunk.type,
        courseInstanceName: chunk.course_instance_name,
      };
    case 'clientFilesAssessment':
      if (!chunk.course_instance_name) {
        throw new Error(`course_instance_name is missing for chunk ${chunk.uuid}`);
      }
      if (!chunk.assessment_name) {
        throw new Error(`assessment_name is missing for chunk ${chunk.uuid}`);
      }
      return {
        type: chunk.type,
        courseInstanceName: chunk.course_instance_name,
        assessmentName: chunk.assessment_name,
      };
    case 'question':
      if (!chunk.question_name) {
        throw new Error(`question_name is missing for chunk ${chunk.uuid}`);
      }
      return {
        type: chunk.type,
        questionName: chunk.question_name,
      };
  }
}

/**
 * Returns the path for a given chunk relative to the course's root directory.
 */
export function pathForChunk(chunkMetadata: ChunkMetadata): string {
  switch (chunkMetadata.type) {
    case 'elements':
    case 'elementExtensions':
    case 'clientFilesCourse':
    case 'serverFilesCourse':
      return chunkMetadata.type;
    case 'question':
      return path.join('questions', chunkMetadata.questionName);
    case 'clientFilesCourseInstance':
      return path.join(
        'courseInstances',
        chunkMetadata.courseInstanceName,
        'clientFilesCourseInstance'
      );
    case 'clientFilesAssessment':
      return path.join(
        'courseInstances',
        chunkMetadata.courseInstanceName,
        'assessments',
        chunkMetadata.assessmentName,
        'clientFilesAssessment'
      );
  }
}

/**
 * Returns the absolute path for a course's chunk within the course's runtime
 * directory.
 */
export function coursePathForChunk(coursePath: string, chunkMetadata: ChunkMetadata): string {
  return path.join(coursePath, pathForChunk(chunkMetadata));
}

/**
 * Identifies the files that changes between two commits in a given course.
 *
 * @param coursePath The course directory to diff
 * @param oldHash The old (previous) hash for the diff
 * @param newHash The new (current) hash for the diff
 * @returns List of changed files
 */
export async function identifyChangedFiles(
  coursePath: string,
  oldHash: string,
  newHash: string
): Promise<string[]> {
  const { stdout } = await util.promisify(child_process.exec)(
    `git diff --name-only ${oldHash}..${newHash}`,
    { cwd: coursePath }
  );
  return stdout.trim().split('\n');
}

/**
 * Given a list of files that have changed (such as that produced by
 * `git diff --name-only`), returns a data structure describing the chunks
 * that need to be generated.
 *
 * @param changedFiles A list of files that changed in a given sync.
 * @param courseData The "full course" that was loaded from disk.
 */
export function identifyChunksFromChangedFiles(
  changedFiles: string[],
  courseData: CourseData
): CourseChunks {
  const courseChunks: CourseChunks = {
    elements: false,
    elementExtensions: false,
    clientFilesCourse: false,
    serverFilesCourse: false,
    courseInstances: {},
    questions: new Set(),
  };

  changedFiles.forEach((changedFile) => {
    if (changedFile.startsWith('elements/')) {
      courseChunks.elements = true;
    }
    if (changedFile.startsWith('elementExtensions/')) {
      courseChunks.elementExtensions = true;
    }
    if (changedFile.startsWith('serverFilesCourse/')) {
      courseChunks.serverFilesCourse = true;
    }
    if (changedFile.startsWith('clientFilesCourse/')) {
      courseChunks.clientFilesCourse = true;
    }
    if (changedFile.startsWith('questions/')) {
      // Here's where things get interesting. Questions can be nested in
      // directories, so we need to figure out which of the potentially
      // deeply-nested directories is the root of a particular question.
      const pathComponents = changedFile.split(path.sep).slice(1);
      // Progressively join more and more path components until we get
      // something that corresponds to an actual question
      let questionId: string | null = null;
      for (let i = 1; i < pathComponents.length; i++) {
        const candidateQuestionId = path.join(...pathComponents.slice(0, i));
        if (courseData.questions[candidateQuestionId]) {
          questionId = candidateQuestionId;
          break;
        }
      }
      if (questionId) {
        // This chunk corresponds to a question!
        courseChunks.questions.add(questionId);
      }
    }
    if (changedFile.startsWith('courseInstances/')) {
      // This could be one of two things: `clientFilesCourseInstance` or
      // `clientFileAssessment`.

      const pathComponents = changedFile.split(path.sep).slice(1);

      const clientFilesCourseInstanceIndex = pathComponents.indexOf('clientFilesCourseInstance');
      const assessmentsIndex = pathComponents.indexOf('assessments');
      const clientFilesAssessmentIndex = pathComponents.indexOf('clientFilesAssessment');

      if (clientFilesCourseInstanceIndex >= 0) {
        // Let's validate that the preceeding path components correspond
        // to an actual course instance
        const courseInstanceId = path.join(
          ...pathComponents.slice(0, clientFilesCourseInstanceIndex)
        );
        if (courseData.courseInstances[courseInstanceId]) {
          if (!courseChunks.courseInstances[courseInstanceId]) {
            courseChunks.courseInstances[courseInstanceId] = {
              assessments: new Set(),
              clientFilesCourseInstance: true,
            };
          }
          courseChunks.courseInstances[courseInstanceId].clientFilesCourseInstance = true;
          return;
        }
      }

      // Important: fall through to account for weird things like people putting
      // `clientFilesCourseInstance` directories inside of `clientFileAssessment`
      // for some strange reason.
      if (
        assessmentsIndex >= 0 &&
        clientFilesAssessmentIndex >= 0 &&
        clientFilesAssessmentIndex > assessmentsIndex
      ) {
        // We probably care about this file - let's validate that by
        // splitting up the path into chunks that hopefully correspond
        // to course instance IDs and assessment IDs.
        const courseInstanceId = path.join(...pathComponents.slice(0, assessmentsIndex));
        const assessmentId = path.join(
          ...pathComponents.slice(assessmentsIndex + 1, clientFilesAssessmentIndex)
        );

        if (
          courseData.courseInstances[courseInstanceId] &&
          courseData.courseInstances[courseInstanceId].assessments[assessmentId]
        ) {
          // This corresponds to something that we need to
          // create/update a chunk for!
          if (!courseChunks.courseInstances[courseInstanceId]) {
            courseChunks.courseInstances[courseInstanceId] = {
              assessments: new Set(),
              clientFilesCourseInstance: false,
            };
          }
          courseChunks.courseInstances[courseInstanceId].assessments.add(assessmentId);
        }
      }
    }
  });

  return courseChunks;
}

/**
 * Returns all the chunks the are currently stored for the given course.
 */
export async function getAllChunksForCourse(courseId: string) {
  const result = await sqldb.queryAsync(sql.select_course_chunks, {
    course_id: courseId,
  });
  return result.rows;
}

interface DiffChunksOptions {
  coursePath: string;
  courseId: string;
  courseData: CourseData;
  changedFiles: string[];
}

interface ChunksDiff {
  updatedChunks: ChunkMetadata[];
  deletedChunks: ChunkMetadata[];
}

/**
 * Given a course ID, computes a list of all chunks that need to be
 * (re)generated.
 */
export async function diffChunks({
  coursePath,
  courseId,
  courseData,
  changedFiles,
}: DiffChunksOptions): Promise<ChunksDiff> {
  const rawCourseChunks = await getAllChunksForCourse(courseId);

  // Build a data structure from the result of getAllChunksForCourse so that
  // we can efficiently query to see if a given chunk exists
  const existingCourseChunks: CourseChunks = {
    elements: false,
    elementExtensions: false,
    serverFilesCourse: false,
    clientFilesCourse: false,
    courseInstances: {},
    questions: new Set(),
  };

  rawCourseChunks.forEach((courseChunk) => {
    switch (courseChunk.type) {
      case 'elements':
      case 'elementExtensions':
      case 'serverFilesCourse':
      case 'clientFilesCourse':
        existingCourseChunks[courseChunk.type] = true;
        break;
      case 'question':
        existingCourseChunks.questions.add(courseChunk.question_name);
        break;
      case 'clientFilesCourseInstance': {
        const courseInstanceName = courseChunk.course_instance_name;
        if (!existingCourseChunks.courseInstances[courseInstanceName]) {
          existingCourseChunks.courseInstances[courseInstanceName] = {
            assessments: new Set(),
            clientFilesCourseInstance: true,
          };
        }
        existingCourseChunks.courseInstances[courseInstanceName].clientFilesCourseInstance = true;
        break;
      }
      case 'clientFilesAssessment': {
        const courseInstanceName = courseChunk.course_instance_name;
        const assessmentName = courseChunk.assessment_name;
        if (!existingCourseChunks.courseInstances[courseInstanceName]) {
          existingCourseChunks.courseInstances[courseInstanceName] = {
            assessments: new Set(),
            clientFilesCourseInstance: false,
          };
        }
        existingCourseChunks.courseInstances[courseInstanceName].assessments.add(assessmentName);
        break;
      }
    }
  });

  const changedCourseChunks = identifyChunksFromChangedFiles(changedFiles, courseData);

  // Now, let's compute the set of chunks that we need to update or delete.
  const updatedChunks: ChunkMetadata[] = [];
  const deletedChunks: ChunkMetadata[] = [];

  // First: elements, clientFilesCourse, and serverFilesCourse
  for (const chunkType of [
    'elements',
    'elementExtensions',
    'clientFilesCourse',
    'serverFilesCourse',
  ] as const) {
    const hasChunkDirectory = await fs.pathExists(path.join(coursePath, chunkType));
    if (hasChunkDirectory && (!existingCourseChunks[chunkType] || changedCourseChunks[chunkType])) {
      updatedChunks.push({ type: chunkType });
    } else if (!hasChunkDirectory && existingCourseChunks[chunkType]) {
      deletedChunks.push({ type: chunkType });
    }
  }

  // Next: questions
  Object.keys(courseData.questions).forEach((qid) => {
    if (!existingCourseChunks.questions.has(qid) || changedCourseChunks.questions.has(qid)) {
      updatedChunks.push({
        type: 'question',
        questionName: qid,
      });
    }
  });

  // Check for any deleted questions.
  existingCourseChunks.questions.forEach((qid) => {
    if (!courseData.questions[qid]) {
      deletedChunks.push({
        type: 'question',
        questionName: qid,
      });
    }
  });

  // Next: course instances and their assessments
  await async.each(
    Object.entries(courseData.courseInstances),
    async ([ciid, courseInstanceInfo]) => {
      const hasClientFilesCourseInstanceDirectory = await fs.pathExists(
        path.join(coursePath, 'courseInstances', ciid, 'clientFilesCourseInstance')
      );
      if (
        hasClientFilesCourseInstanceDirectory &&
        (!existingCourseChunks.courseInstances[ciid]?.clientFilesCourseInstance ||
          changedCourseChunks.courseInstances[ciid]?.clientFilesCourseInstance)
      ) {
        updatedChunks.push({
          type: 'clientFilesCourseInstance',
          courseInstanceName: ciid,
        });
      }

      await async.each(Object.keys(courseInstanceInfo.assessments), async (tid) => {
        const hasClientFilesAssessmentDirectory = await fs.pathExists(
          path.join(
            coursePath,
            'courseInstances',
            ciid,
            'assessments',
            tid,
            'clientFilesAssessment'
          )
        );
        if (
          hasClientFilesAssessmentDirectory &&
          (!existingCourseChunks.courseInstances[ciid]?.assessments?.has(tid) ||
            changedCourseChunks.courseInstances[ciid]?.assessments?.has(tid))
        ) {
          updatedChunks.push({
            type: 'clientFilesAssessment',
            courseInstanceName: ciid,
            assessmentName: tid,
          });
        }
      });
    }
  );

  // Check for any deleted course instances or their assessments.
  await Promise.all(
    Object.entries(existingCourseChunks.courseInstances).map(async ([ciid, courseInstanceInfo]) => {
      const courseInstanceExists = !!courseData.courseInstances[ciid];
      const clientFilesCourseInstanceExists = await fs.pathExists(
        path.join(coursePath, 'courseInstances', ciid, 'clientFilesCourseInstance')
      );
      if (!courseInstanceExists || !clientFilesCourseInstanceExists) {
        deletedChunks.push({
          type: 'clientFilesCourseInstance',
          courseInstanceName: ciid,
        });
      }

      await Promise.all(
        [...courseInstanceInfo.assessments].map(async (tid) => {
          const assessmentExists = !!courseData.courseInstances[ciid]?.assessments[tid];
          const clientFilesAssessmentExists = await fs.pathExists(
            path.join(
              coursePath,
              'courseInstances',
              ciid,
              'assessments',
              tid,
              'clientFilesAssessment'
            )
          );
          if (!courseInstanceExists || !assessmentExists || !clientFilesAssessmentExists) {
            deletedChunks.push({
              type: 'clientFilesAssessment',
              courseInstanceName: ciid,
              assessmentName: tid,
            });
          }
        })
      );
    })
  );

  return { updatedChunks, deletedChunks };
}

export async function createAndUploadChunks(
  coursePath: string,
  courseId: string,
  chunksToGenerate: ChunkMetadata[]
) {
  const generatedChunks: (ChunkMetadata & { uuid: string })[] = [];

  await async.eachLimit(chunksToGenerate, config.chunksMaxParallelUpload, async (chunk) => {
    const chunkDirectory = coursePathForChunk(coursePath, chunk);

    // Generate a UUId for this chunk
    const chunkUuid = uuidv4();

    // Let's create a tarball for this chunk and send it off to S3
    const tarball = tar.create(
      {
        gzip: true,
        cwd: chunkDirectory,
      },
      ['.']
    );

    const passthrough = new PassThroughStream();
    tarball.pipe(passthrough);

    const s3 = new S3(aws.makeS3ClientConfig());
    await new Upload({
      client: s3,
      params: {
        Bucket: config.chunksS3Bucket,
        Key: `${chunkUuid}.tar.gz`,
        Body: passthrough,
      },
    }).done();

    generatedChunks.push({ ...chunk, uuid: chunkUuid });
  });

  // Now that the new chunks have been uploaded, update their status in the database
  await sqldb.queryAsync(sql.insert_chunks, {
    course_id: courseId,
    // Force this to a string; otherwise, our code in `sql-db.js` will try to
    // convert it into a Postgres `ARRAY[...]` type, which we don't want.
    chunks: JSON.stringify(generatedChunks),
  });
}

/**
 * Deletes the specified chunks from the database. Note that they are not
 * deleted from S3 at this time.
 */
export async function deleteChunks(courseId: string, chunksToDelete: ChunkMetadata[]) {
  if (chunksToDelete.length === 0) {
    // Avoid a round-trip to the DB if there's nothing to delete.
    return;
  }

  await sqldb.queryAsync(sql.delete_chunks, {
    course_id: courseId,
    // Force this to a string; otherwise, our code in `sql-db.js` will try to
    // convert it into a Postgres `ARRAY[...]` type, which we don't want.
    chunks: JSON.stringify(chunksToDelete),
  });
}

/**
 * Returns the paths to the chunks directories for the given course
 * ID. The "downloads" directory will hold in-progress chunk
 * downloads, the "chunks" directory will hold fully-downloaded chunk
 * zip files, the "unpacked" directory will hold unpacked zips, and
 * the "course" directory is the reconstructed directory hierarchy
 * that mimics the source repo.
 *
 * IMPORTANT: we previously differentiated between `base` and `course` - that
 * is, `course` was a subdirectory of `base`. However, we've since changed
 * that so that the base directory *is* the course directory, and all
 * chunk-related directories are subdirectories of the course directory. This
 * is crucial for the way that we containerize course code execution, as we
 * need any symlinks to refer to point to something within the course directory.
 * Otherwise, when we mount the course directory into a container, the symlinks
 * won't be resolvable.
 *
 * @param courseId The ID of the course in question
 */
export function getChunksDirectoriesForCourseId(courseId: string) {
  const baseDirectory = path.join(config.chunksConsumerDirectory, `course-${courseId}`);
  return {
    base: baseDirectory,
    course: baseDirectory,
    downloads: path.join(baseDirectory, '__chunks', 'downloads'),
    chunks: path.join(baseDirectory, '__chunks', 'chunks'),
    unpacked: path.join(baseDirectory, '__chunks', 'unpacked'),
  };
}

interface CourseWithRuntimeDirectory {
  /** The database ID of the course. */
  id: string;
  /** The path to the course source (not the chunks) */
  path: string;
}

/**
 * Returns the absolute path to the course directory that should be used at
 * runtime for things like serving course files, executing question code, etc.
 * If chunks are enabled, this will be same as the "course" directory from
 * `getChunksDirectoriesForCourseId`. Otherwise, this returns the path of the
 * course that was passed in. This abstraction allows calling code to not need
 * to know if chunks are enabled or not.
 *
 * This function is designed to take a course object like one would get from
 * `res.locals.course`. If such an object isn't readily available, you can
 * just construct one with a course ID and course path.
 */
export function getRuntimeDirectoryForCourse(course: CourseWithRuntimeDirectory): string {
  if (config.chunksConsumer) {
    return getChunksDirectoriesForCourseId(course.id).course;
  } else {
    return course.path;
  }
}

interface UpdateChunksForCourseOptions {
  coursePath: string;
  courseId: string;
  courseData: CourseData;
  oldHash?: string | null;
  newHash?: string | null;
}

export async function updateChunksForCourse({
  coursePath,
  courseId,
  courseData,
  oldHash,
  newHash,
}: UpdateChunksForCourseOptions): Promise<ChunksDiff> {
  let changedFiles: string[] = [];
  if (oldHash && newHash) {
    changedFiles = await identifyChangedFiles(coursePath, oldHash, newHash);
  }

  const { updatedChunks, deletedChunks } = await diffChunks({
    coursePath,
    courseId,
    courseData,
    changedFiles,
  });

  await createAndUploadChunks(coursePath, courseId, updatedChunks);
  await deleteChunks(courseId, deletedChunks);

  return { updatedChunks, deletedChunks };
}

/**
 * Generates all chunks for a list of courses.
 */
export async function generateAllChunksForCourseList(course_ids: string[], authn_user_id: string) {
  const jobSequenceOptions = {
    user_id: authn_user_id,
    authn_user_id: authn_user_id,
    type: 'generate_all_chunks',
    description: 'Generate all chunks for a list of courses',
  };
  const job_sequence_id = await serverJobs.createJobSequenceAsync(jobSequenceOptions);

  // don't await this, we want it to run in the background
  // eslint-disable-next-line no-floating-promise/no-floating-promise
  _generateAllChunksForCourseListWithJobSequence(course_ids, authn_user_id, job_sequence_id);

  // return immediately, while the generation is still running
  return job_sequence_id;
}

/**
 * Helper function to actually generate all chunks for a list of courses.
 */
async function _generateAllChunksForCourseListWithJobSequence(
  course_ids: string[],
  authn_user_id: string,
  job_sequence_id: string
) {
  try {
    for (let i = 0; i < course_ids.length; i++) {
      const course_id = course_ids[i];
      const jobOptions = {
        course_id: null /* Set the job's course_id to null so we can find it from the admin page */,
        type: 'generate_all_chunks',
        description: `Generate all chunks for course ID = ${course_id}`,
        job_sequence_id,
        user_id: authn_user_id,
        authn_user_id,
        last_in_sequence: i === course_ids.length - 1,
      };
      const job = await serverJobs.createJobAsync(jobOptions);
      job.info(chalkDim(`Course ID = ${course_id}`));

      try {
        await _generateAllChunksForCourseWithJob(course_id, job);
        job.succeed();
      } catch (err) {
        job.error(chalk.red(JSON.stringify(err)));
        await job.failAsync(err);
        throw err;
      }
    }
  } catch (err) {
    try {
      await serverJobs.failJobSequenceAsync(job_sequence_id);
    } catch (err) {
      logger.error(`Failed to fail job_sequence_id=${job_sequence_id}`);
    }
  }
}

/**
 * Helper function to generate all chunks for a single course.
 */
async function _generateAllChunksForCourseWithJob(course_id: string, job: Job) {
  job.info(chalk.bold(`Looking up course directory`));
  const result = await sqldb.queryOneRowAsync(sql.select_course_dir, { course_id });
  let courseDir = result.rows[0].path;
  job.info(chalkDim(`Found course directory = ${courseDir}`));
  courseDir = path.resolve(process.cwd(), courseDir);
  job.info(chalkDim(`Resolved course directory = ${courseDir}`));

  const lockName = `coursedir:${courseDir}`;
  job.info(chalk.bold(`Acquiring lock ${lockName}`));

  await namedLocks.doWithLock(lockName, {}, async () => {
    job.info(chalkDim(`Acquired lock`));

    job.info(chalk.bold(`Loading course data from ${courseDir}`));
    const courseData = await courseDB.loadFullCourse(courseDir);
    job.info(chalkDim(`Loaded course data`));

    job.info(chalk.bold(`Generating all chunks`));
    const chunkOptions = {
      coursePath: courseDir,
      courseId: String(course_id),
      courseData,
    };
    const chunkChanges = await updateChunksForCourse(chunkOptions);
    logChunkChangesToJob(chunkChanges, job);
    job.info(chalkDim(`Generated all chunks`));
  });

  job.info(chalkDim(`Released lock`));

  job.info(chalk.green(`Successfully generated chunks for course ID = ${course_id}`));
}

const ensureChunk = async (courseId: string, chunk: DatabaseChunk) => {
  const courseChunksDirs = getChunksDirectoriesForCourseId(courseId);
  const downloadPath = path.join(courseChunksDirs.downloads, `${chunk.uuid}.tar.gz`);
  const chunkPath = path.join(courseChunksDirs.chunks, `${chunk.uuid}.tar.gz`);
  const unpackPath = path.join(courseChunksDirs.unpacked, chunk.uuid);
  let relativeTargetPath;
  switch (chunk.type) {
    case 'elements':
    case 'elementExtensions':
    case 'serverFilesCourse':
    case 'clientFilesCourse':
      relativeTargetPath = chunk.type;
      break;
    case 'clientFilesCourseInstance':
      if (!chunk.course_instance_name) {
        throw new Error(`course_instance_name is missing for chunk ${chunk.uuid}`);
      }
      relativeTargetPath = path.join(
        'courseInstances',
        chunk.course_instance_name,
        'clientFilesCourseInstance'
      );
      break;
    case 'clientFilesAssessment':
      if (!chunk.course_instance_name) {
        throw new Error(`course_instance_name is missing for chunk ${chunk.uuid}`);
      }
      if (!chunk.assessment_name) {
        throw new Error(`assessment_name is missing for chunk ${chunk.uuid}`);
      }
      relativeTargetPath = path.join(
        'courseInstances',
        chunk.course_instance_name,
        'assessments',
        chunk.assessment_name,
        'clientFilesAssessment'
      );
      break;
    case 'question':
      if (!chunk.question_name) {
        throw new Error(`question_name is missing for chunk ${chunk.uuid}`);
      }
      relativeTargetPath = path.join('questions', chunk.question_name);
      break;
    default:
      throw new Error(`unknown type for chunk=${JSON.stringify(chunk)}`);
  }
  const targetPath = path.join(courseChunksDirs.course, relativeTargetPath);
  const relativeUnpackPath = path.relative(path.dirname(targetPath), unpackPath);

  // We have a chunk installed if we have a symlink targetPath -> relativeUnpackPath
  let chunkExists = false;
  try {
    const linkString = await fs.readlink(targetPath);
    if (linkString === relativeUnpackPath) {
      chunkExists = true;
    }
  } catch (err) {
    // Allow ENOENT errors to continue, because they mean we don't have the chunk
    if (err.code !== 'ENOENT') throw err;
  }
  if (chunkExists) {
    // If we have the correct link then this chunk is unpacked and
    // installed. We're good to go!
    return;
  }

  // Otherwise, we need to download and untar the chunk. We'll download it
  // to the "downloads" path first, then rename it to the "chunks" path.
  await fs.ensureDir(path.dirname(downloadPath));
  await aws.downloadFromS3Async(config.chunksS3Bucket, `${chunk.uuid}.tar.gz`, downloadPath);
  await fs.move(downloadPath, chunkPath, { overwrite: true });

  // Once the chunk has been downloaded, we need to untar it. In
  // case we had an earlier unpack attempt, we will remove the
  // existing unpack directory to ensure a clean slate.
  await fs.remove(unpackPath);
  await fs.ensureDir(unpackPath);
  await tar.extract({
    file: chunkPath,
    cwd: unpackPath,
  });

  // Before we configure the symlink, we need to check if there are any
  // outdated symlinks that need to be removed. Those can occur when a question
  // is renamed into a directory nested inside of its former directory, e.g.
  // if `questions/a/b/info.json` is moved to `questions/a/b/c/info.json`.
  //
  // We'll handle this by checking if any parent directory of the `targetPath`
  // exists and is a symlink. If so, we'll remove it. This should always be
  // safe because we should never have nested symlinks.
  const pathSegments = relativeTargetPath.split(path.sep);
  for (let i = 1; i < pathSegments.length; i++) {
    const parentPath = path.join(courseChunksDirs.course, ...pathSegments.slice(0, i));
    try {
      const stat = await fs.lstat(parentPath);
      if (stat.isSymbolicLink()) {
        await fs.remove(parentPath);
      } else if (!stat.isDirectory()) {
        throw new Error(`${parentPath} exists but is not a directory`);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  // Finally, link targetPath -> relativeUnpackPath
  // Note that ensureSymlink() won't overwrite an existing targetPath
  // See:
  //     https://github.com/jprichardson/node-fs-extra/pull/869
  //     https://github.com/jprichardson/node-fs-extra/issues/786
  //     https://github.com/jprichardson/node-fs-extra/pull/826
  // As a work-around, we symlink a temporary name and move it over targetPath
  const tmpPath = `${targetPath}-${chunk.uuid}`;
  await fs.ensureSymlink(relativeUnpackPath, tmpPath);
  await fs.rename(tmpPath, targetPath);
};

const pendingChunksMap = new Map<string, Promise<void>>();

/**
 * Ensures that specific chunks for a course are loaded. These chunks will either be pulled
 * from S3 if they do not exist, or the existing on-disk chunks will be used if they are
 * still the latest version.
 *
 * For each requested chunk, if the chunk exists on disk but does not exist in
 * the database, the chunk will be removed from the course's runtime directory.
 *
 * @param courseId The ID of the course to load chunks for.
 * @param chunks One or more chunks to load.
 */
export async function ensureChunksForCourseAsync(courseId: string, chunks: Chunk | Chunk[]) {
  if (!config.chunksConsumer) {
    // We only need to worry if we are a chunk consumer server
    return;
  }

  if (!Array.isArray(chunks)) {
    chunks = [chunks];
  }

  // First, query the database to identify the UUID + associated name(s) of each desired chunk
  // "Names" in this case refers to question/course instance/assessment names.
  const dbChunks = await sqldb.queryAsync(sql.select_metadata_for_chunks, {
    course_id: courseId,
    chunks_arr: JSON.stringify(chunks),
  });

  // The results from the database contain information for chunks that exist in
  // the database, and also for chunks that do _not_ exist in the database. We
  // use the latter to remove chunks from disk if they no longer correspond to
  // a directory in the course. We differentiate between the two based on the
  // presence of an `id` field in the response.
  //
  // See the end of this function for more details.
  const validChunks = dbChunks.rows.filter((chunk) => chunk.id != null);
  const missingChunks = dbChunks.rows.filter((chunk) => chunk.id == null);

  // Now, ensure each individual chunk is loaded and untarred to the correct
  // place on disk.
  await async.eachLimit(validChunks, config.chunksMaxParallelDownload, async (chunk) => {
    const pendingChunkKey = `${courseId}-${chunk.uuid}`;
    const pendingChunkPromise = pendingChunksMap.get(pendingChunkKey);
    if (pendingChunkPromise) {
      // If this chunk is already being loaded, reuse the existing promise
      return pendingChunkPromise;
    }

    const chunkPromise = ensureChunk(courseId, chunk);
    pendingChunksMap.set(pendingChunkKey, chunkPromise);
    try {
      await chunkPromise;
    } finally {
      // Once the promise has settled, remove it from our collection of
      // pending promises. This helps prevent memory leaks and, more
      // importantly, ensures we don't cache rejected promises - if loading
      // a chunk fails for some reason, this will ensure we try to load it
      // again the next time it's requested.
      pendingChunksMap.delete(pendingChunkKey);
    }
  });

  // We also need to take care to remove any chunks that are no longer valid.
  // For instance, if a course previously had an `elements` directory but that
  // directory was removed in a more recent revision, we need to ensure that
  // the `elements` directory does not exist inside the course's runtime
  // directory.
  //
  // For any chunk that the caller is asking to "ensure", we check if it exists
  // in the results of `select_metadata_for_chunks`. If it does not, we remove
  // the chunk from the course's runtime directory.
  //
  // See https://github.com/PrairieLearn/PrairieLearn/issues/4692 for more details.
  const courseChunksDirs = getChunksDirectoriesForCourseId(courseId);
  await Promise.all(
    missingChunks.map(async (chunk) => {
      // Blindly remove this chunk from disk - if it doesn't exist, `fs.remove`
      // will silently no-op.
      const chunkMetadata = chunkMetadataFromDatabaseChunk(chunk);
      await fs.remove(coursePathForChunk(courseChunksDirs.course, chunkMetadata));
    })
  );
}
export const ensureChunksForCourse = util.callbackify(ensureChunksForCourseAsync);

interface QuestionWithTemplateDirectory {
  id: string;
  template_directory: null | string;
}

/**
 * Get the list of template question IDs for a given question.
 *
 * @param question A question object.
 * @returns Array of question IDs that are (recursive) templates for the given question (may be an empty array).
 */
export async function getTemplateQuestionIdsAsync(
  question: QuestionWithTemplateDirectory
): Promise<string[]> {
  if (!question.template_directory) return [];
  const result = await sqldb.queryAsync(sql.select_template_question_ids, {
    question_id: question.id,
  });
  const questionIds = result.rows.map((r) => r.id);
  return questionIds;
}
export const getTemplateQuestionIds = util.callbackify(getTemplateQuestionIdsAsync);

/**
 * Logs the changes to chunks for a given job.
 */
export function logChunkChangesToJob(
  { updatedChunks, deletedChunks }: ChunksDiff,
  job: Pick<Job, 'verbose'>
) {
  if (updatedChunks.length === 0 && deletedChunks.length === 0) {
    job.verbose('No chunks changed.');
    return;
  }

  const lines: string[] = [];

  if (updatedChunks.length > 0) {
    lines.push('Generated chunks for the following paths:');
    updatedChunks.forEach((chunk) => {
      lines.push(`  ${pathForChunk(chunk)}`);
    });
  } else {
    lines.push('No chunks were generated.');
  }

  if (deletedChunks.length > 0) {
    lines.push('Deleted chunks for the following paths:');
    deletedChunks.forEach((chunk) => {
      lines.push(`  ${pathForChunk(chunk)}`);
    });
  } else {
    lines.push('No chunks were deleted.');
  }

  job.verbose(lines.join('\n'));
}
