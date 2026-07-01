import { Request, Response, NextFunction } from 'express';
import { logger } from './logger';

export interface AppError extends Error {
  statusCode?: number;
  isOperational?: boolean;
  code?: string;
  meta?: { target?: string[] };
}

export const errorHandler = (
  error: AppError,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  let { statusCode = 500, message } = error;
  let errorCode: string | undefined;

  // Handle standard error types
  if (error.name === 'CrossZoneBlockedError') {
    statusCode = 422;
    errorCode = 'CROSS_ZONE_VEHICLE_BLOCKED';
  }
  if (error.name === 'ValidationError') statusCode = 400;
  if (error.name === 'CastError') statusCode = 400;
  if (error.name === 'JsonWebTokenError') statusCode = 401;
  if (error.name === 'TokenExpiredError') statusCode = 401;
  
  // Handle Prisma errors
  const prismaError = error as any;
  if (prismaError.code === 'P2002') {
    // Unique constraint violation
    statusCode = 409;
    const target = prismaError.meta?.target;
    if (Array.isArray(target) && target.length > 0) {
      message = `A record with this ${target.join(', ')} already exists`;
      errorCode = 'DUPLICATE_ENTRY';
    } else {
      message = 'A record with this value already exists';
      errorCode = 'DUPLICATE_ENTRY';
    }
  } else if (prismaError.code === 'P2025') {
    // Record not found
    statusCode = 404;
    message = 'Record not found';
    errorCode = 'NOT_FOUND';
  } else if (prismaError.code === 'P2003') {
    // Foreign key constraint violation
    statusCode = 400;
    message = 'Related record not found';
    errorCode = 'INVALID_REFERENCE';
  }

  if (process.env.NODE_ENV === 'production' && !error.isOperational && statusCode === 500) {
    message = 'Something went wrong';
  }

  // Log at a severity matching the outcome: server faults (5xx) are real
  // errors; client/operational outcomes (4xx, e.g. permit blocks, validation)
  // are expected and logged as warnings without a noisy stack trace.
  if (statusCode >= 500) {
    logger.error('Error occurred', {
      error: error.message,
      stack: error.stack,
      url: req.url,
      method: req.method,
      code: (error as any).code,
    });
  } else {
    logger.warn('Request rejected', {
      error: error.message,
      status: statusCode,
      url: req.url,
      method: req.method,
      code: errorCode ?? (error as any).code,
    });
  }

  res.status(statusCode).json({
    success: false,
    message,
    ...(errorCode && { code: errorCode }),
    ...(process.env.NODE_ENV === 'development' && { stack: error.stack }),
  });
};

export const asyncHandler = (fn: Function) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

export const notFound = (req: Request, res: Response): void => {
  res.status(404).json({
    success: false,
    message: `Route ${req.originalUrl} not found`,
  });
};
