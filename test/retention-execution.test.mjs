import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retentionExecutionState } from '../src/codex-home.mjs';

const observation = (change = {}) => Object.entries({
  LoadState: 'loaded', ActiveState: 'inactive', SubState: 'dead', Result: 'success',
  ExecMainStatus: '0', ExecMainExitTimestampMonotonic: '123456789', MainPID: '0', ...change,
}).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';

test('CH-36 receives successful completion and the declared success-with-drift exit separately', () => {
  assert.equal(retentionExecutionState(observation()).state, 'completed');
  assert.equal(retentionExecutionState(observation({ ExecMainStatus: '2' })).current, true);
  assert.equal(retentionExecutionState(observation({ ExecMainStatus: '1' })).current, false);
});

test('CH-36 refuses failed executions even while the independent timer remains enabled', () => {
  for (const change of [
    { ActiveState: 'failed', SubState: 'failed', Result: 'exit-code', ExecMainStatus: '1' },
    { Result: 'timeout' }, { Result: 'signal' }, { Result: 'oom-kill' }, { ActiveState: 'failed' },
  ]) {
    const actual = retentionExecutionState(observation(change));
    assert.equal(actual.current, false);
    assert.equal(actual.state, 'failed');
  }
});

test('CH-36 distinguishes a current process from a completed or never-observed run', () => {
  assert.equal(retentionExecutionState(observation({ ActiveState: 'activating', SubState: 'start', MainPID: '42', ExecMainExitTimestampMonotonic: '0' })).state, 'running');
  assert.equal(retentionExecutionState(observation({ ExecMainExitTimestampMonotonic: '0' })).state, 'unobserved');
  assert.equal(retentionExecutionState(observation({ ActiveState: 'activating', MainPID: '0' })).current, false);
});

test('CH-36 holds missing, malformed, duplicate, oversized and uninstalled observations', () => {
  for (const text of [null, '', 'Result=success', observation({ LoadState: 'not-found' }),
    observation({ ExecMainStatus: 'not-a-status' }), observation({ MainPID: '-1' }),
    observation({ ExecMainExitTimestampMonotonic: '1'.repeat(21) }), observation() + 'Result=success\n',
    observation() + 'Unrequested=value\n', 'x'.repeat(16385),
  ]) assert.equal(retentionExecutionState(text).current, false);
});
