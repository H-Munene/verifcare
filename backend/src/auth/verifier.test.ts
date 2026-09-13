import { describe, expect, it } from 'vitest';
import { extractUser } from './verifier.js';

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
});
