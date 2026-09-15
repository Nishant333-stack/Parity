#!/usr/bin/env bash
#
# One-time (idempotent) setup for GitHub Actions to deploy this stack without
# any stored AWS credentials, and without the CDK bootstrap deploy path:
#
#   1. A GitHub OIDC identity provider.
#   2. parity-github-actions-deploy — the role GitHub Actions assumes via
#      sts:AssumeRoleWithWebIdentity. It can orchestrate a deploy
#      (CloudFormation changeset calls, CDK asset upload, the bootstrap
#      version check) and PassRole into (3) below — nothing more.
#   3. parity-cfn-exec-role — trusted by cloudformation.amazonaws.com, not by
#      GitHub. This is what CloudFormation actually assumes to create/update
#      resources, scoped to exactly what ParityStack manages.
#
# Why two roles instead of the CDK bootstrap's own cfn-exec-role: that role
# carries AdministratorAccess (confirmed on this account — it's the CDK CLI
# default). `cdk deploy` always passes an execution-role ARN to
# CloudFormation regardless of whether the caller could assume the bootstrap
# deploy role itself, so using the bootstrap role here would mean every
# deploy runs with admin rights no matter how tightly (2) is scoped. Splitting
# "who can trigger a deploy" from "what the deploy can touch" is what keeps
# the second one narrow. See deploy.yml, which passes
# `cdk deploy --role-arn <parity-cfn-exec-role ARN>`.
#
# Also: this account's SCP blocks sts:AssumeRole for root (see CLAUDE.md).
# That's a different action from sts:AssumeRoleWithWebIdentity (what GitHub's
# OIDC federation uses) and from iam:PassRole (what handing the exec role to
# CloudFormation needs) — neither of those has shown the same block so far.
#
#   npm run setup-github-oidc
#
# Idempotent: safe to re-run after adding a permission or changing the repo.
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

PROFILE="${PARITY_PROFILE:-parity}"
REGION="${PARITY_REGION:-ap-south-1}"
GH_REPO="${PARITY_GH_REPO:-Nishant333-stack/Parity}"
TRIGGER_ROLE="parity-github-actions-deploy"
EXEC_ROLE="parity-cfn-exec-role"
OIDC_URL="token.actions.githubusercontent.com"

bold=$'\033[1m'; off=$'\033[0m'
step() { printf '\n%s==> %s%s\n' "$bold" "$1" "$off"; }

ACCOUNT_ID="$(aws sts get-caller-identity --profile "$PROFILE" --query Account --output text)"

step "GitHub OIDC identity provider"
PROVIDER_ARN="arn:aws:iam::${ACCOUNT_ID}:oidc-provider/${OIDC_URL}"
if aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$PROVIDER_ARN" \
     --profile "$PROFILE" >/dev/null 2>&1; then
  echo "already exists: $PROVIDER_ARN"
else
  # The API requires a thumbprint even though AWS doesn't actually validate it
  # against the live endpoint for well-known providers like GitHub (it
  # verifies the certificate through its own trusted-CA bundle instead) —
  # computed fresh from the top of the current chain rather than hand-typed
  # from memory, since a wrong-length value is rejected outright.
  THUMBPRINT="$(echo | openssl s_client -servername "$OIDC_URL" -showcerts -connect "${OIDC_URL}:443" 2>/dev/null \
    | python3 -c '
import re, sys
data = sys.stdin.read()
certs = re.findall(r"-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----", data, re.S)
print(certs[-1], end="")
' | openssl x509 -fingerprint -sha1 -noout | sed -E 's/.*Fingerprint=//; s/://g' | tr 'A-F' 'a-f')"
  [[ ${#THUMBPRINT} -eq 40 ]] || { echo "could not compute a valid thumbprint" >&2; exit 1; }

  aws iam create-open-id-connect-provider \
    --url "https://${OIDC_URL}" \
    --client-id-list "sts.amazonaws.com" \
    --thumbprint-list "$THUMBPRINT" \
    --profile "$PROFILE" >/dev/null
  echo "created: $PROVIDER_ARN"
fi

step "Trust policy for $TRIGGER_ROLE (repo: $GH_REPO, any ref/environment)"
# GitHub's OIDC "sub" claim is NOT just "repo:OWNER/REPO:..." — it embeds the
# numeric owner and repository IDs too (a hardening against repo
# renames/transfers reusing a name), e.g.
# "repo:Nishant333-stack@201732096/Parity@1371298543:environment:aws-deploy".
# A trust condition written against the plain-name form never matches and
# fails closed with the same generic "Not authorized to perform
# sts:AssumeRoleWithWebIdentity" AWS returns for an SCP denial —
# indistinguishable without CloudTrail. Confirmed against this account's real
# CloudTrail AssumeRoleWithWebIdentity event, not assumed from docs.
command -v gh >/dev/null || { echo "gh CLI is required to look up the repo's numeric owner/repo IDs" >&2; exit 1; }
GH_OWNER="${GH_REPO%%/*}"
GH_REPO_NAME="${GH_REPO##*/}"
GH_OWNER_ID="$(gh api "repos/${GH_REPO}" --jq '.owner.id')"
GH_REPO_ID="$(gh api "repos/${GH_REPO}" --jq '.id')"
SUB_PATTERN="repo:${GH_OWNER}@${GH_OWNER_ID}/${GH_REPO_NAME}@${GH_REPO_ID}:*"

TRIGGER_TRUST_POLICY="$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "$PROVIDER_ARN" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      "StringLike": { "token.actions.githubusercontent.com:sub": "$SUB_PATTERN" }
    }
  }]
}
JSON
)"

if aws iam get-role --role-name "$TRIGGER_ROLE" --profile "$PROFILE" >/dev/null 2>&1; then
  aws iam update-assume-role-policy --role-name "$TRIGGER_ROLE" \
    --policy-document "$TRIGGER_TRUST_POLICY" --profile "$PROFILE" >/dev/null
  echo "updated trust policy on existing role"
else
  aws iam create-role --role-name "$TRIGGER_ROLE" \
    --assume-role-policy-document "$TRIGGER_TRUST_POLICY" \
    --description "GitHub Actions OIDC trigger for Nishant333-stack/Parity - orchestrates only, PassRoles into $EXEC_ROLE" \
    --profile "$PROFILE" >/dev/null
  echo "created role"
fi
TRIGGER_ROLE_ARN="$(aws iam get-role --role-name "$TRIGGER_ROLE" --profile "$PROFILE" --query Role.Arn --output text)"

step "Trust policy for $EXEC_ROLE (cloudformation.amazonaws.com only)"
EXEC_TRUST_POLICY="$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "cloudformation.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }]
}
JSON
)"

if aws iam get-role --role-name "$EXEC_ROLE" --profile "$PROFILE" >/dev/null 2>&1; then
  aws iam update-assume-role-policy --role-name "$EXEC_ROLE" \
    --policy-document "$EXEC_TRUST_POLICY" --profile "$PROFILE" >/dev/null
  echo "updated trust policy on existing role"
else
  aws iam create-role --role-name "$EXEC_ROLE" \
    --assume-role-policy-document "$EXEC_TRUST_POLICY" \
    --description "CloudFormation execution role for ParityStack - scoped to this stack's resources, not admin" \
    --profile "$PROFILE" >/dev/null
  echo "created role"
fi
EXEC_ROLE_ARN="$(aws iam get-role --role-name "$EXEC_ROLE" --profile "$PROFILE" --query Role.Arn --output text)"

step "Attaching the trigger policy (orchestration only, PassRole into $EXEC_ROLE)"
TRIGGER_POLICY="$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CloudFormationStack",
      "Effect": "Allow",
      "Action": "cloudformation:*",
      "Resource": "arn:aws:cloudformation:${REGION}:${ACCOUNT_ID}:stack/ParityStack/*"
    },
    {
      "Sid": "CloudFormationReadOnly",
      "Effect": "Allow",
      "Action": ["cloudformation:DescribeStacks", "cloudformation:GetTemplate", "cloudformation:ListStacks"],
      "Resource": "*"
    },
    {
      "Sid": "CdkAssetBucket",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:GetBucketLocation", "s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::cdk-hnb659fds-assets-${ACCOUNT_ID}-${REGION}",
        "arn:aws:s3:::cdk-hnb659fds-assets-${ACCOUNT_ID}-${REGION}/*"
      ]
    },
    {
      "Sid": "CdkBootstrapVersionCheck",
      "Effect": "Allow",
      "Action": "ssm:GetParameter",
      "Resource": "arn:aws:ssm:${REGION}:${ACCOUNT_ID}:parameter/cdk-bootstrap/*"
    },
    {
      "Sid": "PassExecRoleToCloudFormation",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "$EXEC_ROLE_ARN",
      "Condition": { "StringEquals": { "iam:PassedToService": "cloudformation.amazonaws.com" } }
    },
    {
      "Sid": "StsIdentity",
      "Effect": "Allow",
      "Action": "sts:GetCallerIdentity",
      "Resource": "*"
    }
  ]
}
JSON
)"
aws iam put-role-policy --role-name "$TRIGGER_ROLE" --policy-name "parity-github-actions-trigger-policy" \
  --policy-document "$TRIGGER_POLICY" --profile "$PROFILE"
echo "policy attached"

# Cleanup: an earlier version of this script attached one broad policy
# directly to $TRIGGER_ROLE under this name before the trigger/exec split.
# Remove it so no stale, wider-than-intended permissions linger.
aws iam delete-role-policy --role-name "$TRIGGER_ROLE" --policy-name "parity-github-actions-deploy-policy" \
  --profile "$PROFILE" 2>/dev/null && echo "removed stale pre-split policy" || true

step "Attaching the execution policy (this stack's actual resources)"
EXEC_POLICY="$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ArchiveBucket",
      "Effect": "Allow",
      "Action": "s3:*",
      "Resource": [
        "arn:aws:s3:::parity-event-archive-*",
        "arn:aws:s3:::parity-event-archive-*/*"
      ]
    },
    {
      "Sid": "Lambda",
      "Effect": "Allow",
      "Action": "lambda:*",
      "Resource": [
        "arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:parity-webhook-ingress",
        "arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:parity-ledger-projector",
        "arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:ParityStack-*"
      ]
    },
    {
      "Sid": "LambdaEventSourceMappings",
      "Effect": "Allow",
      "Action": [
        "lambda:CreateEventSourceMapping", "lambda:DeleteEventSourceMapping",
        "lambda:UpdateEventSourceMapping", "lambda:GetEventSourceMapping", "lambda:ListEventSourceMappings"
      ],
      "Resource": "*"
    },
    {
      "Sid": "DedupeTable",
      "Effect": "Allow",
      "Action": "dynamodb:*",
      "Resource": "arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/parity-event-dedupe"
    },
    {
      "Sid": "Queues",
      "Effect": "Allow",
      "Action": "sqs:*",
      "Resource": [
        "arn:aws:sqs:${REGION}:${ACCOUNT_ID}:parity-events.fifo",
        "arn:aws:sqs:${REGION}:${ACCOUNT_ID}:parity-events-dlq.fifo"
      ]
    },
    {
      "Sid": "ApiGateway",
      "Effect": "Allow",
      "Action": "apigateway:*",
      "Resource": "arn:aws:apigateway:${REGION}::/*"
    },
    {
      "Sid": "LogGroups",
      "Effect": "Allow",
      "Action": "logs:*",
      "Resource": [
        "arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:/aws/lambda/parity-webhook-ingress*",
        "arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:/aws/lambda/parity-ledger-projector*",
        "arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:ParityStack-*"
      ]
    },
    {
      "Sid": "ServiceRolesForThisStack",
      "Effect": "Allow",
      "Action": [
        "iam:CreateRole", "iam:DeleteRole", "iam:GetRole",
        "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:GetRolePolicy",
        "iam:AttachRolePolicy", "iam:DetachRolePolicy",
        "iam:TagRole", "iam:UntagRole",
        "iam:ListRolePolicies", "iam:ListAttachedRolePolicies",
        "iam:PassRole"
      ],
      "Resource": "arn:aws:iam::${ACCOUNT_ID}:role/ParityStack-*"
    },
    {
      "Sid": "CloudFormationSelfDescribe",
      "Effect": "Allow",
      "Action": ["cloudformation:DescribeStacks", "cloudformation:DescribeStackEvents", "cloudformation:GetTemplate"],
      "Resource": "arn:aws:cloudformation:${REGION}:${ACCOUNT_ID}:stack/ParityStack/*"
    }
  ]
}
JSON
)"
aws iam put-role-policy --role-name "$EXEC_ROLE" --policy-name "parity-cfn-exec-policy" \
  --policy-document "$EXEC_POLICY" --profile "$PROFILE"
echo "policy attached"

step "Done"
echo "Trigger role ARN (GitHub assumes this):     $TRIGGER_ROLE_ARN"
echo "Execution role ARN (CloudFormation assumes this): $EXEC_ROLE_ARN"
echo
echo "next: set these as GitHub Actions repo variables —"
echo "  gh variable set AWS_DEPLOY_ROLE_ARN --body \"$TRIGGER_ROLE_ARN\""
echo "  gh variable set AWS_CFN_EXEC_ROLE_ARN --body \"$EXEC_ROLE_ARN\""
echo "  gh variable set AWS_REGION --body \"$REGION\""
