// The voice check (2026-11-13): the API's only way to reach the voice Lambda
// (acoustic-model/voice_service). The Lambda reads audio and voiceprints from S3 itself, so no audio
// or voiceprint passes through the API. Results are advisory: callers store whatever comes back,
// and a timeout or error becomes 'unavailable' rather than blocking a visit.

import { InvokeCommand, type LambdaClient } from '@aws-sdk/client-lambda';

export interface VoiceVerifyResult {
  result: 'match' | 'mismatch' | 'too_short';
  score: number | null;
  speechSeconds: number;
  threshold: number;
  modelRevision: string;
}

export type VoiceEnrolResult =
  | { enrolled: true; speechSeconds: number; modelRevision: string }
  | { enrolled: false; speechSeconds: number };

export interface VoiceService {
  /** Makes a voiceprint at voiceprintKey from the enrolment audio, then deletes that audio. */
  enrol: (input: { audioKey: string; voiceprintKey: string }) => Promise<VoiceEnrolResult>;
  /** Scores one recording against the voiceprint of the person it claims to be. */
  verify: (input: { audioKey: string; voiceprintKey: string }) => Promise<VoiceVerifyResult>;
  /** Deletes a voiceprint. Only the voice Lambda can reach the voiceprint bucket. */
  remove: (input: { voiceprintKey: string }) => Promise<void>;
}

export function createLambdaVoiceService(params: {
  lambdaClient: LambdaClient;
  functionName: string;
  // Under API Gateway's 29 s limit, with room for the rest of the request.
  timeoutMs?: number;
}): VoiceService {
  const { lambdaClient, functionName, timeoutMs = 20_000 } = params;

  async function invoke<T>(payload: Record<string, unknown>): Promise<T> {
    const response = await lambdaClient.send(
      new InvokeCommand({
        FunctionName: functionName,
        Payload: new TextEncoder().encode(JSON.stringify(payload)),
      }),
      { abortSignal: AbortSignal.timeout(timeoutMs) },
    );
    const body = response.Payload ? new TextDecoder().decode(response.Payload) : '';
    if (response.FunctionError) {
      throw new Error(`Voice Lambda ${response.FunctionError}: ${body.slice(0, 300)}`);
    }
    return JSON.parse(body) as T;
  }

  return {
    enrol: (input) => invoke<VoiceEnrolResult>({ mode: 'enrol', ...input }),
    verify: (input) => invoke<VoiceVerifyResult>({ mode: 'verify', ...input }),
    remove: async (input) => {
      await invoke({ mode: 'remove', ...input });
    },
  };
}

/** For tests and local dev without the model: every recording matches. */
export function createFakeVoiceService(overrides: Partial<VoiceService> = {}): VoiceService {
  return {
    enrol: () => Promise.resolve({ enrolled: true, speechSeconds: 30, modelRevision: 'fake' }),
    verify: () =>
      Promise.resolve({
        result: 'match',
        score: 0.7,
        speechSeconds: 9,
        threshold: 0.5,
        modelRevision: 'fake',
      }),
    remove: async () => {},
    ...overrides,
  };
}
