'use strict';

// End-to-end first-run wizard test. Runs two interactive Carry processes on one
// host, answers prompts as a human would, and verifies the automatic first sync.

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const CARRY = path.join(__dirname, '..', 'bin', 'carry.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => {
      const port = server.address().port;
      server.close((err) => err ? reject(err) : resolve(port));
    });
  });
}

function startWizard(cwd, port, answers, onOutput) {
  const child = spawn('node', [CARRY, 'setup', `--link-port=${port}`], {
    cwd,
    env: { ...process.env, CARRY_SKIP_FIREWALL: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  let error = '';
  const sent = new Set();
  const handle = (chunk, isError) => {
    const text = chunk.toString();
    if (isError) error += text;
    else output += text;
    if (onOutput) onOutput(text, output + error);
    for (const answer of answers) {
      if (!sent.has(answer.when) && (output + error).includes(answer.when)) {
        sent.add(answer.when);
        child.stdin.write(answer.value + '\n');
        if (answer.last) child.stdin.end();
      }
    }
  };
  child.stdout.on('data', (chunk) => handle(chunk, false));
  child.stderr.on('data', (chunk) => handle(chunk, true));
  const result = new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      resolve({ code: 'timeout', output, error });
    }, 30000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output, error });
    });
  });
  return { child, result };
}

(async () => {
  const senderRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-setup-send-'));
  const receiverRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-setup-receive-'));
  let sender;
  let receiver;
  try {
    const senderPort = await freePort();
    let receiverPort = await freePort();
    while (receiverPort === senderPort) receiverPort = await freePort();

    fs.writeFileSync(path.join(senderRoot, 'wizard-proof.txt'), 'first sync from wizard');
    fs.mkdirSync(path.join(senderRoot, '.shared-memory'), { recursive: true });
    fs.writeFileSync(path.join(senderRoot, '.shared-memory', 'memory.json'),
      '{"type":"entity","name":"wizard/proof","entityType":"file","observations":["wizard synced memory"]}\n');

    let codeResolve;
    const codeReady = new Promise((resolve) => { codeResolve = resolve; });
    let capturedCode = null;
    sender = startWizard(senderRoot, senderPort, [
      { when: 'Which folder do you want Carry to sync?', value: '1' },
      { when: 'Name this project', value: 'WizardSender' },
      { when: 'What should this machine do?', value: '1', last: true },
    ], (_chunk, all) => {
      const match = all.match(/Your pairing code: ([A-F0-9]{32})/);
      if (match && !capturedCode) {
        capturedCode = match[1];
        codeResolve(capturedCode);
      }
    });

    const code = await Promise.race([
      codeReady,
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('sender did not display a pairing code')), 10000);
        timer.unref();
      }),
    ]);

    receiver = startWizard(receiverRoot, receiverPort, [
      { when: 'Which folder do you want Carry to sync?', value: '1' },
      { when: 'Name this project', value: 'WizardReceiver' },
      { when: 'What should this machine do?', value: '2' },
      { when: 'Paste the 32-character secure code', value: code, last: true },
    ]);

    const [sendResult, receiveResult] = await Promise.all([sender.result, receiver.result]);
    console.log('SENDER OUTPUT\n' + sendResult.output.trim());
    console.log('RECEIVER OUTPUT\n' + receiveResult.output.trim());
    if (sendResult.code !== 0 || receiveResult.code !== 0) {
      throw new Error(`wizard processes failed (sender=${sendResult.code}, receiver=${receiveResult.code})\n${sendResult.error}\n${receiveResult.error}`);
    }
    if (!sendResult.output.includes('Carry setup complete') || !receiveResult.output.includes('Carry setup complete')) {
      throw new Error('wizard did not report successful completion on both machines');
    }

    const proof = fs.readFileSync(path.join(receiverRoot, 'wizard-proof.txt'), 'utf8');
    const memoryText = fs.readFileSync(path.join(receiverRoot, '.shared-memory', 'memory.json'), 'utf8');
    if (proof !== 'first sync from wizard' || !memoryText.includes('wizard synced memory')) {
      throw new Error('automatic first sync did not transfer project file and agent memory');
    }
    console.log('\nWIZARD INTEGRATION PASS: pair + first file/memory sync completed automatically.');
  } finally {
    if (sender && sender.child.exitCode === null) try { sender.child.kill(); } catch { /* ignore */ }
    if (receiver && receiver.child.exitCode === null) try { receiver.child.kill(); } catch { /* ignore */ }
    fs.rmSync(senderRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.rmSync(receiverRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
})().catch((err) => {
  console.error('WIZARD INTEGRATION FAIL:', err);
  process.exitCode = 1;
});
