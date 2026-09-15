import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DASHBOARD_HTML } from '../lib/dashboard-page';
import { ALLOWED_WINDOW_MINUTES, getSystemSnapshot } from '../lib/system-snapshot';

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(body),
  };
}

function html(): APIGatewayProxyResultV2 {
  return {
    statusCode: 200,
    // The shell never changes between deploys; the data inside it does —
    // short-lived caching is fine here and saves a render on every load,
    // where /api/snapshot below explicitly forbids it.
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' },
    body: DASHBOARD_HTML,
  };
}

function parseIntParam(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  if (event.rawPath === '/api/snapshot') {
    try {
      const qs = event.queryStringParameters ?? {};
      const requestedWindow = parseIntParam(qs.window);
      const windowMinutes = (ALLOWED_WINDOW_MINUTES as readonly number[]).includes(requestedWindow ?? -1)
        ? requestedWindow
        : undefined;
      const snapshot = await getSystemSnapshot({
        windowMinutes,
        txnLimit: parseIntParam(qs.limit),
      });
      return json(200, snapshot);
    } catch (err) {
      console.log(JSON.stringify({ msg: 'snapshot_failed', error: (err as Error).message }));
      return json(500, { error: 'could not gather a system snapshot' });
    }
  }
  return html();
};
