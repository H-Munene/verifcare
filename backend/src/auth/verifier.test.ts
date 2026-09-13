import { describe, expect, it } from 'vitest';
import { extractIdentity, extractUser } from './verifier.js';

describe('extractUser', () => {
  it('extracts sub, role, and email from a valid ID token payload', () => {
    const user = extractUser({
      sub: 'a1b2c3d4-0000-0000-0000-000000000000',
      'custom:role': 'caregiver',
      email: 'caregiver@example.com',
      token_use: 'id',
    });

    expect(user).toEqual({
      sub: 'a1b2c3d4-0000-0000-0000-000000000000',
      role: 'caregiver',
      email: 'caregiver@example.com',
    });
  });

  it('leaves email undefined when absent from the payload', () => {
    const user = extractUser({ sub: 'a1b2c3d4', 'custom:role': 'supervisor' });

    expect(user.email).toBeUndefined();
  });

  for (const role of ['supervisor', 'caregiver', 'family_member']) {
    it(`accepts the "${role}" role`, () => {
      expect(extractUser({ sub: 'a1b2c3d4', 'custom:role': role }).role).toBe(role);
    });
  }

  it('throws when sub is missing', () => {
    expect(() => extractUser({ 'custom:role': 'caregiver' })).toThrow(/sub claim/);
  });

  it('throws when custom:role is missing', () => {
    expect(() => extractUser({ sub: 'a1b2c3d4' })).toThrow(/custom:role/);
  });

  it('throws when custom:role is not one of the known roles', () => {
    expect(() => extractUser({ sub: 'a1b2c3d4', 'custom:role': 'admin' })).toThrow(/custom:role/);
  });

  it('throws when the payload has a role that is present but not yet assigned (undefined role)', () => {
    // extractUser requires a role; extractIdentity does not - this confirms extractUser still
    // rejects a brand-new self-signup's role-less token rather than silently accepting it.
    expect(() => extractUser({ sub: 'a1b2c3d4' })).toThrow(
      /no custom:role claim|missing.*custom:role/,
    );
  });
});

describe('extractIdentity', () => {
  it('extracts sub, role, and email when a role is present', () => {
    const identity = extractIdentity({
      sub: 'a1b2c3d4',
      'custom:role': 'family_member',
      email: 'a@example.com',
    });

    expect(identity).toEqual({ sub: 'a1b2c3d4', role: 'family_member', email: 'a@example.com' });
  });

  it('leaves role undefined for a brand-new self-signup with no custom:role claim at all', () => {
    const identity = extractIdentity({ sub: 'a1b2c3d4' });

    expect(identity).toEqual({ sub: 'a1b2c3d4', role: undefined, email: undefined });
  });

  it('treats an explicit null custom:role the same as absent', () => {
    const identity = extractIdentity({ sub: 'a1b2c3d4', 'custom:role': null });

    expect(identity.role).toBeUndefined();
  });

  it('still throws when sub is missing', () => {
    expect(() => extractIdentity({ 'custom:role': 'caregiver' })).toThrow(/sub claim/);
  });

  it('still throws when custom:role is present but not a known role (tampered token)', () => {
    expect(() => extractIdentity({ sub: 'a1b2c3d4', 'custom:role': 'admin' })).toThrow(
      /custom:role/,
    );
  });
});
