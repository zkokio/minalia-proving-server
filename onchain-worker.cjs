// Child process worker — runs in isolation so Snarky state doesn't conflict
// with the main ZkProgram process. Called via child_process.fork()

const { recordVerificationOnChain } = require('./MinaliaVerifier.cjs');

process.on('message', async (msg) => {
  try {
    const result = await recordVerificationOnChain(msg);
    process.send({ ok: true, result });
  } catch (e) {
    process.send({ ok: false, error: e.message });
  } finally {
    process.exit(0);
  }
});
