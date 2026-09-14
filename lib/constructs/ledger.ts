import { RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/**
 * The ledger's durable state: an Aurora Serverless v2 Postgres cluster reached
 * only through the RDS Data API, plus the S3 archive that makes the ledger
 * rebuildable from Stripe's event stream rather than authoritative on its own.
 *
 * See docs/adr/0002-data-api-instead-of-vpc.md for why the projector Lambda
 * never joins the VPC this cluster requires.
 */
export class Ledger extends Construct {
  public readonly cluster: rds.DatabaseCluster;
  public readonly archiveBucket: s3.Bucket;
  public readonly databaseName = 'parity';

  constructor(scope: Construct, id: string) {
    super(scope, id);

    const stack = Stack.of(this);

    // Aurora needs a VPC to exist in, even though nothing in this stack joins
    // it: the Data API reaches the cluster over HTTPS with IAM auth, never
    // through the VPC network path. Isolated subnets only, no NAT gateway and
    // no internet gateway — this cluster has no route to or from the internet.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    this.cluster = new rds.DatabaseCluster(this, 'Cluster', {
      // Pinned, not defaulted. SupportsHttpEndpoint (the Data API) is gated
      // by engine version — 13.9 reports false, 13.23 reports true — and
      // letting CDK resolve "latest" risks landing on a version before the
      // gate flips. 17.10 is confirmed Data-API-capable.
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.of('17.10', '17'),
      }),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      defaultDatabaseName: this.databaseName,
      writer: rds.ClusterInstance.serverlessV2('Writer'),
      // Scales to zero ACUs (auto-pause) when idle rather than the 0.5-ACU
      // floor older engines require — this project's traffic is sparse test
      // events, not sustained load, so paying for an always-on 0.5 ACU would
      // be pure waste against a fixed credit balance.
      serverlessV2MinCapacity: 0,
      serverlessV2MaxCapacity: 1,
      enableDataApi: true,
      storageEncrypted: true,
      // Same reasoning as the dedupe table: this cluster is a projection of
      // Stripe's event stream, rebuildable from the S3 archive below. Nothing
      // here is the copy of record, so nothing here should outlive the stack.
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.archiveBucket = new s3.Bucket(this, 'ArchiveBucket', {
      bucketName: `parity-event-archive-${stack.account}-${stack.region}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
  }
}
