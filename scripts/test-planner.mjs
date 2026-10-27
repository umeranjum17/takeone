#!/usr/bin/env node
// CI-only in-process make: recorded model response, real analysis and renderer.
import { main } from '../src/cli.ts';
import { recordedPlannerReply } from '../test/helpers.ts';

const args = process.argv.slice(2);
if (args[0] !== 'make' && !(args[0] === 'capture' && args[1] === 'make')) throw Error('test-planner only runs make');
process.exitCode = await main(args, {
  apiKey: 'test-key-000',
  fetchImpl: async (_url, init) => recordedPlannerReply(String(init?.body), process.env.TAKEONE_TEST_FOCUS_FIRST === '1'),
});
