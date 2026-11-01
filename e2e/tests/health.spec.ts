/**
 * `/health` and the `/status` page, against the running stack and the fake
 * model server e2e.sh started.
 *
 * The degraded case removes the embedding model from the fake through its
 * control route, then puts it back: a health check is only proven by watching
 * it fail for the reason it names. Serial, because the other tests here read
 * the healthy state.
 */
import { API_BASE_URL, FAKE_OLLAMA_URL, MODELS, expect, test } from '../fixtures';

test.describe.configure({ mode: 'serial' });

interface HealthBody {
  service: string;
  status: string;
  checks: { name: string; status: string; detail: string | null }[];
}

async function setFakeModels(models: string[]) {
  const response = await fetch(`${FAKE_OLLAMA_URL}/__fake/models`, {
    method: 'PUT',
    body: JSON.stringify({ models }),
  });
  expect(response.status).toBe(200);
}

test('the api checks Postgres, Redis, the model server and both models', async ({ request }) => {
  const response = await request.get(`${API_BASE_URL}/health`);
  expect(response.status()).toBe(200);
  const body = (await response.json()) as HealthBody;
  expect(body.service).toBe('api');
  expect(body.checks.map((c) => `${c.name}:${c.status}`)).toEqual([
    'postgres:ok',
    'redis:ok',
    'ollama:ok',
    'models:ok',
  ]);
});

test('the /status page shows the api up, with every check', async ({ page }) => {
  await page.goto('/status');
  await expect(page.getByTestId('overall')).toHaveText(/Every service is up/u);
  const card = page.locator('[data-service="api"]');
  await expect(card).toContainText('Up');
  for (const check of ['postgres', 'redis', 'ollama', 'models']) {
    await expect(card).toContainText(check);
  }
});

test('a missing model is a 503 that names it, and the status page says so in words', async ({
  page,
  request,
}) => {
  await setFakeModels([MODELS.chat]);
  try {
    const response = await request.get(`${API_BASE_URL}/health`);
    expect(response.status()).toBe(503);
    const body = (await response.json()) as HealthBody;
    const models = body.checks.find((c) => c.name === 'models');
    expect(models?.status).toBe('fail');
    expect(models?.detail).toContain(MODELS.embed);

    await page.goto('/status');
    await expect(page.getByTestId('overall')).toHaveText(/Something is degraded/u);
    await expect(page.locator('[data-service="api"]')).toContainText(MODELS.embed);
  } finally {
    await setFakeModels([MODELS.chat, MODELS.embed]);
  }
  expect((await request.get(`${API_BASE_URL}/health`)).status()).toBe(200);
});
