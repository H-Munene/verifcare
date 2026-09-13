import * as cdk from "aws-cdk-lib/core";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as kms from "aws-cdk-lib/aws-kms";

export interface Storage {
  biometricEnrollmentsBucket: s3.Bucket;
  visitAudioBucket: s3.Bucket;
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

  return { biometricEnrollmentsBucket, visitAudioBucket };
}
