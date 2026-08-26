import { describe, expect, it, beforeEach } from 'vitest';
import { authMiddleware, classifyRoute, loadAuthConfig, resetAuthConfigCache } from '../src/api/auth-middleware.js';
import { Request, Response, NextFunction } from 'express';

describe('auth-middleware', () => {
  beforeEach(() => {
    resetAuthConfigCache();
    delete process.env.OPERATOR_TOKEN;
    delete process.env.OPERATOR_ALLOWLIST;
    delete process.env.HEALTH_DETAILS_TOKEN;
  });

  it('classifies public routes as public', () => {
    expect(classifyRoute('/health')).toBe('public');
    expect(classifyRoute('/listings')).toBe('public');
    expect(classifyRoute('/events')).toBe('public');
  });

  it('classifies wallet routes as authenticated', () => {
    expect(classifyRoute('/wallets/GABC/activity')).toBe('authenticated');
    expect(classifyRoute('/wallets/GABC/royalty-stats')).toBe('authenticated');
  });

  it('classifies operator routes as operator', () => {
    expect(classifyRoute('/admin/contracts')).toBe('operator');
    expect(classifyRoute('/reconciliation/status')).toBe('operator');
    expect(classifyRoute('/backfill/status')).toBe('operator');
    expect(classifyRoute('/keeper/status')).toBe('operator');
    expect(classifyRoute('/sync/gaps')).toBe('operator');
  });

  it('public routes pass without auth', async () => {
    const req = { path: '/health', ip: '1.2.3.4', headers: {}, query: {} } as any;
    const res = {} as Response;
    const next = () => {};
    await authMiddleware('public')(req, res, next as NextFunction);
    // next should have been called
  });

  it('operator routes reject missing token when configured', async () => {
    process.env.OPERATOR_TOKEN = 'secret123';
    const req = {
      path: '/admin/contracts',
      ip: '1.2.3.4',
      headers: {},
      query: {},
      method: 'GET',
    } as any;
    const res = { status: () => res, json: () => res } as any;
    let captured: any;
    const next = (err?: any) => { captured = err; };
    await authMiddleware('operator')(req, res, next as NextFunction);
    expect(captured).toBeDefined();
    expect(captured.statusCode).toBe(401);
  });

  it('operator routes accept valid token', async () => {
    process.env.OPERATOR_TOKEN = 'secret123';
    const req = {
      path: '/admin/contracts',
      ip: '1.2.3.4',
      headers: { 'x-operator-token': 'secret123' },
      query: {},
      method: 'GET',
    } as any;
    const res = {} as Response;
    let called = false;
    const next = () => { called = true; };
    await authMiddleware('operator')(req, res, next as NextFunction);
    expect(called).toBe(true);
  });
});
