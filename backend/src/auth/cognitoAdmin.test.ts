import { beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.fn().mockResolvedValue({});

function mockCommand() {
  return vi.fn().mockImplementation(function (this: { input: unknown }, input: unknown) {
    this.input = input;
  });
}

vi.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: vi
    .fn()
    .mockImplementation(function CognitoIdentityProviderClient() {
      return { send };
    }),
  AdminUpdateUserAttributesCommand: mockCommand(),
  AdminCreateUserCommand: mockCommand(),
}));

describe('createCognitoAdmin', () => {
  beforeEach(() => {
    send.mockClear();
    send.mockResolvedValue({});
  });

  it('assignRole calls AdminUpdateUserAttributes with the sub as Username, per AWS docs', async () => {
    const { createCognitoAdmin } = await import('./cognitoAdmin.js');
    const admin = createCognitoAdmin('eu-west-1_901G3wGkr');

    await admin.assignRole('a1b2c3d4-sub', 'family_member');

    expect(send).toHaveBeenCalledTimes(1);
    const call = send.mock.calls[0]?.[0] as { input: unknown };
    expect(call.input).toEqual({
      UserPoolId: 'eu-west-1_901G3wGkr',
      Username: 'a1b2c3d4-sub',
      UserAttributes: [{ Name: 'custom:role', Value: 'family_member' }],
    });
  });

  it('propagates a rejection from the underlying SDK call', async () => {
    send.mockRejectedValueOnce(new Error('UserNotFoundException'));
    const { createCognitoAdmin } = await import('./cognitoAdmin.js');
    const admin = createCognitoAdmin('eu-west-1_901G3wGkr');

    await expect(admin.assignRole('missing-sub', 'caregiver')).rejects.toThrow(
      'UserNotFoundException',
    );
  });

  it('createUser calls AdminCreateUser with email as Username, EMAIL delivery, and no temporary password', async () => {
    send.mockResolvedValueOnce({
      User: {
        Attributes: [
          { Name: 'sub', Value: 'new-sub-123' },
          { Name: 'email', Value: 'new@example.com' },
        ],
      },
    });
    const { createCognitoAdmin } = await import('./cognitoAdmin.js');
    const admin = createCognitoAdmin('eu-west-1_901G3wGkr');

    const sub = await admin.createUser({
      email: 'new@example.com',
      phoneNumber: '+254700000099',
      fullName: 'New Person',
      role: 'family_member',
    });

    expect(sub).toBe('new-sub-123');
    expect(send).toHaveBeenCalledTimes(1);
    const call = send.mock.calls[0]?.[0] as { input: unknown };
    expect(call.input).toEqual({
      UserPoolId: 'eu-west-1_901G3wGkr',
      Username: 'new@example.com',
      UserAttributes: [
        { Name: 'email', Value: 'new@example.com' },
        { Name: 'phone_number', Value: '+254700000099' },
        { Name: 'name', Value: 'New Person' },
        { Name: 'custom:role', Value: 'family_member' },
      ],
      DesiredDeliveryMediums: ['EMAIL'],
    });
  });

  it('createUser throws if the response has no sub attribute', async () => {
    send.mockResolvedValueOnce({ User: { Attributes: [] } });
    const { createCognitoAdmin } = await import('./cognitoAdmin.js');
    const admin = createCognitoAdmin('eu-west-1_901G3wGkr');

    await expect(
      admin.createUser({
        email: 'x@example.com',
        phoneNumber: '+254700000000',
        fullName: 'X',
        role: 'family_member',
      }),
    ).rejects.toThrow('did not include a sub attribute');
  });
});

describe('isCognitoUserNotFoundError', () => {
  it('recognizes a modeled UserNotFoundException by its .name (AWS SDK v3 convention)', async () => {
    const { isCognitoUserNotFoundError } = await import('./cognitoAdmin.js');
    const err = Object.assign(new Error('User does not exist.'), {
      name: 'UserNotFoundException',
    });
    expect(isCognitoUserNotFoundError(err)).toBe(true);
  });

  it('returns false for an unrelated error', async () => {
    const { isCognitoUserNotFoundError } = await import('./cognitoAdmin.js');
    expect(isCognitoUserNotFoundError(new Error('boom'))).toBe(false);
    expect(isCognitoUserNotFoundError(undefined)).toBe(false);
    expect(isCognitoUserNotFoundError('not an error')).toBe(false);
  });
});

describe('isCognitoUserAlreadyExistsError', () => {
  it('recognizes UsernameExistsException and AliasExistsException', async () => {
    const { isCognitoUserAlreadyExistsError } = await import('./cognitoAdmin.js');
    expect(
      isCognitoUserAlreadyExistsError(
        Object.assign(new Error('exists'), { name: 'UsernameExistsException' }),
      ),
    ).toBe(true);
    expect(
      isCognitoUserAlreadyExistsError(
        Object.assign(new Error('alias exists'), { name: 'AliasExistsException' }),
      ),
    ).toBe(true);
  });

  it('returns false for an unrelated error', async () => {
    const { isCognitoUserAlreadyExistsError } = await import('./cognitoAdmin.js');
    expect(isCognitoUserAlreadyExistsError(new Error('boom'))).toBe(false);
    expect(isCognitoUserAlreadyExistsError(undefined)).toBe(false);
  });
});
