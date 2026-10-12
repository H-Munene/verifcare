import * as cdk from "aws-cdk-lib/core";
import { Construct } from "constructs";
import { createNetwork } from "./network";
import { createAuth } from "./auth";
import { createDatabase } from "./database";
import { createStorage } from "./storage";
import { createRegistry } from "./registry";
import { createApi } from "./api";
import { createMigrationRunner } from "./migrationRunner";
import { createMissedVisitSweep } from "./missedVisitSweep";
import { createObservability } from "./observability";
import { createCicd } from "./cicd";
import { createWeb } from "./web";

export class MzaziCareStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = createNetwork(this);
    const { userPool, userPoolClient, caregiverAppUserPoolClient, familyMemberAppUserPoolClient } =
      createAuth(this);
    const { database, databaseSecret } = createDatabase(this, vpc);
    const {
      biometricEnrollmentsBucket,
      visitAudioBucket,
      checkinLivenessFramesBucket,
      biometricFacesCollection,
    } = createStorage(this);
    createRegistry(this);

    const { apiFunction, restApi } = createApi(this, {
      vpc,
      database,
      databaseSecret,
      userPool,
      userPoolClient,
      caregiverAppUserPoolClient,
      familyMemberAppUserPoolClient,
      biometricEnrollmentsBucket,
      visitAudioBucket,
      checkinLivenessFramesBucket,
      biometricFacesCollection,
    });

    const { missedVisitSweepFunction } = createMissedVisitSweep(this, {
      vpc,
      database,
      databaseSecret,
    });

    createMigrationRunner(this, { vpc, database, databaseSecret });

    createWeb(this, { restApi, userPool, userPoolClient });

    createObservability(this, {
      apiFunction,
      missedVisitSweepFunction,
      restApi,
      database,
    });

    createCicd(this);
  }
}
