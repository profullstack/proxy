import assert from 'node:assert/strict';
import { test } from 'node:test';
import { render } from '../src/tui.js';

const strip = (text) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

test('tui render: accounts, subscriptions, cursor, country and a test result', () => {
  const soon = new Date(Date.now() + 3 * 86_400_000).toISOString();
  const screen = strip(
    render({
      selected: 1,
      country: 0,
      busy: null,
      test: { provider: 'webshare', ip: '1.2.3.4', country: 'US', city: 'Austin', org: 'AS1 Example', ms: 412 },
      rows: [
        {
          provider: 'proxiware',
          label: 'Proxiware Unlimited Residential',
          configured: true,
          error: null,
          account: {
            credit: 0.07,
            email: 'a@b.c',
            subscriptions: [{ id: 819, kind: 'unlimited', mbps: 25, active: true, autoRenew: true, expiresAt: soon, price: 287.93 }],
          },
        },
        { provider: 'webshare', label: 'Webshare', configured: false, error: 'WEBSHARE_API_KEY not set', account: null },
      ],
    }),
  );
  assert.match(screen, /● Proxiware Unlimited Residential/);
  assert.match(screen, /credit \$0\.07/);
  assert.match(screen, /#819 unlimited 25 Mbps active {2}renews on {2}until \d{4}-\d{2}-\d{2} \(3d\) {2}\$287\.93/);
  assert.match(screen, /› ○ Webshare/, 'cursor on the selected row');
  assert.match(screen, /WEBSHARE_API_KEY not set/);
  assert.match(screen, /country us/);
  assert.match(screen, /exit 1\.2\.3\.4 {2}US Austin {2}AS1 Example {2}via webshare {2}412 ms/);
});
