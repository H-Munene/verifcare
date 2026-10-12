import * as cdk from "aws-cdk-lib/core";
import * as ec2 from "aws-cdk-lib/aws-ec2";

export function createNetwork(stack: cdk.Stack): ec2.Vpc {
  // Two AZs because RDS subnet groups require them, but everything runs in
  // eu-west-1c. One NAT Gateway; the other AZ routes to it cross-AZ.
  //
  // Named "Vpc2" to force a replacement: adding an AZ in place caused CIDR
  // conflicts on deploy.
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
