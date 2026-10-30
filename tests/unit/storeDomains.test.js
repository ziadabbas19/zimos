'use strict';

const { domainState, summarize, shownDomain, byStore } = require('../../src/modules/domains/storeDomains');

// The console's store list (domains/storeDomains): which of a store's own
// domains it shows beside the platform subdomain, and in which state.
const domain = (overrides = {}) => ({
  workspaceId: 'ws-1',
  hostname: 'www.shop-example.com',
  status: 'active',
  sslStatus: 'issued',
  isPrimary: true,
  suspendedAt: null,
  createdAt: new Date('2026-10-01T10:00:00Z'),
  ...overrides,
});

describe('storeDomains', () => {
  it('shows nothing for a store without a domain of its own', () => {
    expect(byStore([]).get('ws-1')).toBeUndefined();
    expect(byStore(undefined).size).toBe(0);
  });

  it('calls a verified domain with its certificate issued connected', () => {
    expect(domainState(domain())).toBe('connected');
    expect(domainState(domain({ status: 'verified' }))).toBe('connected');
    // Not primary: still served on its own host, so still connected.
    expect(domainState(domain({ isPrimary: false }))).toBe('connected');
    expect(byStore([domain()]).get('ws-1')).toEqual({
      domain: { hostname: 'www.shop-example.com', status: 'active', sslStatus: 'issued', primary: true, suspended: false, state: 'connected' },
      count: 1,
    });
  });

  it('calls a domain pending until DNS is verified and its certificate issued', () => {
    expect(domainState(domain({ status: 'pending_verification', sslStatus: 'none' }))).toBe('pending');
    expect(domainState(domain({ status: 'verified', sslStatus: 'none' }))).toBe('pending');
    expect(domainState(domain({ status: 'verified', sslStatus: 'pending' }))).toBe('pending');
    expect(byStore([domain({ status: 'pending_verification', sslStatus: 'none', isPrimary: false })]).get('ws-1').domain).toMatchObject({
      state: 'pending',
      primary: false,
    });
  });

  it('calls a failed, moved or suspended domain a problem', () => {
    expect(domainState(domain({ status: 'failed', sslStatus: 'none' }))).toBe('problem');
    expect(domainState(domain({ status: 'verified', sslStatus: 'failed' }))).toBe('problem');
    expect(domainState(domain({ sslStatus: 'moved' }))).toBe('problem');
    expect(domainState(domain({ suspendedAt: new Date() }))).toBe('problem');
    expect(summarize(domain({ suspendedAt: new Date() }))).toMatchObject({ suspended: true, state: 'problem' });
  });

  it('never passes on the verification token or the provider reference', () => {
    const row = domain({ verificationToken: 'secret-token', sslProviderRef: 'cf-123', sslDetail: 'x' });
    expect(Object.keys(summarize(row)).sort()).toEqual(['hostname', 'primary', 'sslStatus', 'state', 'status', 'suspended']);
  });

  it('shows the primary domain first, then the healthiest, then the newest, and counts them all', () => {
    const older = domain({ hostname: 'old.example.com', isPrimary: false, createdAt: new Date('2026-09-01') });
    const newer = domain({ hostname: 'new.example.com', isPrimary: false, createdAt: new Date('2026-10-20') });
    const failing = domain({ hostname: 'bad.example.com', isPrimary: false, status: 'failed', createdAt: new Date('2026-10-30') });
    const primary = domain({ hostname: 'main.example.com', status: 'pending_verification', sslStatus: 'none', createdAt: new Date('2026-08-01') });

    expect(shownDomain([older, newer, failing]).hostname).toBe('new.example.com');
    expect(shownDomain([older, failing, primary, newer]).hostname).toBe('main.example.com');
    expect(shownDomain([])).toBeNull();

    const map = byStore([older, failing, { ...newer, workspaceId: 'ws-2' }]);
    expect(map.get('ws-1')).toMatchObject({ domain: { hostname: 'old.example.com' }, count: 2 });
    expect(map.get('ws-2')).toMatchObject({ domain: { hostname: 'new.example.com' }, count: 1 });
  });
});
