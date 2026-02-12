/**
 * Jest test setup file
 * Configures the test environment before running tests
 */

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-key';
process.env.REFRESH_TOKEN_SECRET = 'test-refresh-secret-key';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://raahi:raahi_dev_2024@localhost:5432/raahi_test';

// Increase timeout for integration tests
jest.setTimeout(30000);

// Global test utilities
beforeAll(async () => {
  console.log('🧪 Starting test suite...');
});

afterAll(async () => {
  console.log('✅ Test suite completed');
});
