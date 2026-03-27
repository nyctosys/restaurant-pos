/**
 * API client: error handling, request logging, normalized errors.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiError, getUserMessage, isApiError } from '../api/errors';

describe('ApiError', () => {
  it('exposes status and body', () => {
    const err = new ApiError(400, { error: 'Bad Request', message: 'Cart is empty' });
    expect(err.status).toBe(400);
    expect(err.body.message).toBe('Cart is empty');
    expect(err.userMessage).toBe('Cart is empty');
  });

  it('userMessage falls back to error then message', () => {
    const err = new ApiError(404, { error: 'Not Found' });
    expect(err.userMessage).toBe('Not Found');
  });
});

describe('getUserMessage', () => {
  it('returns userMessage for ApiError', () => {
    const err = new ApiError(500, { message: 'Server error' });
    expect(getUserMessage(err)).toBe('Server error');
  });

  it('returns message for Error', () => {
    expect(getUserMessage(new Error('Network failed'))).toBe('Network failed');
  });

  it('returns string for unknown', () => {
    expect(getUserMessage('something')).toBe('something');
    expect(getUserMessage(null)).toBe('An error occurred');
  });
});

describe('isApiError', () => {
  it('returns true for ApiError instance', () => {
    expect(isApiError(new ApiError(400, {}))).toBe(true);
  });

  it('returns false for Error', () => {
    expect(isApiError(new Error('x'))).toBe(false);
  });
});
