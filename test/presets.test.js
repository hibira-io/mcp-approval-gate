import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, matches } from '../src/policy.js';
import { PRESETS, preset } from '../src/presets.js';
import { parse } from '../src/cli.js';

const d = (p, name, extra = {}) => decide({ name, args: {}, preset: PRESETS[p], ...extra }).gate;

test('patterns: exact, prefix* and *suffix', () => {
  assert.ok(matches(['*_read'], 'pull_request_read'));
  assert.ok(matches(['get_*'], 'get_me'));
  assert.ok(!matches(['*_read'], 'read_more'));
});

test('stripe: reads pass, writes and money movement wait', () => {
  assert.equal(d('stripe', 'stripe_api_read'), false);
  assert.equal(d('stripe', 'get_stripe_account_info'), false);
  assert.equal(d('stripe', 'stripe_api_write'), true);
  assert.equal(d('stripe', 'send_money'), true);
  assert.equal(d('stripe', 'send_stripe_feedback'), true, 'unknown tools still wait');
  assert.equal(PRESETS.stripe.title('stripe_api_write', { method: 'POST', path: '/v1/refunds' }), 'Stripe: POST /v1/refunds');
  assert.equal(PRESETS.stripe.title('send_money', { amount: 500, currency: 'usd' }), 'Stripe: send money 500 USD');
});

test('github: *_read tools pass, merges and pushes wait', () => {
  assert.equal(d('github', 'pull_request_read'), false);
  assert.equal(d('github', 'list_commits'), false);
  assert.equal(d('github', 'merge_pull_request'), true);
  assert.equal(d('github', 'add_issue_comment'), true);
  assert.equal(PRESETS.github.title('merge_pull_request', { owner: 'acme', repo: 'shop', pullNumber: 42 }), 'GitHub: merge pull request acme/shop#42');
});

test('gmail: drafts pass, sending waits with recipient and subject', () => {
  assert.equal(d('gmail', 'create_draft'), false);
  assert.equal(d('gmail', 'search_threads'), false);
  assert.equal(d('gmail', 'send_message'), true);
  assert.equal(d('gmail', 'trash_thread'), true);
  assert.equal(PRESETS.gmail.title('send_message', { to: ['ana@example.com'], subject: 'Your refund' }), 'Gmail: send message to ana@example.com: Your refund');
});

test('shopify: queries pass, mutations and edits wait', () => {
  assert.equal(d('shopify', 'graphql_query'), false);
  assert.equal(d('shopify', 'get-order'), false);
  assert.equal(d('shopify', 'graphql_mutation'), true);
  assert.equal(d('shopify', 'create-discount'), true);
});

test('user --allow and --gate win over the preset; mode all still gates reads', () => {
  assert.equal(d('github', 'add_issue_comment', { allowTools: ['add_issue_comment'] }), false);
  assert.equal(d('stripe', 'stripe_api_read', { gateTools: ['stripe_api_read'] }), true);
  assert.equal(d('stripe', 'stripe_api_read', { mode: 'all' }), true);
});

test('--preset is validated', () => {
  assert.equal(parse(['--preset', 'GitHub', '--', 'x'], {}).preset, PRESETS.github);
  assert.throws(() => parse(['--preset', 'nope', '--', 'x'], {}), /one of stripe, github, gmail, shopify/);
  assert.equal(preset(undefined), undefined);
});
