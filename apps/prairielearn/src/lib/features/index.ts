import { FeatureManager } from './manager';

const featureNames = [
  'manual-grading-rubrics',
  'course-instance-billing',
  'enforce-plan-grants-for-questions',
  // Can only be applied to courses/institutions.
  'allow-rpy2',
  'process-questions-in-worker',
  'question-sharing',
  // Can only be applied to institutions.
  'lti13',
] as const;

const features = new FeatureManager(featureNames);

export type FeatureName = (typeof featureNames)[number];

export { features };
