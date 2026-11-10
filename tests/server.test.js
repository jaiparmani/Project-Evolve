const request = require('supertest');
const app = require('../server');

describe('Express server', () => {
  it('serves the application shell at the root route with a 200 status', async () => {
    const response = await request(app).get('/');
    expect(response.status).toBe(200);
  });

  it('reports a healthy status from the /health probe', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('returns 404 for an unknown route', async () => {
    const response = await request(app).get('/does-not-exist');
    expect(response.status).toBe(404);
  });
});
