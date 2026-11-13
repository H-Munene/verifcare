import * as cdk from "aws-cdk-lib/core";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as kms from "aws-cdk-lib/aws-kms";

export interface Storage {
  visitAudioBucket: s3.Bucket;
  voiceprintBucket: s3.Bucket;
}

export function createStorage(stack: cdk.Stack): Storage {
  const visitAudioKey = new kms.Key(stack, "VisitAudioKey", {
    alias: "mzazi-care/visit-audio",
    description: "Encrypts the visit-audio S3 bucket",
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });

  // No bucketName set: S3 bucket names are globally unique across all AWS accounts, so a literal
  // name could collide with an unrelated bucket and fail to deploy. CloudFormation generates a
  // unique physical name from the stack and logical id instead.
  //
  // Holds each visit's recording of up to 30 seconds, which only the dependant's linked family
  // members can play back (backend/src/routes/visitAudio.ts). The 90-day rule is what actually
  // deletes them, and backend's AUDIO_RETENTION_DAYS and the terms state the same number.
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

  new cdk.CfnOutput(stack, "VisitAudioBucketName", {
    value: visitAudioBucket.bucketName,
  });

  // Voiceprints (2026-11-13): biometric data, so its own key, and readable only by the voice Lambda
  // (infra/lib/voice.ts); the API never reads one. No lifecycle rule: a voiceprint is deleted when
  // its person re-enrols or is deactivated (backend/src/voiceChecks.ts).
  const voiceprintKey = new kms.Key(stack, "VoiceprintKey", {
    alias: "mzazi-care/voiceprints",
    description: "Encrypts the voiceprint S3 bucket",
    enableKeyRotation: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });
  const voiceprintBucket = new s3.Bucket(stack, "VoiceprintBucket", {
    encryption: s3.BucketEncryption.KMS,
    encryptionKey: voiceprintKey,
    bucketKeyEnabled: true,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    enforceSSL: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });
  return { visitAudioBucket, voiceprintBucket };
}
