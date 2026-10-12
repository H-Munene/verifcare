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

  // Bucket names are left to CloudFormation since they must be globally unique.
  const biometricEnrollmentsBucket = new s3.Bucket(stack, "BiometricEnrollmentsBucket", {
    encryption: s3.BucketEncryption.KMS,
    encryptionKey: biometricEnrollmentsKey,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    enforceSSL: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    // No lifecycle rule: the app deletes these on offboarding.
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
