import * as path from "path";
import * as cdk from "aws-cdk-lib/core";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as ssm from "aws-cdk-lib/aws-ssm";

export interface WebProps {
  restApi: apigateway.RestApi;
  userPool: cognito.UserPool;
  userPoolClient: cognito.UserPoolClient;
}

// Created by hand before the first deploy (see docs/aws-infra-setup-log.md), not by this stack:
// the key is issued in Google Cloud, not AWS. It's a browser key that ends up in the page anyway;
// what protects it is its HTTP-referrer restriction, so a plain String parameter is enough.
const GOOGLE_MAPS_API_KEY_PARAMETER = "/mzazi-care/web/google-maps-api-key";

// Hosts the supervisor web console (frontend/web): a private S3 bucket that only CloudFront can
// read (Origin Access Control), served over HTTPS on the distribution's *.cloudfront.net domain.
export function createWeb(stack: cdk.Stack, props: WebProps): void {
  // SSE-S3, not KMS like the data buckets in storage.ts: these are the public site's own files,
  // and a KMS key would also need a key policy letting CloudFront decrypt through OAC.
  const webBucket = new s3.Bucket(stack, "WebBucket", {
    encryption: s3.BucketEncryption.S3_MANAGED,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    enforceSSL: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });

  const distribution = new cloudfront.Distribution(stack, "WebDistribution", {
    comment: "Mzazi Care supervisor web console",
    defaultRootObject: "index.html",
    defaultBehavior: {
      origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      // HSTS, nosniff, X-Frame-Options DENY and a strict-origin-when-cross-origin referrer
      // policy, which still sends the origin the Google Maps key's referrer check needs.
      responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
      compress: true,
    },
    // The app uses BrowserRouter, so a deep link or a refresh on e.g. /dependants/<id> asks for a
    // key that doesn't exist in the bucket. Without ListBucket, S3 answers that with 403 (404 if
    // that's ever granted); both serve index.html so the router can take over.
    errorResponses: [403, 404].map((httpStatus) => ({
      httpStatus,
      responseHttpStatus: 200,
      responsePagePath: "/index.html",
      ttl: cdk.Duration.seconds(0),
    })),
    // Price Class 200 adds the Nairobi edge location; Price Class 100 is only North America,
    // Europe and Israel, which would serve Kenyan users from Europe.
    priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
    httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
  });

  new s3deploy.BucketDeployment(stack, "WebDeployment", {
    destinationBucket: webBucket,
    sources: [
      // Built by cdk.json's "build" command before every synth, so this is never stale.
      s3deploy.Source.asset(path.join(__dirname, "../../frontend/web/dist")),
      // Read by frontend/web/src/config.ts at startup. Written at deploy time from the stack's
      // own values, so the hosted app can't point at the wrong API or user pool.
      s3deploy.Source.jsonData("config.json", {
        apiBaseUrl: props.restApi.url,
        userPoolId: props.userPool.userPoolId,
        userPoolClientId: props.userPoolClient.userPoolClientId,
        googleMapsApiKey: ssm.StringParameter.valueForStringParameter(
          stack,
          GOOGLE_MAPS_API_KEY_PARAMETER,
        ),
      }),
    ],
    distribution,
    distributionPaths: ["/*"],
    // ponytail: no-cache on every file, so browsers revalidate (cheap 304s via ETag) and never
    // run an old index.html or config.json. Split into immutable /assets/* plus no-cache
    // index.html/config.json if repeat page loads ever feel slow.
    cacheControl: [s3deploy.CacheControl.noCache()],
    // The dist is ~37 MB (mostly public/geo_data); the 128 MB default is too small to unpack it.
    memoryLimit: 1024,
  });

  new cdk.CfnOutput(stack, "WebUrl", {
    value: `https://${distribution.distributionDomainName}`,
  });
}
