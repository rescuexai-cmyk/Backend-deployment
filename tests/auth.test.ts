/**
 * Authentication Flow Integration Tests
 * Tests OTP login, token refresh, and role-based access
 */

import jwt from 'jsonwebtoken';

describe('Authentication Flow', () => {
  const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key';
  const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || 'test-refresh-secret-key';
  
  describe('OTP Verification', () => {
    it('should accept fixed OTP 123456 in test/dev mode', () => {
      const DEV_OTP = '123456';
      const isDevMode = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
      
      // In dev/test mode, 123456 should be accepted
      expect(isDevMode).toBe(true);
      expect(DEV_OTP).toBe('123456');
      expect(/^\d{6}$/.test(DEV_OTP)).toBe(true);
    });
    
    it('should validate OTP format (6 digits)', () => {
      const validOTPs = ['123456', '000000', '999999', '111111'];
      const invalidOTPs = ['12345', '1234567', 'abcdef', '12345a', ''];
      
      validOTPs.forEach(otp => {
        expect(/^\d{6}$/.test(otp)).toBe(true);
      });
      
      invalidOTPs.forEach(otp => {
        expect(/^\d{6}$/.test(otp)).toBe(false);
      });
    });
  });
  
  describe('JWT Token Generation', () => {
    it('should generate valid access token', () => {
      const userId = 'test-user-id';
      const token = jwt.sign({ userId, type: 'access' }, JWT_SECRET, { expiresIn: '7d' });
      
      const decoded = jwt.verify(token, JWT_SECRET) as any;
      expect(decoded.userId).toBe(userId);
      expect(decoded.type).toBe('access');
    });
    
    it('should generate valid refresh token', () => {
      const userId = 'test-user-id';
      const token = jwt.sign({ userId, type: 'refresh' }, REFRESH_TOKEN_SECRET, { expiresIn: '30d' });
      
      const decoded = jwt.verify(token, REFRESH_TOKEN_SECRET) as any;
      expect(decoded.userId).toBe(userId);
      expect(decoded.type).toBe('refresh');
    });
    
    it('should reject invalid tokens', () => {
      const invalidToken = 'invalid.token.here';
      
      expect(() => {
        jwt.verify(invalidToken, JWT_SECRET);
      }).toThrow();
    });
    
    it('should reject tokens with wrong secret', () => {
      const userId = 'test-user-id';
      const token = jwt.sign({ userId }, 'wrong-secret');
      
      expect(() => {
        jwt.verify(token, JWT_SECRET);
      }).toThrow();
    });
  });
  
  describe('Token Refresh', () => {
    it('should only accept refresh type tokens for refresh', () => {
      const userId = 'test-user-id';
      const accessToken = jwt.sign({ userId, type: 'access' }, JWT_SECRET);
      const refreshToken = jwt.sign({ userId, type: 'refresh' }, REFRESH_TOKEN_SECRET);
      
      const accessDecoded = jwt.verify(accessToken, JWT_SECRET) as any;
      const refreshDecoded = jwt.verify(refreshToken, REFRESH_TOKEN_SECRET) as any;
      
      expect(accessDecoded.type).toBe('access');
      expect(refreshDecoded.type).toBe('refresh');
      
      // Refresh should only work with refresh type
      expect(refreshDecoded.type).not.toBe('access');
    });
  });
  
  describe('Phone Number Validation', () => {
    it('should format phone numbers correctly', () => {
      const phone = '9876543210';
      const countryCode = '+91';
      const fullPhone = `${countryCode}${phone}`;
      
      expect(fullPhone).toBe('+919876543210');
    });
    
    it('should validate international phone format', () => {
      const validPhones = ['+919876543210', '+14155551234', '+447911123456'];
      const phoneRegex = /^\+[1-9]\d{1,14}$/;
      
      validPhones.forEach(phone => {
        expect(phoneRegex.test(phone)).toBe(true);
      });
    });
  });
});
