import * as cdk from "aws-cdk-lib/core";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as kms from "aws-cdk-lib/aws-kms";
import * as rekognition from "aws-cdk-lib/aws-rekognition";

export interface Storage {
  biometricEnrollmentsBucket: s3.Bucket;
  visitAudioBucket: s3.Bucket;
  biometricFacesCollection: rekognition.CfnCollection;
}

export function createStorage(stack: cdk.Stack): Storage {
  const biometricEnrollmentsKey = new kms.Key(stack, "BiometricEnrollmentsKey", {
    alias: "mzazi-care/biometric-enrollments",
    description: "Encrypts the biometric-enrollments S3 bucket",
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });

  const visitAudioKey = new kms.Key(stack, "VisitAudioKey", {
    alias: "mzazi-care/visit-audio",
    description: "Encrypts the visit-audio S3 bucket",
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });

  // No bucketName set: S3 bucket names are globally unique across all AWS
  // accounts, not just this one, so a literal "biometric-enrollments" would
  // very likely collide with an unrelated bucket somewhere else and fail to
  // deploy. Letting CloudFormation generate the physical name (derived from
  // the stack/logical id) guarantees uniqueness; architecture.md's bucket
  // "names" are the construct ids/labels below, not literal S3 bucket names.
  const biometricEnrollmentsBucket = new s3.Bucket(stack, "BiometricEnrollmentsBucket", {
    encryption: s3.BucketEncryption.KMS,
    encryptionKey: biometricEnrollmentsKey,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    enforceSSL: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    // No lifecycle rule - per architecture.md's Retention section, deletion
    // here is application-triggered on caregiver/dependant offboarding, not
    // a calendar-based S3 rule (unlike visit-audio below).
    // CORS (HEZ-31/HEZ-85, added after a real "Failed to fetch" reproduced against the admin web
    // app): a browser's PUT straight to a presigned URL is a cross-origin request from the
    // frontend's own origin to S3's REST endpoint, and S3 rejects the preflight for any bucket
    // with no CORS configuration at all - confirmed directly (`aws s3api get-bucket-cors` returned
    // NoSuchCORSConfiguration) and against AWS's own CORS documentation, not assumed. `AllowedOrigins:
    // ['*']` is deliberate, not a shortcut: the presigned URL's own signature is what actually
    // authorizes the upload (it can only be obtained from api's bearer-token-gated
    // /biometric-enrollments/upload-url endpoint in the first place), the same reasoning
    // app.ts's own permissive `cors()` already relies on for the API itself. No frontend origin is
    // fixed yet either (frontend/web/ isn't deployed anywhere - see docs/project-state.md), so a
    // literal origin allowlist would need updating every time that changes.
    cors: [
      {
        allowedMethods: [s3.HttpMethods.PUT],
        allowedOrigins: ["*"],
        allowedHeaders: ["*"],
      },
    ],
  });

  const visitAudioBucket = new s3.Bucket(stack, "VisitAudioBucket", {
    encryption: s3.BucketEncryption.KMS,
    encryptionKey: visitAudioKey,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    enforceSSL: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    lifecycleRules: [
      {
        expiration: cdk.Duration.days(90),
      },
    ],
  });

  new cdk.CfnOutput(stack, "BiometricEnrollmentsBucketName", {
    value: biometricEnrollmentsBucket.bucketName,
  });
  new cdk.CfnOutput(stack, "VisitAudioBucketName", {
    value: visitAudioBucket.bucketName,
  });

  // HEZ-85: a face vector store for the enrollment-uniqueness check (SearchFacesByImage/
  // IndexFaces), a deliberate, narrow exception to architecture.md's otherwise
  // Collections-free design - see that doc's "Biometric enrollment uniqueness" section for the
  // full reasoning. A real CloudFormation/CDK resource (confirmed against AWS's own
  // CloudFormation reference before relying on it), so this stays infrastructure-as-code like
  // everything else here rather than a manual `create-collection` CLI step.
  const biometricFacesCollection = new rekognition.CfnCollection(stack, "BiometricFacesCollection", {
    collectionId: "mzazi-care-biometric-faces",
  });

  return { biometricEnrollmentsBucket, visitAudioBucket, biometricFacesCollection };
}
