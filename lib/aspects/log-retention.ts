import { CfnResource, IAspect } from 'aws-cdk-lib';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { IConstruct } from 'constructs';

/**
 * Forces a retention period onto every AWS::Logs::LogGroup in the tree,
 * including the ones CDK creates implicitly for Lambda functions.
 *
 * This deliberately overrides any per-construct setting. For this project
 * that is the point: uncapped retention is a cost leak, and "remember to
 * set it every time" is not a control. If a specific log group ever needs
 * to outlive a week, exempt it here explicitly rather than by omission.
 */
export class LogRetentionAspect implements IAspect {
  constructor(private readonly retention: RetentionDays) {}

  public visit(node: IConstruct): void {
    if (node instanceof CfnResource && node.cfnResourceType === 'AWS::Logs::LogGroup') {
      node.addPropertyOverride('RetentionInDays', this.retention);
    }
  }
}
