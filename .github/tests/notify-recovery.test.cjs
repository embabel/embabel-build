const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');

// Execute the inline script: reusable workflows cannot load scripts from a caller's checkout.
const workflow = readFileSync(`${__dirname}/../workflows/notify-recovery.yml`, 'utf8');
const lines = workflow.split(/\r?\n/);
const start = lines.findIndex(line => line.trim() === 'script: |') + 1;
assert.ok(start > 0, 'Recovery workflow must contain an inline script');
const script = [];
for (const line of lines.slice(start)) {
    if (line.trim() && !line.startsWith('            ')) break;
    script.push(line.slice(12));
}
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const checkRecovery = new AsyncFunction('github', 'context', 'core', 'process', script.join('\n'));

async function recovery({ attempt = 1, attempts = {}, pages = [] } = {}) {
    let output;
    const calls = [];
    const context = { repo: { owner: 'embabel', repo: 'dice' }, runAttempt: attempt };
    const github = {
        rest: { actions: {
            async getWorkflowRunAttempt(params) {
                assert.equal(params.run_id, 39852418292);
                calls.push(params.attempt_number);
                assert.ok(Object.hasOwn(attempts, params.attempt_number));
                return { data: { conclusion: attempts[params.attempt_number] } };
            },
            async getWorkflowRun(params) {
                assert.equal(params.run_id, 39852418292);
                return { data: { workflow_id: 220109056, run_number: 1874 } };
            },
            listWorkflowRuns() {},
        } },
        paginate: { async *iterator(method, params) {
            assert.equal(method, github.rest.actions.listWorkflowRuns);
            assert.deepEqual(params, {
                ...context.repo, workflow_id: 220109056, branch: 'main',
                exclude_pull_requests: true, per_page: 100,
            });
            for (const runs of pages) yield { data: runs };
        } },
    };
    await checkRecovery(github, context, {
        setOutput(name, value) {
            assert.equal(name, 'is-recovery');
            assert.equal(output, undefined, 'Output should be written once');
            output = value;
        },
    }, { env: { CALLER_RUN_ID: '39852418292', BRANCH: 'main' } });
    return { output, calls };
}

const completed = (run_number, conclusion) => ({ run_number, conclusion, status: 'completed' });

test('successful rerun detects the failed attempt of the same run', async () => {
    assert.deepEqual(await recovery({ attempt: 2, attempts: { 1: 'failure' } }), {
        output: 'true', calls: [1],
    });
});

test('cancelled intervening attempts do not hide a failure', async () => {
    assert.deepEqual(await recovery({ attempt: 3, attempts: { 2: 'cancelled', 1: 'failure' } }), {
        output: 'true', calls: [2, 1],
    });
});

test('rerunning a successful attempt does not repeat recovery', async () => {
    assert.deepEqual(await recovery({ attempt: 3, attempts: { 2: 'success', 1: 'failure' } }), {
        output: 'false', calls: [2],
    });
});

test('new build detects recovery from an older failed run', async () => {
    assert.equal((await recovery({ pages: [[completed(1873, 'failure')]] })).output, 'true');
});

test('history lookup skips newer runs, current run, and incomplete runs across pages', async () => {
    const result = await recovery({ pages: [
        [completed(1875, 'success'), completed(1874, 'success'), { run_number: 1873, status: 'in_progress' }],
        [completed(1872, 'failure')],
    ] });
    assert.equal(result.output, 'true');
});

test('ordinary success after success stays silent', async () => {
    const result = await recovery({ pages: [[completed(1873, 'success'), completed(1872, 'failure')]] });
    assert.equal(result.output, 'false');
});

test('first build with no history stays silent', async () => {
    assert.equal((await recovery()).output, 'false');
});
