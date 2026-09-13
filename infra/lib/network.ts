import * as cdk from "aws-cdk-lib/core";
import * as ec2 from "aws-cdk-lib/aws-ec2";

export function createNetwork(stack: cdk.Stack): ec2.Vpc {
  // RDS DB subnet groups require subnets spanning at least 2 AZs, even for a
  // Single-AZ instance - so the VPC needs a second AZ's subnets to exist,
  // even though actual compute (RDS, later the api/missed-visit-sweep
  // Lambdas) stays pinned to eu-west-1c via an explicit AZ property. Only
  // one NAT Gateway is still created (natGateways: 1) - the second AZ's
  // private subnet routes cross-AZ to it, at a small per-GB data transfer
  // cost, rather than paying for a second NAT Gateway.
  //
  // Construct id deliberately changed from "Vpc" to "Vpc2": adding a second
  // AZ to an already-deployed single-AZ Vpc construct forces CDK to
  // recalculate every subnet's CIDR block, and CloudFormation has no way to
  // sequence "delete the old, now-relocated subnet" before "create the new
  // subnet that wants its freed CIDR" - the two collide as a real, repeatable
  // deploy failure ("CIDR conflicts with another subnet"), not a transient
  // one. Renaming the id forces a clean full replacement (new VPC created
  // fresh with the correct 2-AZ layout, old one deleted after) instead of a
  // doomed in-place patch. Safe here since nothing has ever successfully
  // landed inside this VPC yet - every prior RDS attempt failed and rolled
  // back before anything attached to it.
  return new ec2.Vpc(stack, "Vpc2", {
    ipAddresses: ec2.IpAddresses.cidr("10.0.0.0/16"),
    availabilityZones: ["eu-west-1c", "eu-west-1a"],
    natGateways: 1,
    subnetConfiguration: [
      { name: "Public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
      {
        name: "Private",
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        cidrMask: 24,
      },
    ],
  });
}
