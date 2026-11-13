import * as path from "node:path";
import * as cdk from "aws-cdk-lib/core";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";

export interface VoiceParams {
  visitAudioBucket: s3.Bucket;
  voiceprintBucket: s3.Bucket;
}

export interface Voice {
  voiceFunction: lambda.DockerImageFunction;
}

// The voice Lambda (acoustic-model/voice_service): makes enrolment voiceprints and checks visit
// recordings against them, with the frozen ECAPA-TDNN baked into the image. It only reads S3 and
// computes, so it has no VPC and no database access. Only the API Lambda may invoke it.
export function createVoice(stack: cdk.Stack, params: VoiceParams): Voice {
  const { visitAudioBucket, voiceprintBucket } = params;

  const voiceFunction = new lambda.DockerImageFunction(stack, "VoiceFunction", {
    code: lambda.DockerImageCode.fromImageAsset(path.join(__dirname, "../../acoustic-model"), {
      file: "voice_service/Dockerfile",
      // The evaluated torch build is x86_64; matching it keeps scores the same as the evaluation's.
      platform: Platform.LINUX_AMD64,
    }),
    architecture: lambda.Architecture.X86_64,
    // Torch and the model need about 1.5 GB; more memory also means more CPU for each check.
    memorySize: 3008,
    timeout: cdk.Duration.seconds(60),
    environment: {
      VISIT_AUDIO_BUCKET_NAME: visitAudioBucket.bucketName,
      VOICEPRINT_BUCKET_NAME: voiceprintBucket.bucketName,
    },
  });

  // Reads visit recordings and enrolment audio, and deletes enrolment audio once it is a voiceprint.
  visitAudioBucket.grantRead(voiceFunction);
  visitAudioBucket.grantDelete(voiceFunction, "enrol/*");
  voiceprintBucket.grantReadWrite(voiceFunction);
  voiceprintBucket.grantDelete(voiceFunction);

  new cdk.CfnOutput(stack, "VoiceFunctionName", { value: voiceFunction.functionName });
  return { voiceFunction };
}
