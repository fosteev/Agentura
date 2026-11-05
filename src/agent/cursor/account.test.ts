import { describe, expect, it } from 'vitest';
import { accountFromAbout, emailFromStatus } from './account';

const ABOUT = [
  'About Cursor CLI',
  'CLI Version         2026.11.05-86047df',
  'Model               Auto',
  'Subscription Tier   Pro Plus',
  'OS                  test-os',
  'User Email          person@example.com',
].join('\n');

describe('accountFromAbout', () => {
  it('берёт почту и тариф, не модель и не версию', () => {
    expect(accountFromAbout(ABOUT)).toEqual({
      email: 'person@example.com',
      subscriptionType: 'Pro Plus',
    });
  });

  it('нет строк или почта без @ — пусто по этим полям', () => {
    expect(accountFromAbout('Model               Auto\n')).toEqual({});
    expect(accountFromAbout('User Email          not-an-email\n')).toEqual({});
    expect(emailFromStatus('✓ Logged in as person@example.com\n')).toBe('person@example.com');
    expect(emailFromStatus('Not logged in\n')).toBeUndefined();
  });
});
