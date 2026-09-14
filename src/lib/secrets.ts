import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

const ssm = new SSMClient({});

/**
 * Cached for the life of the execution environment. Stripe keys rotate
 * rarely, and a cold start is the only time we should pay for an SSM call.
 * Rotating a key therefore requires the functions to cycle — acceptable,
 * and worth remembering when you do rotate one.
 */
const cache = new Map<string, string>();

export async function getSecret(name: string): Promise<string> {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  const result = await ssm.send(
    new GetParameterCommand({ Name: name, WithDecryption: true }),
  );

  const value = result.Parameter?.Value;
  if (!value) {
    throw new Error(
      `SSM parameter "${name}" is missing or empty. Create it with: ` +
        `aws ssm put-parameter --name ${name} --type SecureString --value <value>`,
    );
  }

  cache.set(name, value);
  return value;
}
