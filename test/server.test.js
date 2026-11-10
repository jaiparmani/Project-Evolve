const request = require('supertest');
const app = require('../server');

describe('Server', () => {
  describe('GET /', () => {
    it('responds with a 200 status code', async () => {
      const response = await request(app).get('/');
      expect(response.statusCode).toBe(200);
    });
  });

  describe('GET /health', () => {
    it('responds with a 200 status code and status ok', async () => {
      const response = await request(app).get('/health');
      expect(response.statusCode).toBe(200);
      expect(response.body).toEqual({ status: 'ok' });
    });
  });

  describe('Static assets', () => {
    it('returns 404 for a non-existent static file', async () => {
      const response = await request(app).get('/nonexistent-file.txt');
      expect(response.statusCode).toBe(404);
    });
  });
});
