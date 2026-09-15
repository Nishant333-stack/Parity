#!/usr/bin/env bash
#
# One-time (idempotent) setup for GitHub Actions to deploy this stack without
# any stored AWS credentials: a GitHub OIDC identity provider, plus an IAM
# role that Actions runs for this repo can assume via
# sts:AssumeRoleWithWebIdentity, scoped to a custom policy covering exactly
# the resources ParityStack manages.
#
# Why a custom role rather than the CDK bootstrap deploy role: this account's
# SCP blocks sts:AssumeRole for root (see CLAUDE.md), and CDK's own fallback
# when it can't assume the bootstrap role is to run CloudFormation directly
# as the calling principal — which is exactly what already happens for local
# deploys. The role this script creates is designed to be that calling
# principal directly, with its own permissions, not a role that itself tries
# to assume anything else.
#
#   npm run setup-github-oidc
#
# Idempotent: safe to re-run after adding a permission or changing the repo.
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

PROFILE="${PARITY_PROFILE:-parity}"
REGION="${PARITY_REGION:-ap-south-1}"
GH_REPO="${PARITY_GH_REPO:-Nishant333-stack/Parity}"
ROLE_NAME="parity-github-actions-deploy"
POLICY_NAME="parity-github-actions-deploy-policy"
OIDC_URL="token.actions.githubusercontent.com"
# GitHub's OIDC thumbprints — AWS no longer validates these against the live
# endpoint for well-known providers, but the API still requires the field.
THUMBPRINTS="6938fd4d98bab03faadb97b34396831e3780aea 1c58a3a8518e8759bf075b76b750d4f2df264fcd"

bold=$'\033[1m'; off=$'\033[0m'
step() { printf '\n%s==> %s%s\n' "$bold" "$1" "$off"; }

ACCOUNT_ID="$(aws sts get-caller-identity --profile "$PROFILE" --query Account --output text)"

step "GitHub OIDC identity provider"
PROVIDER_ARN="arn:aws:iam::${ACCOUNT_ID}:oidc-provider/${OIDC_URL}"
if aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$PROVIDER_ARN" \
     --profile "$PROFILE" >/dev/null 2>&1; then
  echo "already exists: $PROVIDER_ARN"
else
  aws iam create-open-id-connect-provider \
    --url "https://${OIDC_URL}" \
    --client-id-list "sts.amazonaws.com" \
    --thumbprint-list $THUMBPRINTS \
    --profile "$PROFILE" >/dev/null
  echo "created: $PROVIDER_ARN"
fi

step "Trust policy for $ROLE_NAME (repo: $GH_REPO, any ref)"
TRUST_POLICY="$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "$PROVIDER_ARN" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      "StringLike": { "token.actions.githubusercontent.com:sub": "repo:${GH_REPO}:*" }
    }
  }]
}
JSON
)"

if aws iam get-role --role-name "$ROLE_NAME" --profile "$PROFILE" >/dev/null 2>&1; then
  aws iam update-assume-role-policy --role-name "$ROLE_NAME" \
    --policy-document "$TRUST_POLICY" --profile "$PROFILE" >/dev/null
  echo "updated trust policy on existing role"
else
  aws iam create-role --role-name "$ROLE_NAME" \
    --assume-role-policy-document "$TRUST_POLICY" \
    --description "GitHub Actions deploy role for Nishant333-stack/Parity — scoped, not admin" \
    --profile "$PROFILE" >/dev/null
  echo "created role"
fi

ROLE_ARN="$(aws iam get-role --role-name "$ROLE_NAME" --profile "$PROFILE" --query Role.Arn --output text)"

step "Attaching scoped deploy policy (CloudFormation + this stack's own resources — not admin)"
PERMISSIONS_POLICY="$(cat <<JSON
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
      "Sid": "SsmReadForLedgerAndStripeSecrets",
      "Effect": "Allow",
      "Action": "ssm:GetParameter",
      "Resource": [
        "arn:aws:ssm:${REGION}:${ACCOUNT_ID}:parameter/parity/stripe/*",
        "arn:aws:ssm:${REGION}:${ACCOUNT_ID}:parameter/parity/ledger/*"
      ]
    },
    {
      "Sid": "StsAndAccount",
      "Effect": "Allow",
      "Action": ["sts:GetCallerIdentity"],
      "Resource": "*"
    }
  ]
}
JSON
)"

aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name "$POLICY_NAME" \
  --policy-document "$PERMISSIONS_POLICY" --profile "$PROFILE"
echo "policy attached"

step "Done"
echo "Role ARN: $ROLE_ARN"
echo
echo "next: set this as a GitHub Actions repo variable —"
echo "  gh variable set AWS_DEPLOY_ROLE_ARN --body \"$ROLE_ARN\""
echo "  gh variable set AWS_REGION --body \"$REGION\""
