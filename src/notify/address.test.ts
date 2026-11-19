import { expect, test } from 'bun:test';
import {
  checkedAddresses,
  checkWebhookTarget,
  isBlockedAddress,
  isPublicAddress,
} from '@/notify/address.ts';

const refused = [
  '0.0.0.0',
  '0.1.2.3',
  '10.0.0.1',
  '10.255.255.255',
  '100.64.0.1',
  '100.127.255.255',
  '127.0.0.1',
  '127.8.8.8',
  '169.254.169.254',
  '172.16.0.1',
  '172.31.255.255',
  '192.0.0.1',
  '192.0.0.255',
  '192.168.1.1',
  '198.18.0.1',
  '198.19.255.255',
  '192.0.2.0',
  '192.0.2.1',
  '192.0.2.255',
  '198.51.100.1',
  '203.0.113.1',
  '203.0.113.255',
  '224.0.0.1',
  '239.255.255.255',
  '240.0.0.1',
  '255.255.255.255',
  '::',
  '::1',
  'fc00::1',
  'fd12:3456::1',
  'fe80::1',
  'febf::1',
  'ff00::1',
  'ff02::1',
  '::ffff:127.0.0.1',
  '::ffff:7f00:1',
  '::ffff:10.0.0.1',
  '::ffff:a00:1',
  '::ffff:169.254.169.254',
  '::ffff:c0a8:101',
  '::127.0.0.1',
  '64:ff9b::7f00:1',
  '64:ff9b::a00:1',
  '64:ff9b::169.254.169.254',
  '::ffff:0:127.0.0.1',
  '::ffff:0:7f00:1',
  '::ffff:0:10.0.0.1',
  '64:ff9b:1::1',
  '64:ff9b:1::5db8:d822',
  '2002:7f00:1::1',
  '2002:a00:1::',
  '2002:c0a8:101::1',
  '2001::1',
  '2001:0:4136:e378:8000:63bf:3fff:fdd2',
  'fec0::1',
  'feff::1',
  'fe00::1',
  '100::1',
  '2001:db8::1',
  '3fff::1',
];

const allowed = [
  '93.184.216.34',
  '8.8.8.8',
  '100.63.255.255',
  '100.128.0.1',
  '172.15.255.255',
  '172.32.0.1',
  '192.0.1.1',
  '198.17.255.255',
  '198.20.0.1',
  '223.255.255.255',
  '2606:4700:4700::1111',
  '2001:4860:4860::8888',
  '::ffff:93.184.216.34',
  '::ffff:5db8:d822',
  '64:ff9b::5db8:d822',
  '::ffff:0:5db8:d822',
  '2002:5db8:d822::1',
  '2001:1::1',
  '192.0.3.1',
  '198.51.99.255',
  '198.51.101.1',
  '203.0.112.255',
  '203.0.114.1',
  '2001:db9::1',
  '2400:cb00::1',
];

test.each(refused)('%s is not a public address', address => {
  expect(isBlockedAddress(address)).toBe(true);
});

test.each(allowed)('%s is a public address', address => {
  expect(isBlockedAddress(address)).toBe(false);
});

test('a name that is not an address is not blocked by the address check', () => {
  expect(isBlockedAddress('hooks.example.com')).toBe(false);
});

test.each([
  'https://[::ffff:127.0.0.1]/hook',
  'https://[::ffff:7f00:1]/hook',
  'https://[::ffff:10.0.0.1]/hook',
  'https://0x7f.1/hook',
  'https://2130706433/hook',
  'https://017700000001/hook',
  'https://[::1]/hook',
  'https://[ff02::1]/hook',
  'https://169.254.169.254/latest/meta-data',
  'https://198.18.0.1/hook',
])('checkedAddresses refuses the literal address in %s', async raw => {
  await expect(checkedAddresses(new URL(raw), async () => ['93.184.216.34'])).rejects.toThrow(
    'The webhook address is not a public network.'
  );
});

test.each([
  'https://localhost/hook',
  'https://printer.localhost/hook',
  'https://metadata.google.internal/x',
])('checkedAddresses refuses the name in %s', async raw => {
  await expect(checkedAddresses(new URL(raw), async () => ['93.184.216.34'])).rejects.toThrow(
    'The webhook address is not a public network.'
  );
});

test('checkedAddresses refuses http unless the host is loopback', async () => {
  await expect(
    checkedAddresses(new URL('http://hooks.example.com/hook'), async () => ['93.184.216.34'])
  ).rejects.toThrow('The webhook address must use https.');
  await expect(
    checkedAddresses(new URL('http://93.184.216.34/hook'), async () => [])
  ).rejects.toThrow('The webhook address must use https.');
});

test.each([
  ['http://127.0.0.1:8080/hook', '127.0.0.1'],
  ['http://localhost:8080/hook', '127.0.0.1'],
  ['http://[::1]:8080/hook', '::1'],
])('checkedAddresses allows loopback over http: %s', async (raw, address) => {
  expect(await checkedAddresses(new URL(raw), async () => [])).toEqual([address]);
});

test('checkedAddresses returns a public literal without a lookup', async () => {
  let lookups = 0;
  const addresses = await checkedAddresses(new URL('https://93.184.216.34/hook'), async () => {
    lookups += 1;

    return [];
  });

  expect(addresses).toEqual(['93.184.216.34']);
  expect(lookups).toBe(0);
});

test('checkedAddresses resolves a name once and returns every checked address, IPv4 first', async () => {
  let lookups = 0;
  const addresses = await checkedAddresses(
    new URL('https://hooks.example.com/hook'),
    async host => {
      lookups += 1;
      expect(host).toBe('hooks.example.com');

      return ['2606:4700:4700::1111', '93.184.216.34', '2001:4860:4860::8888', '8.8.8.8'];
    }
  );

  expect(addresses).toEqual([
    '93.184.216.34',
    '8.8.8.8',
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
  ]);
  expect(lookups).toBe(1);
});

test.each([
  [['10.0.0.5']],
  [['93.184.216.34', '10.0.0.5']],
  [['::ffff:127.0.0.1']],
  [['2606:4700:4700::1111', 'fe80::1']],
  [['2002:7f00:1::1']],
  [[]],
])('checkedAddresses refuses a name whose answer is %j', async answer => {
  await expect(
    checkedAddresses(new URL('https://hooks.example.com/hook'), async () => answer)
  ).rejects.toThrow('The webhook address is not a public network.');
});

test.each([
  ['a zone id', 'fe80::1%eth0'],
  ['a padded address', ' 127.0.0.1'],
  ['a trailing space', '93.184.216.34 '],
  ['a short form', '127.1'],
  ['a hex form', '0x7f000001'],
  ['a decimal form', '2130706433'],
  ['an octal form', '017700000001'],
  ['a zero-padded octet', '012.0.0.1'],
  ['a zero-padded first octet', '011.0.0.1'],
  ['a name', 'internal.example.com'],
  ['an empty string', ''],
])(
  'checkedAddresses refuses an answer that is %s, next to a public address',
  async (_label, odd) => {
    await expect(
      checkedAddresses(new URL('https://hooks.example.com/hook'), async () => [
        '93.184.216.34',
        odd,
      ])
    ).rejects.toThrow('The webhook address is not a public network.');
  }
);

test.each(['2606:4700:4700::1111', '93.184.216.34', '::ffff:93.184.216.34'])(
  'isPublicAddress accepts %s',
  address => {
    expect(isPublicAddress(address)).toBe(true);
  }
);

test.each(['10.0.0.1', 'fe80::1', 'fe80::1%eth0', '127.1', 'example.com', '', '2002:7f00:1::1'])(
  'isPublicAddress refuses %j',
  address => {
    expect(isPublicAddress(address)).toBe(false);
  }
);

test.each([
  'https://hooks.slack.com/services/T000/B000/XXXX',
  'https://93.184.216.34/hook',
  'http://127.0.0.1:8080/hook',
  'http://localhost:8080/hook',
  'http://[::1]:8080/hook',
])('checkWebhookTarget accepts %s', raw => {
  expect(() => checkWebhookTarget(new URL(raw))).not.toThrow();
});

test.each([
  ['http://hooks.slack.com/services/secret', 'The webhook address must use https.'],
  ['ftp://hooks.example.com/secret', 'The webhook address must use https.'],
  ['javascript:alert(1)', 'The webhook address must use https.'],
  ['https://10.0.0.1/secret', 'The webhook address is not a public network.'],
  ['https://localhost/secret', 'The webhook address is not a public network.'],
  ['https://[::1]/secret', 'The webhook address is not a public network.'],
  ['https://[::ffff:127.0.0.1]/secret', 'The webhook address is not a public network.'],
  ['https://metadata.google.internal/secret', 'The webhook address is not a public network.'],
])('checkWebhookTarget refuses %s without repeating it', (raw, message) => {
  expect(messageOf(() => checkWebhookTarget(new URL(raw)))).toBe(message);
});

function messageOf(work: () => void): string {
  try {
    work();
  } catch (error) {
    return error instanceof Error ? error.message : 'not an error';
  }

  return 'did not throw';
}
