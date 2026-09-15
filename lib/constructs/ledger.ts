import { RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/**
 * SSM paths holding the ledger cluster's identity — never the cluster
 * itself, and never a secret value. CDK cannot create this cluster: the
 * account's free plan only permits Aurora clusters created
 * WithExpressConfiguration, which CloudFormation's AWS::RDS::DBCluster has
 * no property for (it exists only as a raw RDS API parameter). So the
 * cluster is provisioned once, out of band, by
 * scripts/create-ledger-cluster.sh — the same pattern this project already
 * uses for the Stripe webhook endpoint and its secret — and referenced here
 * by the SSM paths that script writes to.
 *
 * See docs/adr/0002-data-api-instead-of-vpc.md.
 */
export const LEDGER_SSM_PATHS = {
  clusterArn: '/parity/ledger/cluster-arn',
  secretArn: '/parity/ledger/secret-arn',
  databaseName: '/parity/ledger/database-name',
} as const;

/**
 * The ledger's CDK-managed state: just the S3 archive that makes the ledger
 * rebuildable from Stripe's event stream. The Aurora cluster itself lives
 * outside this stack — see LEDGER_SSM_PATHS above.
 */
export class Ledger extends Construct {
  public readonly archiveBucket: s3.Bucket;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    const stack = Stack.of(this);

    this.archiveBucket = new s3.Bucket(this, 'ArchiveBucket', {
      bucketName: `parity-event-archive-${stack.account}-${stack.region}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
  }
}
