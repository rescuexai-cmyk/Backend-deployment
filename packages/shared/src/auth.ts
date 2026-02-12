import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { logger } from './logger';
import { prisma } from './database';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email?: string;
    phone: string;
    firstName: string;
    lastName?: string;
    isVerified: boolean;
    isActive: boolean;
  };
}

export const authenticate = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ success: false, message: 'Access token required' });
      return;
    }

    const token = authHeader.substring(7);
    const jwtSecret = process.env.JWT_SECRET || 'fallback-secret-key';

    // Mock tokens ONLY allowed in development/test mode
    if ((token.startsWith('mock-driver-token-') || token.startsWith('mock-passenger-token-')) && 
        (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test')) {
      logger.warn('Mock token used - this should only happen in development');
      try {
        if (token.startsWith('mock-driver-token-')) {
          const driver = await prisma.driver.findFirst({
            where: { user: { firstName: 'Priya' } },
            include: { user: true },
          });
          if (driver) {
            req.user = {
              id: driver.user.id,
              email: driver.user.email ?? undefined,
              phone: driver.user.phone,
              firstName: driver.user.firstName,
              lastName: driver.user.lastName ?? undefined,
              isVerified: driver.user.isVerified,
              isActive: driver.user.isActive,
            };
          } else {
            req.user = {
              id: 'mock-driver-id',
              phone: '+91 98765 43210',
              firstName: 'John',
              lastName: 'Driver',
              isVerified: true,
              isActive: true,
            };
          }
        } else {
          const passenger = await prisma.user.findFirst({
            where: { firstName: 'John' },
            orderBy: { id: 'asc' },
          });
          if (passenger) {
            req.user = {
              id: passenger.id,
              email: passenger.email ?? undefined,
              phone: passenger.phone,
              firstName: passenger.firstName,
              lastName: passenger.lastName ?? undefined,
              isVerified: passenger.isVerified,
              isActive: passenger.isActive,
            };
          } else {
            req.user = {
              id: 'mock-passenger-id',
              phone: '+91 98765 43210',
              firstName: 'John',
              lastName: 'Doe',
              isVerified: true,
              isActive: true,
            };
          }
        }
      } catch {
        req.user = {
          id: 'mock-user-id',
          phone: '+91 98765 43210',
          firstName: 'John',
          lastName: 'Doe',
          isVerified: true,
          isActive: true,
        };
      }
      next();
      return;
    }

    const decoded = jwt.verify(token, jwtSecret) as any;
    
    // Fetch actual user data from database for proper authorization
    if (decoded.userId) {
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: {
          id: true,
          email: true,
          phone: true,
          firstName: true,
          lastName: true,
          isVerified: true,
          isActive: true,
        },
      });
      
      if (user) {
        // CRITICAL: Check if user account is active
        if (!user.isActive) {
          res.status(403).json({ success: false, message: 'Account has been deactivated' });
          return;
        }
        req.user = {
          id: user.id,
          email: user.email ?? undefined,
          phone: user.phone,
          firstName: user.firstName,
          lastName: user.lastName ?? undefined,
          isVerified: user.isVerified,
          isActive: user.isActive,
        };
      } else {
        // User not found in DB - token may be stale
        res.status(401).json({ success: false, message: 'User not found' });
        return;
      }
    } else {
      // Fallback for tokens without userId (shouldn't happen with proper tokens)
      req.user = {
        id: decoded.userId || 'unknown',
        email: decoded.email,
        phone: decoded.phone || '',
        firstName: decoded.firstName || 'Unknown',
        lastName: decoded.lastName,
        isVerified: true,
        isActive: true,
      };
    }
    next();
  } catch (err) {
    logger.warn('Invalid JWT token', { error: err instanceof Error ? err.message : 'Unknown' });
    res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
};

export const optionalAuth = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      next();
      return;
    }
    const token = authHeader.substring(7);
    const jwtSecret = process.env.JWT_SECRET || 'fallback-secret-key';
    try {
      const decoded = jwt.verify(token, jwtSecret) as any;
      
      // Fetch actual user data from database if userId is present
      if (decoded.userId) {
        const user = await prisma.user.findUnique({
          where: { id: decoded.userId },
          select: {
            id: true,
            email: true,
            phone: true,
            firstName: true,
            lastName: true,
            isVerified: true,
            isActive: true,
          },
        });
        
        if (user) {
          req.user = {
            id: user.id,
            email: user.email ?? undefined,
            phone: user.phone,
            firstName: user.firstName,
            lastName: user.lastName ?? undefined,
            isVerified: user.isVerified,
            isActive: user.isActive,
          };
        }
      }
    } catch {
      // Token invalid or expired - continue without auth (optional)
    }
    next();
  } catch {
    next();
  }
};

export const authenticateDriver = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ success: false, message: 'Driver access token required' });
      return;
    }
    const token = authHeader.substring(7);
    const jwtSecret = process.env.JWT_SECRET || 'fallback-secret-key';

    // Mock tokens ONLY allowed in development/test mode
    if ((token.startsWith('mock-driver-token-') || token.startsWith('mock-passenger-token-')) &&
        (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test')) {
      logger.warn('Mock token used in authenticateDriver - this should only happen in development');
      try {
        if (token.startsWith('mock-driver-token-')) {
          const driver = await prisma.driver.findFirst({
            where: { user: { firstName: 'Priya' } },
            include: { user: true },
            orderBy: { id: 'asc' },
          });
          if (driver) {
            req.user = {
              id: driver.user.id,
              email: driver.user.email ?? undefined,
              phone: driver.user.phone,
              firstName: driver.user.firstName,
              lastName: driver.user.lastName ?? undefined,
              isVerified: driver.user.isVerified,
              isActive: driver.user.isActive,
            };
          } else {
            req.user = {
              id: 'mock-driver-id',
              phone: '+91 98765 43210',
              firstName: 'John',
              lastName: 'Driver',
              isVerified: true,
              isActive: true,
            };
          }
        } else {
          const passenger = await prisma.user.findFirst({ where: { firstName: 'John' } });
          if (passenger) {
            req.user = {
              id: passenger.id,
              email: passenger.email ?? undefined,
              phone: passenger.phone,
              firstName: passenger.firstName,
              lastName: passenger.lastName ?? undefined,
              isVerified: passenger.isVerified,
              isActive: passenger.isActive,
            };
          } else {
            req.user = {
              id: 'mock-passenger-id',
              phone: '+91 98765 43210',
              firstName: 'John',
              lastName: 'Doe',
              isVerified: true,
              isActive: true,
            };
          }
        }
      } catch {
        req.user = {
          id: 'mock-user-id',
          phone: '+91 98765 43210',
          firstName: 'John',
          lastName: 'Doe',
          isVerified: true,
          isActive: true,
        };
      }
      next();
      return;
    }

    const decoded = jwt.verify(token, jwtSecret) as any;
    
    // Fetch actual user data from database
    const userId = decoded.driverId || decoded.userId;
    if (userId) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          phone: true,
          firstName: true,
          lastName: true,
          isVerified: true,
          isActive: true,
        },
      });
      
      if (user) {
        // CRITICAL: Check if user account is active
        if (!user.isActive) {
          res.status(403).json({ success: false, message: 'Account has been deactivated' });
          return;
        }
        req.user = {
          id: user.id,
          email: user.email ?? undefined,
          phone: user.phone,
          firstName: user.firstName,
          lastName: user.lastName ?? undefined,
          isVerified: user.isVerified,
          isActive: user.isActive,
        };
      } else {
        res.status(401).json({ success: false, message: 'User not found' });
        return;
      }
    } else {
      req.user = {
        id: 'unknown',
        email: decoded.email,
        phone: decoded.phone || '',
        firstName: decoded.firstName || 'Unknown',
        lastName: decoded.lastName,
        isVerified: true,
        isActive: true,
      };
    }
    next();
  } catch (err) {
    logger.warn('Invalid driver JWT token', { error: err instanceof Error ? err.message : 'Unknown' });
    res.status(401).json({ success: false, message: 'Invalid or expired driver token' });
  }
};
