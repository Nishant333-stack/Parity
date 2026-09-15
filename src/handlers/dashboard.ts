import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DASHBOARD_HTML } from '../lib/dashboard-page';
import { getSystemSnapshot } from '../lib/system-snapshot';

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

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  if (event.rawPath === '/api/snapshot') {
    try {
      const snapshot = await getSystemSnapshot();
      return json(200, snapshot);
    } catch (err) {
      console.log(JSON.stringify({ msg: 'snapshot_failed', error: (err as Error).message }));
      return json(500, { error: 'could not gather a system snapshot' });
    }
  }
  return html();
};
