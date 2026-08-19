import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentCard, validateAgentCard, cardFromConfig } from '../src/core/agentcard.js';

test('buildAgentCard produces a valid A2A-shaped card with defaults', () => {
  const card = buildAgentCard({ name: 'A', description: 'D', url: 'http://x', version: '1.2.3' });
  assert.equal(card.protocolVersion, '0.3.0');
  assert.equal(card.name, 'A');
  assert.equal(card.description, 'D');
  assert.equal(card.url, 'http://x');
  assert.equal(card.version, '1.2.3');
  assert.equal(card.capabilities.streaming, false);
  assert.equal(card.capabilities.pushNotifications, false);
  assert.deepEqual(card.defaultInputModes, ['text/plain']);
  assert.deepEqual(card.defaultOutputModes, ['text/plain']);
  assert.deepEqual(card.skills, []);
  // defaults kick in when omitted
  const c2 = buildAgentCard({ name: 'B', description: 'E', url: 'u' });
  assert.equal(c2.version, '0.0.0');
  assert.equal(c2.capabilities.streaming, false);
});

test('buildAgentCard carries capabilities, skills and extensions', () => {
  const card = buildAgentCard({
    name: 'A', description: 'D', url: 'u', version: '1',
    capabilities: { streaming: true },
    skills: [{ id: 'r', name: 'r', description: 'read' }],
    extensions: { 'agenite.governance': { enforcedAtGateway: true } }
  });
  assert.equal(card.capabilities.streaming, true);
  assert.equal(card.skills.length, 1);
  assert.equal(card.skills[0].id, 'r');
  assert.ok(card.extensions['agenite.governance'].enforcedAtGateway);
});

test('validateAgentCard requires the minimum A2A fields', () => {
  const ok = validateAgentCard(buildAgentCard({ name: 'A', description: 'D', url: 'u', version: '1' }));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.errors, []);
  const missing = validateAgentCard({ name: 'A' });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.includes('missing description'));
  assert.ok(missing.errors.includes('missing url'));
  assert.ok(missing.errors.includes('missing version'));
  assert.ok(missing.errors.includes('missing protocolVersion'));
});

test('cardFromConfig derives skills from the tool set and a governance extension', () => {
  const config = {
    name: 'Host',
    version: '9.9.9',
    approvalMode: 'ask',
    guardrails: { denyList: ['rm_rf'], allowList: [], networkCap: -1 }
  };
  const tools = [
    { name: 'read_file', description: 'read' },
    { name: 'run_command', description: 'exec' },
    { name: 'delegate', description: 'spawn a child' }, // orchestration, excluded
    { name: 'fanout', description: 'parallel spawn' }   // orchestration, excluded
  ];
  const card = cardFromConfig(config, { tools });
  assert.equal(card.name, 'Host');
  assert.equal(card.version, '9.9.9');
  const ids = card.skills.map((s) => s.id);
  assert.ok(ids.includes('read_file'));
  assert.ok(ids.includes('run_command'));
  assert.ok(!ids.includes('delegate'));
  assert.ok(!ids.includes('fanout'));
  // governance extension proves the blast-radius gate is enforced at the gateway
  const gov = card.extensions['agenite.governance'];
  assert.ok(gov && gov.enforcedAtGateway === true);
  assert.equal(gov.approvalMode, 'ask');
  assert.deepEqual(gov.denyList, ['rm_rf']);
});

test('cardFromConfig marks a peer (sub-agent) card distinctly', () => {
  const config = { name: 'Host', version: '1.0.0' };
  const tools = [{ name: 'read_file', description: 'read' }];
  const peer = cardFromConfig(config, { tools, name: 'Researcher', isPeer: true });
  assert.ok(peer.name.includes('子代理'));
  assert.ok(peer.name.includes('Researcher'));
  assert.equal(peer.skills[0].id, 'read_file');
});
