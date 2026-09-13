import { beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.fn().mockResolvedValue({});

vi.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: vi
    .fn()
    .mockImplementation(function CognitoIdentityProviderClient() {
      return { send };
    }),
  AdminUpdateUserAttributesCommand: vi
    .fn()
    .mockImplementation(function AdminUpdateUserAttributesCommand(
      this: { input: unknown },
      input: unknown,
    ) {
      this.input = input;
    }),
}));

describe('createCognitoAdmin', () => {
  beforeEach(() => {
    send.mockClear();
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
});
